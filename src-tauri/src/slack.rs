// Slack listener supervisor.
//
// Pairs with `scripts/openit-plugin/scripts/slack-listen.src.mjs`
// (bundled to `slack-listen.bundle.cjs` by `npm run build:slack-listener`).
// Owns the listener's lifecycle from the Tauri side: validates
// tokens against Slack, persists them in keychain + a non-secret
// pointer file, spawns the bundled Node process with the right env
// vars, parses heartbeat lines off stderr so the UI can show
// "Slack: connected" with sessions / ticket counts.
//
// Design choices:
//
//  - Node listener, not in-process Rust. The Slack SDK ecosystem in
//    Node is the canonical surface; bundled-CJS keeps the listener
//    drop-in for users who run `claude` in a terminal.
//
//  - Supervisor knows nothing Slack-protocol-specific beyond the
//    handful of REST calls used for connect-validation and the
//    one-shot intro DM (auth.test, users.lookupByEmail,
//    chat.postMessage). The websocket lives in the Node process.
//
//  - Heartbeats are JSON lines on stderr. The supervisor parses
//    them into `LiveStatus` so the UI doesn't need to know the
//    listener's protocol.

use parking_lot::Mutex as PMutex;
use reqwest::Client as HttpClient;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager, Runtime};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command as TokioCommand};
use tokio::sync::{oneshot, Mutex as TokioMutex};
use tokio::task::JoinHandle;
use tokio::time::timeout;

// ---------------------------------------------------------------------------
// Constants — keychain slots, file paths, env-var names, timeouts.
// ---------------------------------------------------------------------------

/// Keychain service id matches the rest of the app
/// (`keychain.rs::SERVICE`). Slot names below are scoped per
/// orgId so two projects with different Pinkfish orgs don't share
/// tokens. Empty `org_id` (cloud not connected) maps to a
/// `local` qualifier so the slot is still well-formed.
const KEYCHAIN_SERVICE: &str = "ai.pinkfish.openit";
const KC_SLOT_BOT_PREFIX: &str = "slack:bot-token:";
const KC_SLOT_APP_PREFIX: &str = "slack:app-token:";

/// Non-secret pointer file written into the project. Contains
/// workspace metadata so the FE knows what's connected without
/// reading from keychain.
const SLACK_CONFIG_REL: &str = ".openit/slack.json";

/// Where the bundled listener artifact lands once `entity_write_file`
/// has fanned out the plugin manifest. The supervisor first looks
/// here; if missing (e.g. the user nuked .claude/), falls back to
/// the resource baked into the .app bundle.
const LISTENER_REPO_REL: &str = ".claude/scripts/slack-listen.bundle.cjs";
const LISTENER_RESOURCE_REL: &str = "openit-plugin/scripts/slack-listen.bundle.cjs";

const SLACK_API_BASE: &str = "https://slack.com/api";
const HTTP_TIMEOUT_SECS: u64 = 15;
const LISTENER_READY_TIMEOUT_SECS: u64 = 10;
const LISTENER_STOP_GRACE_SECS: u64 = 5;

fn bot_token_slot(org_id: &str) -> String {
    format!(
        "{}{}",
        KC_SLOT_BOT_PREFIX,
        if org_id.is_empty() { "local" } else { org_id }
    )
}

fn app_token_slot(org_id: &str) -> String {
    format!(
        "{}{}",
        KC_SLOT_APP_PREFIX,
        if org_id.is_empty() { "local" } else { org_id }
    )
}

// ---------------------------------------------------------------------------
// On-disk pointer file + keychain helpers
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SlackConfig {
    pub workspace_id: String,
    pub workspace_name: String,
    pub bot_user_id: String,
    pub bot_name: String,
    pub connected_at: String,
    /// Reserved for an opt-in tightening — empty in V1 means "allow
    /// all in-workspace humans" (guests + externals + bots are
    /// always blocked regardless).
    #[serde(default)]
    pub allowed_domains: Vec<String>,
}

fn slack_config_path(repo: &Path) -> PathBuf {
    repo.join(SLACK_CONFIG_REL)
}

async fn read_slack_config(repo: &Path) -> Result<Option<SlackConfig>, String> {
    let path = slack_config_path(repo);
    let raw = match tokio::fs::read_to_string(&path).await {
        Ok(s) => s,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("read slack config: {}", err)),
    };
    serde_json::from_str(&raw)
        .map(Some)
        .map_err(|err| format!("parse slack config: {}", err))
}

async fn write_slack_config(repo: &Path, cfg: &SlackConfig) -> Result<(), String> {
    let dir = repo.join(".openit");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("mkdir .openit: {}", e))?;
    let path = slack_config_path(repo);
    let body =
        serde_json::to_string_pretty(cfg).map_err(|e| format!("serialize slack config: {}", e))?;
    tokio::fs::write(&path, body)
        .await
        .map_err(|e| format!("write slack config: {}", e))
}

fn keychain_set_blocking(slot: &str, value: &str) -> Result<(), String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, slot)
        .map_err(|e| e.to_string())?
        .set_password(value)
        .map_err(|e| e.to_string())
}

fn keychain_get_blocking(slot: &str) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, slot).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

fn keychain_delete_blocking(slot: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, slot).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}

// ---------------------------------------------------------------------------
// Slack REST helpers — auth.test, users.lookupByEmail, chat.postMessage.
//
// Just enough to connect-validate and send the one-shot intro DM.
// The websocket and event handling live in the Node listener.
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct AuthTestResp {
    ok: bool,
    error: Option<String>,
    team_id: Option<String>,
    team: Option<String>,
    user_id: Option<String>,
    user: Option<String>,
}

async fn slack_auth_test(http: &HttpClient, bot_token: &str) -> Result<AuthTestResp, String> {
    let resp = http
        .post(format!("{}/auth.test", SLACK_API_BASE))
        .bearer_auth(bot_token)
        .send()
        .await
        .map_err(|e| format!("Slack auth.test request failed: {}", e))?;
    let body: AuthTestResp = resp
        .json()
        .await
        .map_err(|e| format!("Slack auth.test parse failed: {}", e))?;
    Ok(body)
}

#[derive(Deserialize)]
struct LookupByEmailResp {
    ok: bool,
    error: Option<String>,
    user: Option<LookupUser>,
}

#[derive(Deserialize)]
struct LookupUser {
    id: String,
}

async fn slack_lookup_user_id(
    http: &HttpClient,
    bot_token: &str,
    email: &str,
) -> Result<String, String> {
    let resp = http
        .post(format!("{}/users.lookupByEmail", SLACK_API_BASE))
        .bearer_auth(bot_token)
        .form(&[("email", email)])
        .send()
        .await
        .map_err(|e| format!("Slack users.lookupByEmail request failed: {}", e))?;
    let body: LookupByEmailResp = resp
        .json()
        .await
        .map_err(|e| format!("Slack users.lookupByEmail parse failed: {}", e))?;
    if !body.ok {
        return Err(body
            .error
            .unwrap_or_else(|| "users.lookupByEmail failed".into()));
    }
    body.user
        .map(|u| u.id)
        .ok_or_else(|| "users.lookupByEmail returned no user".into())
}

#[derive(Deserialize)]
struct PostMessageResp {
    ok: bool,
    error: Option<String>,
}

async fn slack_post_message(
    http: &HttpClient,
    bot_token: &str,
    channel: &str,
    text: &str,
) -> Result<(), String> {
    let resp = http
        .post(format!("{}/chat.postMessage", SLACK_API_BASE))
        .bearer_auth(bot_token)
        .json(&serde_json::json!({ "channel": channel, "text": text }))
        .send()
        .await
        .map_err(|e| format!("Slack chat.postMessage request failed: {}", e))?;
    let body: PostMessageResp = resp
        .json()
        .await
        .map_err(|e| format!("Slack chat.postMessage parse failed: {}", e))?;
    if !body.ok {
        return Err(body.error.unwrap_or_else(|| "chat.postMessage failed".into()));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Live supervisor state
// ---------------------------------------------------------------------------

#[derive(Default, Clone, Serialize, Deserialize)]
pub struct HeartbeatPayload {
    pub ts: String,
    pub sessions: u32,
    pub open_tickets: u32,
    pub queue_depth: u32,
    pub workers: u32,
}

#[derive(Default)]
pub struct SlackSupervisorState {
    inner: PMutex<Option<RunningListener>>,
    /// Async-aware lock around the whole start/stop lifecycle so a
    /// concurrent `slack_listener_start` can't race with a `_stop`.
    /// Same shape `IntakeState` uses.
    cmd_lock: TokioMutex<()>,
}

struct RunningListener {
    child: Child,
    workspace_id: String,
    workspace_name: String,
    bot_user_id: String,
    bot_name: String,
    /// Bot token cached here so `slack_listener_send_intro` doesn't
    /// have to round-trip to the keychain (and so it works even if
    /// the keychain hasn't been touched in this session).
    bot_token: String,
    last_heartbeat: Arc<PMutex<Option<HeartbeatPayload>>>,
    last_error: Arc<PMutex<Option<String>>>,
    /// Background task draining the listener's stderr. Aborted on
    /// stop.
    log_task: Option<JoinHandle<()>>,
}

#[derive(Serialize)]
pub struct SlackStatus {
    pub running: bool,
    pub workspace_id: Option<String>,
    pub workspace_name: Option<String>,
    pub bot_user_id: Option<String>,
    pub bot_name: Option<String>,
    pub last_heartbeat: Option<HeartbeatPayload>,
    pub last_error: Option<String>,
}

// ---------------------------------------------------------------------------
// Tauri commands — connect / disconnect / start / stop / status / intro.
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct SlackConnectMeta {
    pub workspace_id: String,
    pub workspace_name: String,
    pub bot_user_id: String,
    pub bot_name: String,
    pub connected_at: String,
}

/// Validate the supplied bot token against Slack, persist both
/// tokens to keychain, and write the non-secret `.openit/slack.json`
/// pointer file. Returns the workspace metadata so the FE can show
/// "Connected to Acme as @OpenIT" without a follow-up call.
///
/// We deliberately do *not* validate the app token here: Slack only
/// accepts `xapp-` tokens against `apps.connections.open`, which
/// opens a websocket — too heavyweight for a connect-time probe.
/// A bad app token surfaces immediately at listener-start time when
/// the SocketModeClient fails to handshake.
#[tauri::command]
pub async fn slack_connect(
    repo: String,
    bot_token: String,
    app_token: String,
    org_id: String,
) -> Result<SlackConnectMeta, String> {
    let repo_path = PathBuf::from(&repo);
    if !repo_path.is_dir() {
        return Err(format!("slack_connect: not a directory: {}", repo));
    }
    let bot_token = bot_token.trim().to_string();
    let app_token = app_token.trim().to_string();
    if !bot_token.starts_with("xoxb-") {
        return Err("bot token must start with 'xoxb-'".into());
    }
    if !app_token.starts_with("xapp-") {
        return Err("app token must start with 'xapp-'".into());
    }

    let http = HttpClient::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("http client: {}", e))?;
    let auth = slack_auth_test(&http, &bot_token).await?;
    if !auth.ok {
        return Err(auth
            .error
            .unwrap_or_else(|| "auth.test failed (no error message)".into()));
    }
    let workspace_id = auth.team_id.ok_or("auth.test missing team_id")?;
    let workspace_name = auth.team.unwrap_or_else(|| "<unknown>".to_string());
    let bot_user_id = auth.user_id.ok_or("auth.test missing user_id")?;
    let bot_name = auth.user.unwrap_or_else(|| "OpenIT".to_string());

    // Write keychain on a blocking task — the keyring crate is
    // blocking. Doing this on the async runtime would stall it.
    let bot_slot = bot_token_slot(&org_id);
    let app_slot = app_token_slot(&org_id);
    let bot_for_kc = bot_token.clone();
    let app_for_kc = app_token.clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        keychain_set_blocking(&bot_slot, &bot_for_kc)?;
        keychain_set_blocking(&app_slot, &app_for_kc)?;
        Ok(())
    })
    .await
    .map_err(|e| format!("keychain task join: {}", e))??;

    let connected_at = now_iso();
    let cfg = SlackConfig {
        workspace_id: workspace_id.clone(),
        workspace_name: workspace_name.clone(),
        bot_user_id: bot_user_id.clone(),
        bot_name: bot_name.clone(),
        connected_at: connected_at.clone(),
        allowed_domains: Vec::new(),
    };
    write_slack_config(&repo_path, &cfg).await?;

    Ok(SlackConnectMeta {
        workspace_id,
        workspace_name,
        bot_user_id,
        bot_name,
        connected_at,
    })
}

/// Tear down: stop the listener if running, scrub keychain entries
/// for this org, delete the pointer file. Idempotent — safe to call
/// when nothing's connected.
#[tauri::command]
pub async fn slack_disconnect(
    state: tauri::State<'_, SlackSupervisorState>,
    repo: String,
    org_id: String,
) -> Result<(), String> {
    let _cmd_guard = state.cmd_lock.lock().await;
    stop_inner(&state).await;

    let bot_slot = bot_token_slot(&org_id);
    let app_slot = app_token_slot(&org_id);
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        keychain_delete_blocking(&bot_slot)?;
        keychain_delete_blocking(&app_slot)?;
        Ok(())
    })
    .await
    .map_err(|e| format!("keychain task join: {}", e))??;

    let path = slack_config_path(&PathBuf::from(repo));
    match tokio::fs::remove_file(&path).await {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(format!("delete slack config: {}", err)),
    }
    Ok(())
}

/// Read the public-facing config file (no secrets). FE uses this on
/// project bootstrap to decide whether to auto-start the listener.
#[tauri::command]
pub async fn slack_config_read(repo: String) -> Result<Option<SlackConfig>, String> {
    read_slack_config(&PathBuf::from(repo)).await
}

#[tauri::command]
pub async fn slack_listener_start<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, SlackSupervisorState>,
    repo: String,
    intake_url: String,
    org_id: String,
) -> Result<(), String> {
    let repo_path = PathBuf::from(&repo);
    let _cmd_guard = state.cmd_lock.lock().await;

    // Idempotent: if already running, no-op.
    if state.inner.lock().is_some() {
        return Ok(());
    }

    let cfg = read_slack_config(&repo_path)
        .await?
        .ok_or_else(|| "slack not configured for this project".to_string())?;

    // Pull tokens from keychain on a blocking task.
    let bot_slot = bot_token_slot(&org_id);
    let app_slot = app_token_slot(&org_id);
    let (bot_token, app_token) = tokio::task::spawn_blocking(
        move || -> Result<(Option<String>, Option<String>), String> {
            Ok((
                keychain_get_blocking(&bot_slot)?,
                keychain_get_blocking(&app_slot)?,
            ))
        },
    )
    .await
    .map_err(|e| format!("keychain task join: {}", e))??;
    let bot_token = bot_token.ok_or("bot token missing from keychain — reconnect Slack")?;
    let app_token = app_token.ok_or("app token missing from keychain — reconnect Slack")?;

    let bundle_path = resolve_listener_bundle(&app, &repo_path)?;

    let mut child = TokioCommand::new("node")
        .arg(&bundle_path)
        .env("OPENIT_REPO", &repo)
        .env("OPENIT_INTAKE_URL", &intake_url)
        .env("OPENIT_SLACK_BOT_TOKEN", &bot_token)
        .env("OPENIT_SLACK_APP_TOKEN", &app_token)
        .env("OPENIT_SLACK_WORKSPACE_ID", &cfg.workspace_id)
        .env("OPENIT_SLACK_BOT_USER_ID", &cfg.bot_user_id)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("spawn node: {} — {}", bundle_path.display(), e))?;

    let stderr = child
        .stderr
        .take()
        .ok_or("listener stderr unavailable after spawn")?;

    // Wait for the listener to log "socket-mode connected" before
    // returning success. Heartbeat / error parsing continues in the
    // same task once we've moved past the ready signal.
    let last_heartbeat: Arc<PMutex<Option<HeartbeatPayload>>> = Arc::new(PMutex::new(None));
    let last_error: Arc<PMutex<Option<String>>> = Arc::new(PMutex::new(None));
    let (ready_tx, ready_rx) = oneshot::channel::<Result<(), String>>();

    let hb_handle = last_heartbeat.clone();
    let err_handle = last_error.clone();
    let log_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        let mut ready_tx = Some(ready_tx);
        while let Ok(Some(line)) = reader.next_line().await {
            // Try heartbeat first — JSON line starting with `{`.
            if line.trim_start().starts_with('{') {
                if let Ok(parsed) = serde_json::from_str::<HeartbeatPayload>(&line) {
                    *hb_handle.lock() = Some(parsed);
                    continue;
                }
            }
            // Ready signal: log line emitted exactly once on connect.
            if line.contains("socket-mode connected") {
                if let Some(tx) = ready_tx.take() {
                    let _ = tx.send(Ok(()));
                }
                eprintln!("[slack] listener: {}", line);
                continue;
            }
            // Anything else: surface as last_error if it looks like
            // a listener-emitted log line (the listener prefixes its
            // diagnostics with `[slack-listen]`); otherwise just
            // forward to our stderr.
            if line.contains("[slack-listen]") {
                *err_handle.lock() = Some(line.clone());
            }
            eprintln!("[slack] listener: {}", line);
        }
        // Stream closed — child likely exited. If we never signaled
        // ready, propagate that.
        if let Some(tx) = ready_tx.take() {
            let _ = tx.send(Err(
                "listener exited before reporting ready (check stderr)".into()
            ));
        }
    });

    let ready = match timeout(
        Duration::from_secs(LISTENER_READY_TIMEOUT_SECS),
        ready_rx,
    )
    .await
    {
        Ok(Ok(Ok(()))) => Ok(()),
        Ok(Ok(Err(msg))) => Err(msg),
        Ok(Err(_)) => Err("listener log task dropped before ready".to_string()),
        Err(_) => Err(format!(
            "listener did not report ready within {}s",
            LISTENER_READY_TIMEOUT_SECS
        )),
    };
    if let Err(msg) = ready {
        // Failed to come up — kill the child, drop the log task,
        // surface the error.
        log_task.abort();
        let _ = child.kill().await;
        return Err(msg);
    }

    let running = RunningListener {
        child,
        workspace_id: cfg.workspace_id,
        workspace_name: cfg.workspace_name,
        bot_user_id: cfg.bot_user_id,
        bot_name: cfg.bot_name,
        bot_token,
        last_heartbeat,
        last_error,
        log_task: Some(log_task),
    };
    *state.inner.lock() = Some(running);
    Ok(())
}

#[tauri::command]
pub async fn slack_listener_stop(
    state: tauri::State<'_, SlackSupervisorState>,
) -> Result<(), String> {
    let _cmd_guard = state.cmd_lock.lock().await;
    stop_inner(&state).await;
    Ok(())
}

async fn stop_inner(state: &tauri::State<'_, SlackSupervisorState>) {
    let mut running = match state.inner.lock().take() {
        Some(r) => r,
        None => return,
    };
    // SIGTERM (graceful) — listener drains its queue, flushes
    // ledgers, disconnects. libc::kill is fine here — libc is a
    // transitive Tauri dep, no new direct dependency needed.
    #[cfg(unix)]
    {
        if let Some(pid) = running.child.id() {
            // SAFETY: PID came from `child.id()` which is the live
            // child we own; sending SIGTERM is a normal lifecycle
            // operation. Return value ignored — best-effort.
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGTERM);
            }
        }
    }
    #[cfg(not(unix))]
    {
        // Windows / others: no SIGTERM equivalent; fall straight
        // through to kill below.
    }
    let _ = timeout(
        Duration::from_secs(LISTENER_STOP_GRACE_SECS),
        running.child.wait(),
    )
    .await;
    // Whether the wait timed out or completed, ensure the process
    // is gone. kill_on_drop also covers this if we just dropped
    // `child`, but we want to await it to release the FDs.
    let _ = running.child.kill().await;
    if let Some(task) = running.log_task.take() {
        task.abort();
    }
}

#[tauri::command]
pub fn slack_listener_status(state: tauri::State<'_, SlackSupervisorState>) -> SlackStatus {
    let guard = state.inner.lock();
    match guard.as_ref() {
        None => SlackStatus {
            running: false,
            workspace_id: None,
            workspace_name: None,
            bot_user_id: None,
            bot_name: None,
            last_heartbeat: None,
            last_error: None,
        },
        Some(r) => SlackStatus {
            running: true,
            workspace_id: Some(r.workspace_id.clone()),
            workspace_name: Some(r.workspace_name.clone()),
            bot_user_id: Some(r.bot_user_id.clone()),
            bot_name: Some(r.bot_name.clone()),
            last_heartbeat: r.last_heartbeat.lock().clone(),
            last_error: r.last_error.lock().clone(),
        },
    }
}

/// One-shot DM used by the connect-slack skill's verify step. Looks
/// up the target's Slack user id by email, opens the DM channel
/// implicitly via chat.postMessage's `channel: <user_id>` form, and
/// posts the intro text. Requires the listener to be running so we
/// have the bot token in hand.
#[tauri::command]
pub async fn slack_listener_send_intro(
    state: tauri::State<'_, SlackSupervisorState>,
    target_email: String,
    text: String,
) -> Result<(), String> {
    let bot_token = {
        let guard = state.inner.lock();
        guard
            .as_ref()
            .map(|r| r.bot_token.clone())
            .ok_or("listener not running — connect Slack first")?
    };
    let http = HttpClient::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("http client: {}", e))?;
    let user_id = slack_lookup_user_id(&http, &bot_token, target_email.trim()).await?;
    slack_post_message(&http, &bot_token, &user_id, text.trim()).await
}

// ---------------------------------------------------------------------------
// Bundle path resolution
// ---------------------------------------------------------------------------

fn resolve_listener_bundle<R: Runtime>(
    app: &AppHandle<R>,
    repo: &Path,
) -> Result<PathBuf, String> {
    // 1. Synced into the project by the plugin manifest.
    let in_repo = repo.join(LISTENER_REPO_REL);
    if in_repo.is_file() {
        return Ok(in_repo);
    }
    // 2. Packaged with the app (.app/Contents/Resources/...).
    let in_resources = app
        .path()
        .resolve(LISTENER_RESOURCE_REL, BaseDirectory::Resource)
        .map_err(|e| format!("resolve listener resource: {}", e))?;
    if in_resources.is_file() {
        return Ok(in_resources);
    }
    Err(format!(
        "slack listener bundle not found in any known location \
         (looked at {} and {}); run `npm run build:slack-listener` \
         and re-sync the plugin",
        in_repo.display(),
        in_resources.display()
    ))
}

// ---------------------------------------------------------------------------
// Tiny date helper — same algorithm `intake.rs::now_iso` uses;
// duplicated locally so this module stays standalone.
// ---------------------------------------------------------------------------

fn now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (y, mo, d, h, mi, s) = unix_to_ymdhms(secs);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y, mo, d, h, mi, s
    )
}

fn unix_to_ymdhms(secs: i64) -> (i32, u32, u32, u32, u32, u32) {
    let days = secs.div_euclid(86_400);
    let mut s_of_day = secs.rem_euclid(86_400) as u32;
    let h = s_of_day / 3600;
    s_of_day -= h * 3600;
    let mi = s_of_day / 60;
    let s = s_of_day - mi * 60;

    // Howard Hinnant's date algorithm.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = (yoe as i32) + (era as i32) * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d, h, mi, s)
}
