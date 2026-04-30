// Localhost chat-intake HTTP server.
//
// A coworker on the same machine (or LAN, when the Phase 3b toggle
// ships) opens the URL surfaced in the OpenIT header and chats with
// an AI agent. The agent — driven by `agents/triage.json` and the
// `ai-intake` skill — gathers the question, searches the local
// knowledge base, and either answers inline (KB hit) or escalates to
// the admin (KB miss → status flips to `escalated`, admin sees the
// banner).
//
// Bind: 127.0.0.1. Release builds use an OS-assigned port (new port
// per launch); debug builds pin DEV_INTAKE_PORT so a browser tab
// opened against the intake server survives a `bun tauri dev`
// restart. Default off LAN — the toggle is Phase 3b territory.
//
// Lifecycle: started on project open, stopped on project switch /
// app close. `intake_start` swaps the previous instance under a
// command lock to prevent races.
//
// Per-turn agent: each user message spawns a fresh `claude -p`
// subprocess with cwd = repo, model from `agents/triage.json`, and
// the conversation history + ticket id passed in the prompt. The
// skill writes ticket / conversation / people files directly via
// Claude's Read/Write/Edit tools.

use axum::{
    body::Bytes,
    extract::{Multipart, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::process::Command as TokioCommand;
use tokio::sync::{oneshot, Mutex as TokioMutex};
use tokio::task::JoinHandle;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Tauri state — wraps the running server.
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct IntakeState {
    inner: Mutex<Option<RunningServer>>,
    // Serializes the entire start/stop lifecycle so a concurrent
    // `intake_start` can't slip between this call's stop_inner and its
    // store. tokio::sync::Mutex is async-aware (parking_lot::Mutex is
    // not — can't hold across awaits).
    cmd_lock: TokioMutex<()>,
}

struct RunningServer {
    addr: SocketAddr,
    shutdown: Option<oneshot::Sender<()>>,
    handle: JoinHandle<()>,
}

// ---------------------------------------------------------------------------
// HTTP server state — shared across handlers.
// ---------------------------------------------------------------------------

/// Where this chat session originated. Stamped onto the ticket on
/// first turn (via `ensure_responding_stub`) and retained on
/// `SessionData` so subsequent turns keep provenance. Default = Chat
/// (the localhost web intake), which preserves backward compatibility
/// with the browser client that doesn't know about transports.
///
/// Add new variants here as new transports come online; the server
/// stamps `askerChannel` from the variant name and writes any
/// transport-specific fields onto the ticket once.
#[derive(Clone, Debug, Deserialize, Serialize, Default)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum TransportMeta {
    #[default]
    Chat,
    Slack {
        workspace_id: String,
        /// The DM channel id (starts with `D…`). Used by the listener
        /// for outbound replies.
        channel_id: String,
        user_id: String,
    },
}

/// One chat session — held in-memory by the server. Lost on restart;
/// disk under `databases/conversations/<ticketId>/` is canonical for
/// the actual conversation. The session map is just a fast-path so
/// each turn doesn't re-read disk for context.
#[derive(Clone)]
struct SessionData {
    ticket_id: String,
    /// Email captured from the gate form before chat starts. Always
    /// present (validated at /chat/start). Passed to the agent on
    /// every turn so it doesn't have to ask.
    email: String,
    history: Vec<ChatMessage>,
    /// Unix-seconds wall-clock timestamp of the last chat_start /
    /// chat_turn / chat_poll touching this session. Used by the LRU
    /// eviction in `evict_idle_sessions` to bound memory growth.
    last_seen_unix: u64,
    /// Transport this session arrived on. Fed into
    /// `ensure_responding_stub` on every turn so first-turn ticket
    /// stubs get the right `askerChannel` + transport-specific
    /// fields without a follow-up Edit (which would race the stub
    /// writer).
    transport: TransportMeta,
}

/// Sessions idle longer than this are dropped from the in-memory map.
/// Picked to be longer than a typical helpdesk back-and-forth (so an
/// admin reply hours later still hits a live session) but short enough
/// that abandoned tabs don't accumulate forever. Disk state survives
/// eviction — a /chat/start with a never-expiring email simply makes
/// a new session id.
const SESSION_IDLE_TTL_SECS: u64 = 60 * 60 * 6; // 6 hours
/// Hard cap. Even within TTL, if more than this many sessions exist
/// we drop the oldest. Defends against burst traffic from a hostile
/// localhost client repeatedly hitting /chat/start.
const SESSION_MAX_ENTRIES: usize = 256;

#[derive(Clone, Serialize, Deserialize)]
struct ChatMessage {
    /// "user" or "assistant" — matches Claude's role naming.
    role: String,
    content: String,
    timestamp: String,
    /// Repo-relative paths of files the asker attached on this turn
    /// (`filestores/attachments/<ticketId>/<filename>`). Empty for
    /// assistant turns and for asker turns without attachments. The
    /// prompt builder lists these inline so the agent knows to
    /// `Read` them before answering — Claude Code can ingest image
    /// content via the Read tool.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    attachments: Vec<String>,
}

#[derive(Clone)]
struct ServerState {
    repo: Arc<PathBuf>,
    sessions: Arc<TokioMutex<HashMap<String, SessionData>>>,
}

// ---------------------------------------------------------------------------
// Tauri commands — start / stop / read URL.
// ---------------------------------------------------------------------------

/// Fixed localhost port used in debug builds so a browser tab opened
/// against the intake server survives a Tauri dev-server restart.
/// Release builds always use an OS-assigned port — there's no reason
/// to pin one in production, and pinning would risk a collision with
/// whatever else the user is running.
#[cfg(debug_assertions)]
const DEV_INTAKE_PORT: u16 = 54321;

/// Start the intake server, scoped to `repo`. Returns the base URL
/// (e.g. `http://127.0.0.1:54123`).
///
/// Port selection:
/// - Release: always `127.0.0.1:0` (OS picks a free ephemeral port).
/// - Debug: try `127.0.0.1:DEV_INTAKE_PORT` first, falling back to
///   `:0` if that port is taken. Stable port across `bun tauri dev`
///   restarts means an open browser tab keeps working after a rebuild.
#[tauri::command]
pub async fn intake_start(
    state: tauri::State<'_, IntakeState>,
    repo: String,
) -> Result<String, String> {
    let repo_path = PathBuf::from(&repo);
    if !repo_path.is_dir() {
        return Err(format!("intake_start: not a directory: {}", repo));
    }

    let _cmd_guard = state.cmd_lock.lock().await;
    stop_inner(&state).await;

    let listener = bind_intake_listener()
        .await
        .map_err(|e| format!("bind failed: {}", e))?;
    let addr = listener
        .local_addr()
        .map_err(|e| format!("local_addr failed: {}", e))?;

    let app = build_router(repo_path.clone());

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let handle = tokio::spawn(async move {
        let result = axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await;
        if let Err(e) = result {
            eprintln!("[intake] server exited with error: {}", e);
        }
    });

    {
        let mut guard = state.inner.lock();
        *guard = Some(RunningServer {
            addr,
            shutdown: Some(shutdown_tx),
            handle,
        });
    }

    let url = format!("http://{}", addr);

    // Persist the URL so plugin scripts run by Claude (which don't
    // have access to OPENIT_INTAKE_URL the way the spawned listener
    // does) can discover it. Best-effort: a write failure here is
    // logged but doesn't fail intake_start — the chat-intake server
    // is up and the FE has the URL via the return value.
    if let Err(e) = persist_intake_url(&repo_path, &url).await {
        eprintln!("[intake] failed to write .openit/intake.json: {}", e);
    }

    Ok(url)
}

/// Bind the intake server's TCP listener. In debug builds, prefer the
/// pinned `DEV_INTAKE_PORT` so the URL stays stable across dev-server
/// restarts; if it's already taken (e.g. another OpenIT instance, or
/// a stale process), fall back to an OS-assigned port. Release builds
/// always use `:0`.
async fn bind_intake_listener() -> std::io::Result<TcpListener> {
    #[cfg(debug_assertions)]
    {
        let pinned = format!("127.0.0.1:{}", DEV_INTAKE_PORT);
        match TcpListener::bind(&pinned).await {
            Ok(listener) => return Ok(listener),
            Err(e) => eprintln!(
                "[intake] dev port {} unavailable ({}), falling back to OS-assigned",
                DEV_INTAKE_PORT, e
            ),
        }
    }
    TcpListener::bind("127.0.0.1:0").await
}

async fn persist_intake_url(repo: &Path, url: &str) -> std::io::Result<()> {
    let dir = repo.join(".openit");
    tokio::fs::create_dir_all(&dir).await?;
    let body = serde_json::json!({ "url": url });
    let json = serde_json::to_string_pretty(&body).map_err(std::io::Error::other)?;
    tokio::fs::write(dir.join("intake.json"), json).await
}

#[tauri::command]
pub async fn intake_stop(state: tauri::State<'_, IntakeState>) -> Result<(), String> {
    let _cmd_guard = state.cmd_lock.lock().await;
    stop_inner(&state).await;
    Ok(())
}

#[tauri::command]
pub fn intake_url(state: tauri::State<'_, IntakeState>) -> Option<String> {
    let guard = state.inner.lock();
    guard.as_ref().map(|s| format!("http://{}", s.addr))
}

async fn stop_inner(state: &tauri::State<'_, IntakeState>) {
    let running = {
        let mut guard = state.inner.lock();
        guard.take()
    };
    if let Some(mut running) = running {
        if let Some(tx) = running.shutdown.take() {
            let _ = tx.send(());
        }
        let _ = running.handle.await;
    }
}

// ---------------------------------------------------------------------------
// Router — chat routes only. Form path was dropped: chat IS the intake.
// ---------------------------------------------------------------------------

fn build_router(repo: PathBuf) -> Router {
    let state = ServerState {
        repo: Arc::new(repo),
        sessions: Arc::new(TokioMutex::new(HashMap::new())),
    };
    Router::new()
        .route("/", get(serve_chat))
        .route("/chat", get(serve_chat))
        .route("/chat/start", post(chat_start))
        .route("/chat/turn", post(chat_turn))
        .route("/chat/poll", get(chat_poll))
        // Attachments: upload (multipart, asker side) lands in
        // `filestores/attachments/<ticketId>/<filename>`; file fetch
        // serves bytes back to the chat browser, sandboxed to the
        // session's ticket folder.
        .route("/chat/upload", post(chat_upload))
        .route("/chat/file", get(chat_file))
        // Skill-driven endpoints. Plugin scripts (run by Claude in the
        // user's project via Bash) POST here to ask the running app
        // to perform work that needs in-process state — e.g. the
        // Slack listener's bot token. The script discovers the URL
        // by reading `.openit/intake.json`.
        .route("/skill/slack-send-intro", post(skill_slack_send_intro))
        .layer(axum::extract::DefaultBodyLimit::max(MAX_UPLOAD_BYTES))
        .with_state(state)
}

#[derive(Deserialize)]
struct SlackSendIntroBody {
    /// Email of the Slack user to DM. Resolved to a user id via
    /// users.lookupByEmail.
    email: String,
    /// Optional override; defaults to the canonical intro line so
    /// every test DM reads the same.
    text: Option<String>,
}

const DEFAULT_INTRO_TEXT: &str =
    "Hi! I'm the OpenIT triage bot. Try asking me a question — e.g. \"how do I reset my Mac password?\" — and I'll either answer from your knowledge base or escalate to your IT team.";

async fn skill_slack_send_intro(Json(body): Json<SlackSendIntroBody>) -> Response {
    // Bot token lives in a process-global Arc that `slack.rs`
    // updates on listener bring-up / exit. No AppHandle needed —
    // we just lock the global, clone the string, and call the
    // shared HTTP helpers.
    let bot_token = match crate::slack::current_bot_token() {
        Some(t) => t,
        None => {
            return (
                StatusCode::FAILED_DEPENDENCY,
                Json(serde_json::json!({
                    "ok": false,
                    "error": "slack listener not running — connect Slack first",
                })),
            )
                .into_response();
        }
    };
    let http = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "ok": false,
                    "error": format!("http client init: {}", e),
                })),
            )
                .into_response();
        }
    };
    let user_id =
        match crate::slack::slack_lookup_user_id(&http, &bot_token, body.email.trim()).await {
            Ok(id) => id,
            Err(e) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({"ok": false, "error": e})),
                )
                    .into_response();
            }
        };
    let text = body.text.unwrap_or_else(|| DEFAULT_INTRO_TEXT.to_string());
    if let Err(e) = crate::slack::slack_post_message(&http, &bot_token, &user_id, text.trim()).await
    {
        return (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({"ok": false, "error": e})),
        )
            .into_response();
    }
    (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response()
}

/// Hard cap on a single uploaded attachment. 25 MB is plenty for the
/// asker-uploaded screenshots / log files we expect; larger payloads
/// are almost always videos that don't belong in a ticket history.
const MAX_UPLOAD_BYTES: usize = 25 * 1024 * 1024;

async fn serve_chat() -> Html<&'static str> {
    Html(CHAT_HTML)
}

// ---------------------------------------------------------------------------
// /chat/start — allocate session + ticketId.
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct ChatStartReq {
    email: String,
    /// Optional. When omitted, the session is treated as the default
    /// localhost web chat (`TransportMeta::Chat`) — preserves the
    /// existing browser client's payload exactly. Non-web transports
    /// (e.g. the Slack listener) populate this so the ticket stub
    /// gets the right `askerChannel` + provenance fields on first
    /// turn.
    #[serde(default)]
    transport: Option<TransportMeta>,
    /// Optional. When set, the server reuses an existing on-disk
    /// ticket id instead of generating a new one. Used by transports
    /// that persist their session map across restarts (Slack
    /// listener) so a listener restart doesn't fork an in-progress
    /// conversation into a second ticket.
    ///
    /// Validation: the ticket file must exist AND its `asker` field
    /// must equal the request's `email`. Any mismatch returns 400 —
    /// the caller is expected to drop its stale mapping and retry
    /// without `resume_ticket_id`.
    #[serde(default)]
    resume_ticket_id: Option<String>,
}

#[derive(Serialize)]
struct ChatStartResp {
    session_id: String,
    ticket_id: String,
}

async fn chat_start(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(req): Json<ChatStartReq>,
) -> Response {
    if !origin_is_localhost(&headers) {
        return (StatusCode::FORBIDDEN, "cross-origin not allowed").into_response();
    }
    let email = req.email.trim();
    if email.is_empty() || !email.contains('@') {
        return (StatusCode::BAD_REQUEST, "a valid email is required").into_response();
    }

    // Resolve ticket_id: reuse a previously-allocated one if the
    // caller supplied a valid `resume_ticket_id`, otherwise mint a
    // fresh one. Format mirrors the rest of the system: ISO
    // timestamp + 4-char random suffix, filesystem-safe.
    let ticket_id = match req.resume_ticket_id.as_deref() {
        Some(id) => match validate_resume_ticket_id(&state.repo, id, email).await {
            Ok(()) => id.to_string(),
            Err(msg) => {
                return (StatusCode::BAD_REQUEST, msg).into_response();
            }
        },
        None => generate_ticket_id(),
    };

    let session_id = Uuid::new_v4().to_string();

    let mut sessions = state.sessions.lock().await;
    evict_idle_sessions(&mut sessions);
    sessions.insert(
        session_id.clone(),
        SessionData {
            ticket_id: ticket_id.clone(),
            email: email.to_string(),
            history: Vec::new(),
            last_seen_unix: unix_now_secs(),
            transport: req.transport.unwrap_or_default(),
        },
    );

    Json(ChatStartResp {
        session_id,
        ticket_id,
    })
    .into_response()
}

/// Validate a caller-supplied `resume_ticket_id`: the ticket file
/// must exist and its `asker` field must match the request's email.
/// Anything else → error string suitable for a 400 response body.
async fn validate_resume_ticket_id(
    repo: &Path,
    ticket_id: &str,
    email: &str,
) -> Result<(), String> {
    // Cheap path-traversal guard. Ticket ids are server-generated
    // tokens (`generate_ticket_id`) — slashes, parent traversals,
    // null bytes are all bugs in the caller.
    if ticket_id.is_empty()
        || ticket_id.contains('/')
        || ticket_id.contains('\\')
        || ticket_id.contains("..")
        || ticket_id.contains('\0')
    {
        return Err("resume_ticket_id is malformed".to_string());
    }
    let path = repo
        .join("databases")
        .join("tickets")
        .join(format!("{}.json", ticket_id));
    let raw = tokio::fs::read_to_string(&path)
        .await
        .map_err(|_| "resume_ticket_id does not match an existing ticket".to_string())?;
    let parsed: serde_json::Value =
        serde_json::from_str(&raw).map_err(|_| "resume_ticket_id is unreadable".to_string())?;
    let existing = parsed
        .get("asker")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if existing != email {
        return Err("resume_ticket_id belongs to a different asker".to_string());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// /chat/turn — per-turn agent invocation via `claude -p`.
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct ChatTurnReq {
    session_id: String,
    message: String,
    // Repo-relative paths produced by /chat/upload, e.g.
    // `filestores/attachments/<ticketId>/<filename>`. Server stamps
    // them onto the asker's turn JSON so both the chat browser and
    // the desktop conversation viewer can render them inline. Empty
    // / missing → no attachments on this turn.
    #[serde(default)]
    attachments: Vec<String>,
}

#[derive(Serialize)]
struct ChatTurnResp {
    reply: String,
    /// Current ticket status read from disk after the turn (or
    /// "no-ticket" if the agent hasn't committed one yet for this
    /// session). Drives the chat UI's "agent escalated" / "agent is
    /// still gathering" state.
    status: String,
    /// ISO-8601 timestamp the client should use as `since` for
    /// subsequent /chat/poll calls.
    polled_at: String,
}

async fn chat_turn(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(req): Json<ChatTurnReq>,
) -> Response {
    if !origin_is_localhost(&headers) {
        return (StatusCode::FORBIDDEN, "cross-origin not allowed").into_response();
    }
    let trimmed = req.message.trim();
    if trimmed.is_empty() {
        return (StatusCode::BAD_REQUEST, "message is required").into_response();
    }

    // Snapshot the session for this turn. Done with the lock held;
    // released before we spawn `claude -p` (which can take seconds).
    // Also bump `last_seen_unix` so the LRU eviction doesn't drop an
    // active session.
    let (ticket_id, email, history_before, repo, transport) = {
        let mut sessions = state.sessions.lock().await;
        let Some(session) = sessions.get_mut(&req.session_id) else {
            return (StatusCode::NOT_FOUND, "unknown session").into_response();
        };
        session.last_seen_unix = unix_now_secs();
        (
            session.ticket_id.clone(),
            session.email.clone(),
            session.history.clone(),
            state.repo.clone(),
            session.transport.clone(),
        )
    };

    // Mark the ticket `agent-responding` so the OpenIT admin's
    // activity banner fires immediately (before claude -p has had
    // a chance to write anything). On the first turn the ticket
    // file may not exist yet — write a minimal stub with the
    // user's message as the description. The skill will fill in
    // any remaining fields when it writes the full row.
    // Sanitize attachments: keep only paths that look like they came
    // from /chat/upload for THIS ticket. The path is stamped onto the
    // turn JSON; we never trust it for filesystem operations later
    // (the chat browser fetches via /chat/file which re-validates).
    let valid_attachments: Vec<String> = req
        .attachments
        .iter()
        .filter_map(|p| {
            let trimmed = p.trim();
            if trimmed.is_empty() {
                return None;
            }
            let prefix = format!("filestores/attachments/{}/", ticket_id);
            if trimmed.starts_with(&prefix) && !trimmed.contains("..") {
                Some(trimmed.to_string())
            } else {
                None
            }
        })
        .collect();
    let _ = ensure_responding_stub(
        &repo,
        &ticket_id,
        &email,
        trimmed,
        &valid_attachments,
        &transport,
    )
    .await;

    // Append the user's message to the in-memory history before
    // invoking the agent so the prompt contains it.
    let user_msg = ChatMessage {
        role: "user".to_string(),
        content: trimmed.to_string(),
        timestamp: now_iso(),
        attachments: valid_attachments.clone(),
    };
    let mut history = history_before;
    history.push(user_msg);

    // Read the agent's persona + selected model from agents/triage.json.
    let (agent_instructions, model) = load_triage_agent(&repo).await;

    // Build the prompt and run claude -p. This is the slow part
    // (~3-5s per turn). The skill is auto-loaded by Claude based on
    // the cwd's .claude/skills/ directory.
    let prompt = build_chat_prompt(&agent_instructions, &history, &ticket_id, &email);
    let started_at = now_iso();
    // Live trace persister — writes a partial trace file after each
    // event so the desktop viewer (clicked into via the activity
    // banner) shows the agent's actions appearing in real time
    // rather than a single dump after the turn completes. Same
    // file path as the final `persist_trace` call below, so the
    // final write just overwrites with the dispatched outcome.
    let turn_id = format!("turn-{}", unix_now_secs());
    let persister = LiveTracePersister {
        repo: repo.as_ref().clone(),
        ticket_id: ticket_id.clone(),
        turn_id: turn_id.clone(),
        started_at: started_at.clone(),
        model: model.clone(),
    };
    let reply_result = spawn_claude_chat(&repo, &model, &prompt, Some(&persister)).await;

    let ChatTurnOutput { reply, events } = match reply_result {
        Ok(out) => out,
        Err(e) => {
            eprintln!("[intake/chat] claude -p failed: {}", e);
            // Best-effort: if we marked the ticket agent-responding,
            // flip it back to escalated so the admin notices something
            // went wrong rather than the ticket being stuck pretending
            // to type.
            let _ = mark_status(&repo, &ticket_id, "escalated").await;
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("agent error: {}", e),
            )
                .into_response();
        }
    };

    // Parse the agent's status marker out of stdout. Contract: the
    // agent's last non-empty line is `<<STATUS:answered>>` (KB hit)
    // or `<<STATUS:escalated>>` (KB miss). `resolved` is accepted as
    // a legacy alias for `answered`. Server strips the marker before
    // writing the reply turn and uses the parsed outcome as the
    // authoritative decision (no agent free-Edit'ing of the ticket
    // status field, which raced against `ensure_responding_stub` and
    // the post-turn safety net). Missing marker → escalated.
    let (reply_body, decided_status) = parse_status_marker(&reply);

    // Persist the assistant reply to the in-memory history.
    {
        let mut sessions = state.sessions.lock().await;
        if let Some(session) = sessions.get_mut(&req.session_id) {
            session.history = history;
            session.history.push(ChatMessage {
                role: "assistant".to_string(),
                content: reply_body.clone(),
                timestamp: now_iso(),
                attachments: Vec::new(),
            });
        }
    }

    // Write the agent's reply turn to disk deterministically. The
    // skill is told not to write conversation turns — only emit the
    // status marker — so the server controls sender + role + body.
    let _ = write_agent_turn(&repo, &ticket_id, &reply_body).await;

    // Apply the agent's decision. Three valid outcomes:
    //   Answered  → ticket → `open`     (KB hit; conversation alive)
    //   Resolved  → ticket → `resolved` (asker confirmed; terminal)
    //   Escalated → ticket → `escalated` (admin attention)
    // Either way the ticket exits `agent-responding`, so the activity
    // banner is visible only during the ~3-5s claude -p window.
    //
    // `Resolved` is terminal but NOT permanent — `ensure_responding_stub`
    // flips a resolved ticket back to `agent-responding` on the next
    // asker turn, and that turn's outcome takes over (e.g. another
    // "thanks!" → resolved again, or "wait it broke" → escalated).
    // The agent makes the call each turn; the lifecycle is self-healing.
    //
    // The Clarifying variant is kept for backwards compatibility with
    // any in-flight legacy skill; treating it as Escalated is the safe
    // fallback so the admin gets visibility and the ticket can't pin
    // the banner.
    let outcome_label = match decided_status {
        DecidedStatus::Answered => {
            let _ = mark_status(&repo, &ticket_id, "open").await;
            "answered"
        }
        DecidedStatus::Resolved => {
            let _ = mark_status(&repo, &ticket_id, "resolved").await;
            "resolved"
        }
        DecidedStatus::Escalated | DecidedStatus::Clarifying => {
            let _ = mark_status(&repo, &ticket_id, "escalated").await;
            "escalated"
        }
    };

    // Persist the agent-trace audit log for this turn. Best-effort;
    // a failed write shouldn't block the chat reply (the conversation
    // turn is already on disk and the user is waiting). The frontend
    // banner / activity viewer will pick the file up via the watcher
    // once it lands.
    let trace_doc = crate::agent_trace::TraceDoc {
        ticket_id: ticket_id.clone(),
        turn_id,
        started_at,
        completed_at: now_iso(),
        model: model.clone(),
        outcome: outcome_label.to_string(),
        events,
    };
    if let Err(e) = crate::agent_trace::persist_trace(&repo, &trace_doc).await {
        eprintln!("[intake/chat] persist_trace failed: {}", e);
    }

    // Auto-commit everything this turn touched so the admin's Versions
    // panel doesn't show server-driven activity (asker turns, ticket
    // status flips, agent reply, people-row upserts) as if they were
    // unstaged human edits. Same pattern the cloud sync engines use —
    // the panel ends up reflecting only deliberate admin work
    // (manual file edits, KB article authoring, etc.).
    let _ = auto_commit_chat_turn(&repo, &ticket_id, &email).await;

    // Read status from disk for the response payload.
    let status = read_ticket_status(&repo, &ticket_id)
        .await
        .unwrap_or_else(|| "no-ticket".to_string());

    // The polled_at returned to the client must be just before the
    // turns we wrote, so the next /chat/poll's `since` filter doesn't
    // skip same-second turns. With second-precision ISO timestamps
    // and a `<` filter, returning a timestamp < (asker_turn_ts,
    // agent_turn_ts) keeps both visible to subsequent polls (the
    // client's seenTurnKeys de-dupes anything already rendered).
    let polled_at = iso_one_second_ago();

    Json(ChatTurnResp {
        reply: reply_body,
        status,
        polled_at,
    })
    .into_response()
}

// ---------------------------------------------------------------------------
// /chat/poll — return any new turns from disk since `since`.
// Used by the chat UI to surface admin replies after the agent
// escalates.
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct ChatPollQuery {
    session_id: String,
    since: Option<String>,
}

#[derive(Serialize)]
struct ChatPollResp {
    turns: Vec<PolledTurn>,
    polled_at: String,
    status: String,
}

#[derive(Serialize)]
struct PolledTurn {
    role: String,
    sender: String,
    body: String,
    timestamp: String,
    /// Repo-relative paths (filestores/attachments/<ticketId>/<filename>).
    /// Empty when the turn has no attachments. The chat UI fetches the
    /// bytes via `/chat/file?path=...` for inline rendering.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    attachments: Vec<String>,
}

async fn chat_poll(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Query(q): Query<ChatPollQuery>,
) -> Response {
    if !origin_is_localhost(&headers) {
        return (StatusCode::FORBIDDEN, "cross-origin not allowed").into_response();
    }
    let ticket_id = {
        let mut sessions = state.sessions.lock().await;
        match sessions.get_mut(&q.session_id) {
            Some(s) => {
                s.last_seen_unix = unix_now_secs();
                s.ticket_id.clone()
            }
            None => return (StatusCode::NOT_FOUND, "unknown session").into_response(),
        }
    };

    let since = q.since.unwrap_or_default();
    let dir = state
        .repo
        .join("databases")
        .join("conversations")
        .join(&ticket_id);

    let mut turns = Vec::new();
    if let Ok(mut entries) = tokio::fs::read_dir(&dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            // Skip conflict shadows (cloud-mode artifact).
            if path
                .file_name()
                .and_then(|s| s.to_str())
                .map(|n| n.contains(".server."))
                .unwrap_or(false)
            {
                continue;
            }
            let Ok(raw) = tokio::fs::read_to_string(&path).await else {
                continue;
            };
            let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) else {
                continue;
            };
            let timestamp = parsed
                .get("timestamp")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            // Strict `<` (not `<=`) so same-second turns aren't dropped.
            // Timestamps are ISO with second precision, and an admin
            // reply written in the same wall-clock second as the agent
            // reply must still be visible. Client de-dupes via the
            // (timestamp, role, body) key in `seenTurnKeys`.
            if !since.is_empty() && timestamp < since {
                continue;
            }
            let attachments = parsed
                .get("attachments")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            turns.push(PolledTurn {
                role: parsed
                    .get("role")
                    .and_then(|v| v.as_str())
                    .unwrap_or("agent")
                    .to_string(),
                sender: parsed
                    .get("sender")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                body: parsed
                    .get("body")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                timestamp,
                attachments,
            });
        }
    }
    turns.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));

    let status = read_ticket_status(&state.repo, &ticket_id)
        .await
        .unwrap_or_else(|| "no-ticket".to_string());

    Json(ChatPollResp {
        turns,
        polled_at: now_iso(),
        status,
    })
    .into_response()
}

// ---------------------------------------------------------------------------
// /chat/upload — multipart upload for asker attachments. Saves under
// `filestores/attachments/<ticketId>/<filename>`. Returns the
// repo-relative path the client should include on the next /chat/turn.
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct ChatUploadResp {
    /// Repo-relative path of the saved file. The client stores this on
    /// a per-attachment chip in the composer and forwards it as part
    /// of `attachments: [...]` on the next /chat/turn.
    path: String,
    filename: String,
}

async fn chat_upload(
    State(state): State<ServerState>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Response {
    if !origin_is_localhost(&headers) {
        return (StatusCode::FORBIDDEN, "cross-origin not allowed").into_response();
    }

    // Expected multipart fields: `session_id` (text) + `file` (binary).
    let mut session_id: Option<String> = None;
    let mut filename: Option<String> = None;
    let mut bytes: Option<Bytes> = None;
    while let Ok(Some(field)) = multipart.next_field().await {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "session_id" => {
                if let Ok(v) = field.text().await {
                    session_id = Some(v);
                }
            }
            "file" => {
                filename = field.file_name().map(|s| s.to_string());
                if let Ok(b) = field.bytes().await {
                    bytes = Some(b);
                }
            }
            _ => {
                // Drain unknown fields so the multipart cursor advances.
                let _ = field.bytes().await;
            }
        }
    }

    let Some(session_id) = session_id else {
        return (StatusCode::BAD_REQUEST, "missing session_id field").into_response();
    };
    let Some(bytes) = bytes else {
        return (StatusCode::BAD_REQUEST, "missing file field").into_response();
    };
    let raw_filename = filename.unwrap_or_else(|| "upload".to_string());
    let safe_filename = sanitize_attachment_filename(&raw_filename);
    if bytes.len() > MAX_UPLOAD_BYTES {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            format!(
                "attachment exceeds {} MB cap",
                MAX_UPLOAD_BYTES / (1024 * 1024)
            ),
        )
            .into_response();
    }

    // Resolve the session's ticket id under the lock.
    let ticket_id = {
        let mut sessions = state.sessions.lock().await;
        match sessions.get_mut(&session_id) {
            Some(s) => {
                s.last_seen_unix = unix_now_secs();
                s.ticket_id.clone()
            }
            None => return (StatusCode::NOT_FOUND, "unknown session").into_response(),
        }
    };

    let dir = state
        .repo
        .join("filestores")
        .join("attachments")
        .join(&ticket_id);
    if let Err(e) = tokio::fs::create_dir_all(&dir).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("mkdir attachments dir: {}", e),
        )
            .into_response();
    }

    // Resolve a non-colliding filename. If `name.ext` already exists,
    // try `name (2).ext`, `name (3).ext`, etc. up to 99 — beyond that
    // the user's having a name-collision party and a hard error is
    // probably the right surface.
    let final_name = unique_attachment_name(&dir, &safe_filename).await;
    let final_path = dir.join(&final_name);
    if let Err(e) = tokio::fs::write(&final_path, &bytes).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("write attachment: {}", e),
        )
            .into_response();
    }

    let rel_path = format!("filestores/attachments/{}/{}", ticket_id, final_name);
    Json(ChatUploadResp {
        path: rel_path,
        filename: final_name,
    })
    .into_response()
}

/// Strip path separators and characters that would break filesystems.
/// Preserves the extension so MIME sniffing on the chat side still
/// works. Returns at least `"upload"` so we never end up with an
/// empty filename.
fn sanitize_attachment_filename(name: &str) -> String {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return "upload".to_string();
    }
    // Take the basename — drops any leading path the browser might
    // have leaked (some Linux file managers send full paths).
    let base = trimmed.rsplit(['/', '\\']).next().unwrap_or(trimmed);
    let cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_control() || c == ':' || c == '\0' {
                '_'
            } else {
                c
            }
        })
        .collect();
    if cleaned.starts_with('.') {
        format!("attachment{}", cleaned)
    } else if cleaned.is_empty() {
        "upload".to_string()
    } else {
        cleaned
    }
}

/// Find a non-colliding filename in `dir`. If `desired` doesn't exist
/// returns it as-is; otherwise tries `name (2).ext`, `name (3).ext`,
/// etc.
async fn unique_attachment_name(dir: &Path, desired: &str) -> String {
    if !dir.join(desired).exists() {
        return desired.to_string();
    }
    let (stem, ext) = match desired.rfind('.') {
        Some(i) if i > 0 => (&desired[..i], &desired[i..]),
        _ => (desired, ""),
    };
    for n in 2..100u32 {
        let candidate = format!("{} ({}){}", stem, n, ext);
        if !dir.join(&candidate).exists() {
            return candidate;
        }
    }
    // Fall through with a timestamp — better than overwriting.
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{}-{}{}", stem, ms, ext)
}

// ---------------------------------------------------------------------------
// /chat/file — serve attachment bytes back to the chat browser.
// Sandboxed: only paths under
// `filestores/attachments/<thisSessionsTicketId>/...` are allowed,
// preventing path traversal or cross-ticket leaks even when a session
// has stale links to a different thread.
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct ChatFileQuery {
    session_id: String,
    path: String,
}

async fn chat_file(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Query(q): Query<ChatFileQuery>,
) -> Response {
    if !origin_is_localhost(&headers) {
        return (StatusCode::FORBIDDEN, "cross-origin not allowed").into_response();
    }

    // Resolve ticket_id under the lock so concurrent /chat/start
    // doesn't see torn state.
    let ticket_id = {
        let mut sessions = state.sessions.lock().await;
        match sessions.get_mut(&q.session_id) {
            Some(s) => {
                s.last_seen_unix = unix_now_secs();
                s.ticket_id.clone()
            }
            None => return (StatusCode::NOT_FOUND, "unknown session").into_response(),
        }
    };

    // Reject anything that doesn't look like an attachment path for
    // THIS ticket. The double check (string prefix + canonicalized
    // ancestor) is intentional: the prefix check is cheap and
    // explicit; canonicalize prevents `..` traversal even when the
    // caller submits a path like
    // `filestores/attachments/<tid>/../../../../etc/passwd`.
    let expected_prefix = format!("filestores/attachments/{}/", ticket_id);
    if !q.path.starts_with(&expected_prefix) || q.path.contains("..") {
        return (StatusCode::FORBIDDEN, "path out of bounds").into_response();
    }

    let abs = state.repo.join(&q.path);
    let canonical = match tokio::fs::canonicalize(&abs).await {
        Ok(p) => p,
        Err(_) => return (StatusCode::NOT_FOUND, "file not found").into_response(),
    };
    let allowed_root = state
        .repo
        .join("filestores")
        .join("attachments")
        .join(&ticket_id);
    let allowed_canonical = match tokio::fs::canonicalize(&allowed_root).await {
        Ok(p) => p,
        Err(_) => return (StatusCode::NOT_FOUND, "ticket folder not found").into_response(),
    };
    if !canonical.starts_with(&allowed_canonical) {
        return (StatusCode::FORBIDDEN, "path out of bounds").into_response();
    }

    let bytes = match tokio::fs::read(&canonical).await {
        Ok(b) => b,
        Err(_) => return (StatusCode::NOT_FOUND, "file not found").into_response(),
    };

    // Best-effort content-type from extension. Falls back to
    // octet-stream so the browser hands the user a download dialog
    // for unknown types instead of misrendering.
    let mime = mime_for_attachment(&canonical);
    let mut response = (StatusCode::OK, bytes).into_response();
    if let Ok(value) = header::HeaderValue::from_str(&mime) {
        response.headers_mut().insert(header::CONTENT_TYPE, value);
    }
    response
}

/// Lightweight extension → MIME type map. Tightly scoped to what
/// users typically attach to a ticket. Anything outside the map gets
/// `application/octet-stream` and the browser handles via download.
fn mime_for_attachment(path: &Path) -> String {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "txt" | "log" => "text/plain; charset=utf-8",
        "json" => "application/json",
        "csv" => "text/csv",
        "md" => "text/markdown; charset=utf-8",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
    .to_string()
}

// ---------------------------------------------------------------------------
// Helpers — agent invocation, ticket file operations.
// ---------------------------------------------------------------------------

/// Read `agents/triage.json` for the persona instructions + selected
/// model. Falls back to safe defaults if the file is missing or
/// malformed (rare — the bundled-skills sync writes it on first run).
async fn load_triage_agent(repo: &Path) -> (String, String) {
    let path = repo.join("agents").join("triage.json");
    let raw = match tokio::fs::read_to_string(&path).await {
        Ok(s) => s,
        Err(_) => {
            return (
                "You are a helpdesk triage agent.".to_string(),
                "sonnet".to_string(),
            )
        }
    };
    let parsed: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => {
            return (
                "You are a helpdesk triage agent.".to_string(),
                "sonnet".to_string(),
            )
        }
    };
    let instructions = parsed
        .get("instructions")
        .and_then(|v| v.as_str())
        .unwrap_or("You are a helpdesk triage agent.")
        .to_string();
    let model = parsed
        .get("selectedModel")
        .and_then(|v| v.as_str())
        .unwrap_or("sonnet")
        .to_string();
    (instructions, model)
}

/// Compose the prompt for `claude -p`. Format: agent persona, then
/// the operational context (ticket id, asker email, skill hint),
/// then the conversation history rendered as USER/ASSISTANT lines.
fn build_chat_prompt(
    persona: &str,
    history: &[ChatMessage],
    ticket_id: &str,
    asker_email: &str,
) -> String {
    let mut prompt = String::new();
    prompt.push_str(persona);
    prompt.push_str("\n\n");
    prompt.push_str(
        "Operational context: You are running inside a chat-intake \
         turn. Use the `ai-intake` skill at `.claude/skills/ai-intake/SKILL.md` \
         for the file paths and field conventions. Use \
         `Bash node .claude/scripts/kb-search.mjs \"<query>\"` to find \
         relevant knowledge-base articles.\n\n",
    );
    prompt.push_str(&format!(
        "The asker's email is `{}` — captured in the gate form before \
         this chat started. You already have it; do NOT ask the user \
         for it again. Use this email as the `asker` and `sender` \
         field on the ticket and on conversation turns from the \
         asker, and as the key for the people row.\n\n",
        asker_email
    ));
    prompt.push_str(&format!(
        "The ticket id for this conversation is `{}`. Always use this \
         exact id when writing the ticket file at \
         `databases/tickets/<ticketId>.json`, the conversation \
         subfolder at `databases/conversations/<ticketId>/`, and as the \
         `ticketId` field on every conversation row. Do NOT create a \
         second ticket id for this session.\n\n",
        ticket_id
    ));
    prompt.push_str("Conversation so far:\n");
    for msg in history {
        let label = if msg.role == "user" {
            "USER"
        } else {
            "ASSISTANT"
        };
        prompt.push_str(&format!("{}: {}\n", label, msg.content));
        if !msg.attachments.is_empty() {
            // Inline the attachment paths so the agent knows which
            // files belong to this turn. Reading them is up to the
            // agent — for screenshots / diagrams the model can ingest
            // image content via the Read tool.
            for att in &msg.attachments {
                prompt.push_str(&format!("  [attachment: {}]\n", att));
            }
        }
    }
    if history.iter().any(|m| !m.attachments.is_empty()) {
        prompt.push_str(
            "\nWhen a USER turn lists attachments, use the Read tool on each \
             repo-relative path BEFORE deciding the outcome. Screenshots, \
             logs, and PDFs often carry the actual question (e.g. \"this?\" \
             with a screenshot of an error). Skipping the attachment and \
             escalating because the body looks vague is the wrong move.\n",
        );
    }
    prompt.push_str(
        "\nIMPORTANT: Do NOT write any conversation turn files (no \
         msg-*.json under databases/conversations/). The server \
         already wrote the asker's turn before invoking you, and the \
         server will write your agent reply turn after you finish \
         using your stdout as the body. If you write a turn yourself \
         it WILL appear duplicated in the admin UI.\n\n\
         Also do NOT Edit the ticket's `status` field — the server \
         sets it based on the marker you emit (see below), so an \
         agent-side Edit will race against the server and may be \
         clobbered.\n\n\
         Your job: (1) read the ticket + conversation history for \
         context, (2) run `Bash node .claude/scripts/kb-search.mjs \
         \"<query>\"` to search the local knowledge base when the \
         user is asking a new question — pass a compact query that \
         captures it, (3) decide one of exactly three outcomes — \
         `answered` (KB had a relevant article and you replied from \
         it; ticket → open), `escalated` (KB had no relevant match, \
         or the question needs a human; ticket → escalated), or \
         `resolved` (the asker has explicitly confirmed the case is \
         done — \"thanks that worked\" / \"all good\" / \"works now\" \
         — and a prior agent or admin turn provided the answer; \
         ticket → resolved, terminal), (4) output your reply to the \
         user, then (5) end with a status marker on its own line: \
         `<<STATUS:answered>>`, `<<STATUS:escalated>>`, or \
         `<<STATUS:resolved>>`.\n\n\
         The marker reflects your *turn outcome*, not just the case \
         lifecycle. Multiple `answered` turns in a row is normal for \
         ongoing back-and-forth. Use `resolved` only when you're \
         confident the asker is closing the loop — when in doubt, \
         emit `answered`; the admin can always close manually, and \
         the asker can reopen by sending another message.\n\n\
         CRITICAL: do NOT ask the user a follow-up question. There \
         is no \"clarifying\" outcome. If you can't answer from the \
         KB on the information you already have, escalate — the \
         admin will ask the asker any follow-ups themselves. Asking \
         the user another question instead of escalating leaves the \
         ticket stuck and frustrates the user.\n\n\
         The reply is what the user sees in the chat — conversational, \
         no file paths, no status narration, no meta-commentary. \
         Plain text only: no markdown formatting (no `**bold**`, no \
         `*italics*`, no `# headings`, no `- bullet lists`, no fenced \
         code blocks, no tables). The chat surface renders raw text \
         and so will the eventual Slack/Teams ingest, so markdown \
         shows through as literal asterisks and pound signs. If you \
         need to enumerate steps, use plain numbers (`1. `, `2. `) in \
         normal sentences. The server strips the marker line before \
         writing the turn. Missing or malformed marker → defaults to \
         escalated, so the admin still sees the ticket.",
    );
    prompt
}

/// Spawn `claude -p` with the prompt on stdin. Returns the trimmed
/// stdout as the agent's reply. Stderr is captured but not surfaced
/// to the user (logged for forensics).
///
/// Resolves the `claude` binary via `which` because Tauri-spawned
/// subprocesses don't always inherit the user's full shell PATH —
/// dev mode and .app launches may only see `/usr/bin:/bin`. Same
/// pattern as `claude_generate_commit_message`.
/// Output of a single `claude -p` chat turn — the assistant's reply
/// text plus a normalized timeline of events the model emitted while
/// running (tool calls, text deltas, the final `result`). The
/// dispatcher in `chat_turn` consumes the reply for the chat UI and
/// hands the events to `agent_trace::persist_trace` for the audit log.
struct ChatTurnOutput {
    reply: String,
    events: Vec<crate::agent_trace::TraceEvent>,
}

async fn spawn_claude_chat(
    repo: &Path,
    model: &str,
    prompt: &str,
    persister: Option<&LiveTracePersister>,
) -> Result<ChatTurnOutput, String> {
    let claude_path = which::which("claude")
        .map_err(|_| "Claude CLI not found on PATH. Install claude (see https://docs.anthropic.com/claude/docs/claude-code) and ensure it's reachable from this app.".to_string())?;
    // `--permission-mode bypassPermissions` so the headless run can
    // Write/Edit ticket+conversation files and Bash the kb-search
    // script without prompting. Safe in this context — scope is the
    // user's own repo, the skill is OpenIT-bundled, and the only
    // shell command is the local kb-search.mjs.
    //
    // `--verbose --output-format stream-json` makes claude emit one
    // JSON event per line: a `system/init`, then per-step
    // `assistant`/`user`/`tool_*` messages, ending with a `result`.
    // We parse those into a normalized timeline so the audit log
    // (`.openit/agent-traces/`) and the eventual live banner can
    // surface friendly verbs ("Reading the ticket", "Searching the
    // knowledge base for …") without re-parsing claude's wire format
    // on the frontend.
    //
    // `kill_on_drop(true)` so a timeout (or any early-return below)
    // reaps the subprocess instead of leaving an orphaned `claude`
    // running with the user's prompt.
    let mut child = TokioCommand::new(&claude_path)
        .arg("-p")
        .arg("--verbose")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--permission-mode")
        .arg("bypassPermissions")
        .arg("--model")
        .arg(model)
        .current_dir(repo)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("spawn claude: {}", e))?;

    {
        let mut stdin = child.stdin.take().ok_or("no stdin handle")?;
        stdin
            .write_all(prompt.as_bytes())
            .await
            .map_err(|e| format!("write stdin: {}", e))?;
        stdin.flush().await.ok();
        // Drop `stdin` here (end of scope) so claude sees EOF and
        // proceeds. Without this, `claude -p` blocks reading stdin
        // forever and `child.wait()` deadlocks against
        // `parse_stream_json` for the full 90s timeout window —
        // every chat turn would fail. The previous implementation
        // used `wait_with_output()` which closes stdin implicitly;
        // the manual `child.wait()` path doesn't.
    }

    let stdout = child.stdout.take().ok_or("no stdout handle")?;
    let stderr = child.stderr.take().ok_or("no stderr handle")?;

    // Bound the subprocess lifetime. A hung `claude` (model stall,
    // network blip, stuck stdin) would otherwise pin the ticket at
    // `agent-responding` forever and tie up the request indefinitely.
    // 90s covers a long-but-normal agent turn (KB read + reasoning);
    // anything past that the admin should handle, and the caller
    // surfaces the timeout as an escalation so the user isn't blocked.
    const CLAUDE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);

    let stream_task = parse_stream_json(stdout, persister);
    let stderr_task = collect_stderr(stderr);
    let wait_task = child.wait();

    // Drive all three (stdout parse, stderr collect, child wait) as
    // a single bounded future. `tokio::join!` waits for ALL three to
    // finish before returning — but in the normal case that's exactly
    // what we want: claude exits, its stdout/stderr pipes close, both
    // readers drain to EOF, child.wait() reaps the process, and we
    // get a complete trace. The 90s `tokio::time::timeout` is the
    // only escape hatch for a hung subprocess (since `kill_on_drop`
    // reaps it on timeout, the pipe-readers will drop too).
    let combined = async move {
        let (parse_result, stderr_text, wait_result) =
            tokio::join!(stream_task, stderr_task, wait_task);
        (parse_result, stderr_text, wait_result)
    };
    let (parse_result, stderr_text, wait_result) =
        match tokio::time::timeout(CLAUDE_TIMEOUT, combined).await {
            Ok(triple) => triple,
            Err(_) => {
                return Err(format!(
                    "claude -p timed out after {}s",
                    CLAUDE_TIMEOUT.as_secs()
                ));
            }
        };

    let exit_status = wait_result.map_err(|e| format!("wait claude: {}", e))?;
    if !exit_status.success() {
        return Err(format!(
            "claude exited {} — stderr: {}",
            exit_status, stderr_text
        ));
    }

    let parse = parse_result.map_err(|e| format!("read claude stdout: {}", e))?;
    if parse.reply.trim().is_empty() {
        return Err("claude returned empty output".to_string());
    }
    Ok(ChatTurnOutput {
        reply: parse.reply,
        events: parse.events,
    })
}

/// Read the child's stderr to completion. Used for diagnostics on a
/// non-zero exit only — we don't surface stderr lines on the happy
/// path since stream-json carries everything we need.
async fn collect_stderr<R: tokio::io::AsyncRead + Unpin>(reader: R) -> String {
    use tokio::io::AsyncReadExt;
    let mut buf = String::new();
    let mut r = reader;
    let _ = r.read_to_string(&mut buf).await;
    buf
}

struct StreamParseResult {
    reply: String,
    events: Vec<crate::agent_trace::TraceEvent>,
}

/// Owns the per-turn trace-file path + metadata, and writes the
/// partial timeline to disk after each event the parser sees. This
/// is what makes the click-from-banner viewer surface *live* —
/// the file changes during the turn, the fs-watcher fires, and the
/// viewer re-reads it on each tick. The final `persist_trace` call
/// in `chat_turn` overwrites this with the dispatched outcome
/// (answered / escalated / resolved).
struct LiveTracePersister {
    repo: std::path::PathBuf,
    ticket_id: String,
    turn_id: String,
    started_at: String,
    model: String,
}

impl LiveTracePersister {
    async fn write_partial(&self, events: &[crate::agent_trace::TraceEvent]) {
        let doc = crate::agent_trace::TraceDoc {
            ticket_id: self.ticket_id.clone(),
            turn_id: self.turn_id.clone(),
            started_at: self.started_at.clone(),
            // `completed_at` is meaningless mid-turn; we reuse the
            // field as "last update" so the viewer shows a clock
            // that ticks forward as the agent works.
            completed_at: now_iso(),
            model: self.model.clone(),
            outcome: "in_progress".to_string(),
            events: events.to_vec(),
        };
        // Best-effort. A failed live write is recoverable: the final
        // `persist_trace` in `chat_turn` will land the complete doc
        // either way; a skipped intermediate just means the viewer
        // doesn't refresh that one tick.
        let _ = crate::agent_trace::persist_trace(&self.repo, &doc).await;
    }
}

/// Parse claude's `--output-format stream-json` ndjson stream into
/// a normalized timeline of `TraceEvent`s plus the final reply text.
///
/// Event shape (claude wire format, abbreviated):
///   `{"type":"system","subtype":"init",...}`               — ignored
///   `{"type":"assistant","message":{"content":[
///       {"type":"text","text":"…"},
///       {"type":"tool_use","name":"Read","input":{…}}
///   ],...}}`
///   `{"type":"user","message":{"content":[
///       {"type":"tool_result","tool_use_id":"…","content":"…"}
///   ]}}`
///   `{"type":"result","subtype":"success","result":"…"}`   — final reply
///
/// We pull tool_use blocks out of assistant messages (one TraceEvent
/// per call) and use the `result.result` field as the reply. Text
/// blocks inside intermediate assistant messages are recorded as
/// `kind="text"` events but NOT used as the reply — claude
/// occasionally emits a "draft" block before tool calls; relying on
/// the explicit `result` event is safer.
async fn parse_stream_json<R: tokio::io::AsyncRead + Unpin>(
    reader: R,
    persister: Option<&LiveTracePersister>,
) -> Result<StreamParseResult, std::io::Error> {
    use crate::agent_trace::{verb_for_tool, TraceEvent};
    let mut events: Vec<TraceEvent> = Vec::new();
    let mut reply: Option<String> = None;
    let mut buf_reader = BufReader::new(reader);
    let mut line = String::new();
    loop {
        let events_before = events.len();
        line.clear();
        let n = buf_reader.read_line(&mut line).await?;
        if n == 0 {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parsed: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => {
                events.push(TraceEvent {
                    ts: now_iso(),
                    kind: "raw".to_string(),
                    tool: None,
                    verb: None,
                    raw: Some(serde_json::Value::String(trimmed.to_string())),
                    text: None,
                });
                continue;
            }
        };
        let kind = parsed
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        match kind.as_str() {
            "system" => {
                // `system/init` carries session metadata; not useful
                // for the audit timeline.
            }
            "assistant" => {
                let content = parsed
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_array());
                if let Some(blocks) = content {
                    for block in blocks {
                        let btype = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
                        match btype {
                            "tool_use" => {
                                let tool = block
                                    .get("name")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                let input = block
                                    .get("input")
                                    .cloned()
                                    .unwrap_or(serde_json::Value::Null);
                                let verb = verb_for_tool(&tool, &input).or_else(|| {
                                    if !tool.is_empty() {
                                        Some(format!("Running {}", tool))
                                    } else {
                                        None
                                    }
                                });
                                events.push(TraceEvent {
                                    ts: now_iso(),
                                    kind: "tool_use".to_string(),
                                    tool: Some(tool),
                                    verb,
                                    raw: Some(input),
                                    text: None,
                                });
                            }
                            "text" => {
                                if let Some(t) = block
                                    .get("text")
                                    .and_then(|v| v.as_str())
                                    .filter(|s| !s.trim().is_empty())
                                {
                                    events.push(TraceEvent {
                                        ts: now_iso(),
                                        kind: "text".to_string(),
                                        tool: None,
                                        verb: None,
                                        raw: None,
                                        text: Some(t.to_string()),
                                    });
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
            "user" => {
                // tool_result blocks live under user messages. Worth
                // keeping in the audit trail for "Read returned 0
                // matches" debugging, but we record only that they
                // happened — the full payload would balloon the
                // trace file.
                let content = parsed
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_array());
                if let Some(blocks) = content {
                    for block in blocks {
                        if block.get("type").and_then(|v| v.as_str()) == Some("tool_result") {
                            // Keep only `tool_use_id` so the UI can
                            // pair the result back to its tool_use
                            // event. The full `content` payload (file
                            // bodies, KB articles, grep matches) is
                            // intentionally dropped — including it
                            // here would balloon trace files into MB.
                            let tool_use_id = block
                                .get("tool_use_id")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string());
                            events.push(TraceEvent {
                                ts: now_iso(),
                                kind: "tool_result".to_string(),
                                tool: None,
                                verb: None,
                                raw: None,
                                text: tool_use_id,
                            });
                        }
                    }
                }
            }
            "result" => {
                if let Some(text) = parsed.get("result").and_then(|v| v.as_str()) {
                    reply = Some(text.to_string());
                }
                events.push(TraceEvent {
                    ts: now_iso(),
                    kind: "result".to_string(),
                    tool: None,
                    verb: None,
                    raw: Some(parsed.clone()),
                    text: parsed
                        .get("result")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                });
            }
            _ => {
                // Unknown event types — preserve verbatim so future
                // claude versions don't lose audit info silently.
                events.push(TraceEvent {
                    ts: now_iso(),
                    kind: "raw".to_string(),
                    tool: None,
                    verb: None,
                    raw: Some(parsed),
                    text: None,
                });
            }
        }
        // Persist a partial trace after each iteration that produced
        // new events, so the desktop viewer (which re-reads on every
        // fs-watcher tick) shows live progress as the agent works
        // rather than a single dump at the end of the turn.
        if events.len() > events_before {
            if let Some(p) = persister {
                p.write_partial(&events).await;
            }
        }
    }
    Ok(StreamParseResult {
        reply: reply.unwrap_or_default(),
        events,
    })
}

/// Read `databases/tickets/<ticket_id>.json` and return the `status`
/// field. Returns None if the file doesn't exist (agent hasn't
/// committed a ticket yet) or can't be parsed.
async fn read_ticket_status(repo: &Path, ticket_id: &str) -> Option<String> {
    let path = repo
        .join("databases")
        .join("tickets")
        .join(format!("{}.json", ticket_id));
    let raw = tokio::fs::read_to_string(&path).await.ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    parsed
        .get("status")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Set the ticket's status field. Used to flip to `agent-responding`
/// before invoking claude -p (so the activity banner shows) and to
/// flip back to `escalated` if claude errors out. No-op if the ticket
/// file doesn't exist yet.
async fn mark_status(repo: &Path, ticket_id: &str, status: &str) -> Result<(), String> {
    let path = repo
        .join("databases")
        .join("tickets")
        .join(format!("{}.json", ticket_id));
    let raw = match tokio::fs::read_to_string(&path).await {
        Ok(s) => s,
        Err(_) => return Ok(()), // ticket doesn't exist yet — fine
    };
    let mut parsed: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse ticket: {}", e))?;
    if let Some(obj) = parsed.as_object_mut() {
        obj.insert(
            "status".to_string(),
            serde_json::Value::String(status.to_string()),
        );
        obj.insert(
            "updatedAt".to_string(),
            serde_json::Value::String(now_iso()),
        );
    }
    let json =
        serde_json::to_string_pretty(&parsed).map_err(|e| format!("serialize ticket: {}", e))?;
    tokio::fs::write(&path, json)
        .await
        .map_err(|e| format!("write ticket: {}", e))?;
    Ok(())
}

/// Ensure the ticket + asker turn + people row exist, marked
/// `agent-responding`. Same writes the old form-intake handler did,
/// reused for every chat turn so the admin sees activity from the
/// moment the user hits Send. Idempotent: on subsequent turns the
/// ticket already exists, so we only flip status + append a new
/// asker turn, and update the ticket's `updatedAt` field.
async fn ensure_responding_stub(
    repo: &Path,
    ticket_id: &str,
    email: &str,
    user_message: &str,
    attachments: &[String],
    transport: &TransportMeta,
) -> Result<(), String> {
    let now = now_iso();
    let ticket_path = repo
        .join("databases")
        .join("tickets")
        .join(format!("{}.json", ticket_id));

    // First turn: write the ticket fresh. The transport stamp lands
    // here once and never changes — subsequent turns hit the `else`
    // branch below and only flip status, leaving `askerChannel` and
    // any transport-specific fields untouched.
    if !ticket_path.exists() {
        let subject = first_line_truncated(user_message, 80);
        let asker_channel = match transport {
            TransportMeta::Chat => "chat",
            TransportMeta::Slack { .. } => "slack",
        };
        let mut row = serde_json::json!({
            "subject": subject,
            "description": user_message,
            "asker": email,
            "askerChannel": asker_channel,
            "status": "agent-responding",
            "priority": "normal",
            "tags": [],
            "createdAt": now,
            "updatedAt": now,
        });
        if let TransportMeta::Slack {
            workspace_id,
            channel_id,
            user_id,
        } = transport
        {
            if let Some(obj) = row.as_object_mut() {
                obj.insert(
                    "slackWorkspaceId".to_string(),
                    serde_json::Value::String(workspace_id.clone()),
                );
                obj.insert(
                    "slackChannelId".to_string(),
                    serde_json::Value::String(channel_id.clone()),
                );
                obj.insert(
                    "slackUserId".to_string(),
                    serde_json::Value::String(user_id.clone()),
                );
            }
        }
        let json =
            serde_json::to_string_pretty(&row).map_err(|e| format!("serialize ticket: {}", e))?;
        if let Some(parent) = ticket_path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("mkdir tickets: {}", e))?;
        }
        tokio::fs::write(&ticket_path, json)
            .await
            .map_err(|e| format!("write ticket: {}", e))?;
    } else {
        // Subsequent turn: always flip to `agent-responding` — even
        // for terminal-state follow-ups (resolved / closed). The
        // earlier "skip if terminal" policy left a resolved ticket
        // pinned at `resolved` on a follow-up like "wait it broke
        // again", so the admin's banner never fired. Now the lifecycle
        // is self-healing: the agent reads the new asker turn, decides
        // an outcome (`answered` / `resolved` / `escalated`), and the
        // dispatcher above flips status accordingly. A "thanks again!"
        // round-trips back to `resolved`; a regression report flips to
        // `escalated`.
        let _ = mark_status(repo, ticket_id, "agent-responding").await;
    }

    // Append the asker's turn for this message.
    let conv_dir = repo.join("databases").join("conversations").join(ticket_id);
    tokio::fs::create_dir_all(&conv_dir)
        .await
        .map_err(|e| format!("mkdir conv: {}", e))?;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let rand4: String = Uuid::new_v4()
        .simple()
        .to_string()
        .chars()
        .take(4)
        .collect();
    let msg_id = format!("msg-{}-{}", now_ms, rand4);
    let mut msg = serde_json::json!({
        "id": msg_id,
        "ticketId": ticket_id,
        "role": "asker",
        "sender": email,
        "timestamp": now,
        "body": user_message,
    });
    if !attachments.is_empty() {
        msg.as_object_mut()
            .expect("constructed json object literal")
            .insert(
                "attachments".to_string(),
                serde_json::Value::Array(
                    attachments
                        .iter()
                        .map(|s| serde_json::Value::String(s.clone()))
                        .collect(),
                ),
            );
    }
    let msg_json =
        serde_json::to_string_pretty(&msg).map_err(|e| format!("serialize asker turn: {}", e))?;
    let msg_path = conv_dir.join(format!("{}.json", msg_id));
    tokio::fs::write(&msg_path, msg_json)
        .await
        .map_err(|e| format!("write asker turn: {}", e))?;

    // Idempotent people row.
    let _ = ensure_people_row(repo, email, &now).await;
    Ok(())
}

fn unix_now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Drop sessions older than `SESSION_IDLE_TTL_SECS`, then trim back
/// to `SESSION_MAX_ENTRIES` by oldest-first if we're still over the
/// cap. Called from /chat/start under the sessions lock.
fn evict_idle_sessions(sessions: &mut HashMap<String, SessionData>) {
    let now = unix_now_secs();
    sessions.retain(|_, s| now.saturating_sub(s.last_seen_unix) < SESSION_IDLE_TTL_SECS);
    if sessions.len() <= SESSION_MAX_ENTRIES {
        return;
    }
    // Sort entries by last_seen ascending and drop the oldest.
    let mut by_age: Vec<(String, u64)> = sessions
        .iter()
        .map(|(k, v)| (k.clone(), v.last_seen_unix))
        .collect();
    by_age.sort_by_key(|(_, ls)| *ls);
    let drop_count = sessions.len() - SESSION_MAX_ENTRIES;
    for (k, _) in by_age.into_iter().take(drop_count) {
        sessions.remove(&k);
    }
}

/// The agent's per-turn outcome, parsed out of stdout. Three valid
/// outcomes:
///   `Answered`  — KB hit, replied. Ticket → `open` (alive).
///   `Resolved`  — asker confirmed case done. Ticket → `resolved`
///                 (terminal; reopens automatically if the asker
///                 sends another message).
///   `Escalated` — KB miss / needs human. Ticket → `escalated`.
///
/// The `Clarifying` variant is kept only for backwards compatibility
/// with any in-flight legacy skill — it is treated as Escalated so
/// the banner clears and the admin gets visibility instead of
/// leaving the ticket stuck.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DecidedStatus {
    /// KB hit — the agent answered. Ticket → `open`.
    Answered,
    /// Asker confirmed the case is done. Ticket → `resolved` (terminal).
    Resolved,
    /// KB miss / can't help — admin needs to respond. Ticket → `escalated`.
    Escalated,
    /// Legacy: agent asked for clarification. Treated as Escalated by
    /// the dispatcher so a stale skill doesn't pin the banner.
    Clarifying,
}

/// Parse the agent's status marker out of its stdout. Contract:
/// the marker is `<<STATUS:answered>>` (KB hit, ticket → open),
/// `<<STATUS:resolved>>` (asker confirmed case done, ticket →
/// resolved), or `<<STATUS:escalated>>` (KB miss, ticket →
/// escalated) somewhere in the output (typically last line).
/// Returns the body with ALL marker spans stripped, plus the
/// status from the LAST marker (the agent's final decision wins).
/// Missing or unrecognized marker → Escalated, so the admin always
/// gets visibility on a malformed agent run.
fn parse_status_marker(raw: &str) -> (String, DecidedStatus) {
    let spans = regex_lite_find_all(raw);
    if spans.is_empty() {
        return (raw.trim().to_string(), DecidedStatus::Escalated);
    }
    // Stitch together the body with each marker span removed.
    let mut body = String::with_capacity(raw.len());
    let mut cursor = 0usize;
    for (_, start, end) in &spans {
        body.push_str(&raw[cursor..*start]);
        cursor = *end;
    }
    body.push_str(&raw[cursor..]);
    let final_status = spans
        .last()
        .map(|(s, _, _)| *s)
        .unwrap_or(DecidedStatus::Escalated);
    (body.trim().to_string(), final_status)
}

/// Tiny hand-rolled scanner for `<<STATUS:xxx>>` so we don't pull in
/// the `regex` crate just for this. Returns (status, start, end) for
/// every recognized marker in `s`, in order. Tolerates surrounding
/// whitespace inside the marker (e.g. `<<STATUS: resolved >>`).
fn regex_lite_find_all(s: &str) -> Vec<(DecidedStatus, usize, usize)> {
    let needle_open = "<<STATUS:";
    let needle_close = ">>";
    let mut found: Vec<(DecidedStatus, usize, usize)> = Vec::new();
    let mut search_from = 0;
    while let Some(rel_open) = s[search_from..].find(needle_open) {
        let open = search_from + rel_open;
        let after_open = open + needle_open.len();
        let Some(rel_close) = s[after_open..].find(needle_close) else {
            break;
        };
        let close = after_open + rel_close;
        let value = s[after_open..close].trim().to_ascii_lowercase();
        let status = match value.as_str() {
            "answered" => Some(DecidedStatus::Answered),
            "resolved" => Some(DecidedStatus::Resolved),
            "escalated" => Some(DecidedStatus::Escalated),
            "clarifying" => Some(DecidedStatus::Clarifying),
            _ => None,
        };
        if let Some(st) = status {
            // Consume a trailing newline so the stripped body doesn't
            // leave a dangling blank line.
            let mut end = close + needle_close.len();
            if s.as_bytes().get(end) == Some(&b'\n') {
                end += 1;
            }
            // And consume a leading newline so we don't leave a blank
            // line where the marker was.
            let mut start = open;
            if start > 0 && s.as_bytes()[start - 1] == b'\n' {
                start -= 1;
            }
            found.push((st, start, end));
        }
        search_from = close + needle_close.len();
    }
    found
}

/// ISO-8601 UTC timestamp ~1 second before now, used as the polled_at
/// returned to the chat client so subsequent /chat/poll's `since`
/// filter doesn't drop turns whose timestamp is the same wall-clock
/// second as the response. Client de-dupes via seenTurnKeys.
fn iso_one_second_ago() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs().saturating_sub(1))
        .unwrap_or(0);
    let (y, mo, d, h, mi, s) = unix_to_ymdhms(secs as i64);
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, mo, d, h, mi, s)
}

/// Write the agent's reply turn to
/// `databases/conversations/<ticket_id>/msg-*.json`. Sender is
/// hardcoded to `triage` so the admin sees a stable label instead
/// of whatever the agent decides to call itself.
async fn write_agent_turn(repo: &Path, ticket_id: &str, body: &str) -> Result<(), String> {
    let conv_dir = repo.join("databases").join("conversations").join(ticket_id);
    tokio::fs::create_dir_all(&conv_dir)
        .await
        .map_err(|e| format!("mkdir conv: {}", e))?;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let rand4: String = Uuid::new_v4()
        .simple()
        .to_string()
        .chars()
        .take(4)
        .collect();
    let msg_id = format!("msg-{}-{}", now_ms, rand4);
    let msg = serde_json::json!({
        "id": msg_id,
        "ticketId": ticket_id,
        "role": "agent",
        "sender": "triage",
        "timestamp": now_iso(),
        "body": body,
    });
    let msg_json =
        serde_json::to_string_pretty(&msg).map_err(|e| format!("serialize agent turn: {}", e))?;
    let msg_path = conv_dir.join(format!("{}.json", msg_id));
    tokio::fs::write(&msg_path, msg_json)
        .await
        .map_err(|e| format!("write agent turn: {}", e))?;
    Ok(())
}

/// Stage and commit the per-turn intake writes (ticket file,
/// conversation thread, people row) so they don't surface as
/// uncommitted noise in the admin's Versions panel. Errors are
/// non-fatal — the writes already landed on disk; a missed commit
/// just means the next chat turn (or a manual commit) will sweep
/// them up.
///
/// `git_commit_paths` is a sync function that shells out to `git`,
/// so we run it on the blocking pool. The cost is negligible
/// compared to the ~3-5s claude-p turn it follows.
async fn auto_commit_chat_turn(repo: &Path, ticket_id: &str, email: &str) {
    let repo_str = repo.to_string_lossy().into_owned();
    let people_key = sanitize_email_key(email);
    // Pass the conversation directory rather than each individual
    // msg-*.json file: `git add -- <dir>` picks up the asker's turn
    // AND the agent's reply written later in the same handler. If the
    // ticket or people row didn't change (e.g. terminal-state
    // follow-up that skipped mark_status), `git diff --cached` will
    // simply find no changes for them and the commit shrinks to
    // whatever did move.
    let paths = vec![
        format!("databases/tickets/{}.json", ticket_id),
        format!("databases/conversations/{}", ticket_id),
        format!("databases/people/{}.json", people_key),
    ];
    let message = format!("intake: chat turn for ticket {}", ticket_id);
    match tokio::task::spawn_blocking(move || {
        crate::git_ops::git_commit_paths(repo_str, paths, message)
    })
    .await
    {
        Err(join_err) => eprintln!("[intake/chat] auto_commit join error: {}", join_err),
        Ok(Err(commit_err)) => eprintln!("[intake/chat] auto_commit failed: {}", commit_err),
        Ok(Ok(_)) => {}
    }
}

fn first_line_truncated(s: &str, max: usize) -> String {
    let line = s.lines().next().unwrap_or(s).trim();
    if line.chars().count() <= max {
        line.to_string()
    } else {
        let mut out: String = line.chars().take(max - 1).collect();
        out.push('…');
        out
    }
}

/// Idempotent people row at `databases/people/<sanitized-email>.json`.
/// Skips if a row with the same key already exists.
async fn ensure_people_row(repo: &std::path::Path, email: &str, now: &str) -> Result<(), String> {
    let people_dir = repo.join("databases").join("people");
    tokio::fs::create_dir_all(&people_dir)
        .await
        .map_err(|e| format!("mkdir people: {}", e))?;

    let key = sanitize_email_key(email);
    let path = people_dir.join(format!("{}.json", key));
    if tokio::fs::try_exists(&path).await.unwrap_or(false) {
        return Ok(());
    }
    let row = serde_json::json!({
        "displayName": email,
        "email": email,
        "channels": [format!("chat:{}", email)],
        "createdAt": now,
        "updatedAt": now,
    });
    let json =
        serde_json::to_string_pretty(&row).map_err(|e| format!("serialize people row: {}", e))?;
    tokio::fs::write(&path, json)
        .await
        .map_err(|e| format!("write people row: {}", e))?;
    Ok(())
}

fn sanitize_email_key(email: &str) -> String {
    email
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Origin / CSRF check — same approach as the dropped form route.
// ---------------------------------------------------------------------------

fn origin_is_localhost(headers: &HeaderMap) -> bool {
    let candidate = headers
        .get("origin")
        .or_else(|| headers.get("referer"))
        .and_then(|v| v.to_str().ok());
    let Some(s) = candidate else { return false };
    let Ok(url) = reqwest::Url::parse(s) else {
        return false;
    };
    match url.host() {
        // `localhost` plus the active public-tunnel host (if any). The
        // tunnel module narrows the allowlist to *exactly* the current
        // session's subdomain — we don't blanket-trust `*.lhr.life`,
        // since other localhost.run users could otherwise CSRF us.
        Some(url::Host::Domain(d)) => {
            d == "localhost" || crate::tunnel::current_tunnel_host().as_deref() == Some(d)
        }
        Some(url::Host::Ipv4(addr)) => addr.is_loopback(),
        Some(url::Host::Ipv6(addr)) => addr.is_loopback(),
        None => false,
    }
}

// ---------------------------------------------------------------------------
// Misc helpers — id + timestamp.
// ---------------------------------------------------------------------------

/// Generate a ticket id matching the system convention:
/// `<isoTimestamp-with-dashes>-<rand4>`. Filesystem-safe, lex-sortable,
/// datetime-readable.
fn generate_ticket_id() -> String {
    let rand4: String = Uuid::new_v4()
        .simple()
        .to_string()
        .chars()
        .take(4)
        .collect();
    format!("{}-{}", now_iso().replace(':', "-"), rand4)
}

/// Minimal RFC-3339 "now" without pulling chrono. Same algorithm as
/// the prior implementation; ported here so the chat path is
/// self-contained.
fn now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (y, mo, d, h, mi, s) = unix_to_ymdhms(secs);
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, mo, d, h, mi, s)
}

fn unix_to_ymdhms(secs: i64) -> (i32, u32, u32, u32, u32, u32) {
    let days = secs.div_euclid(86_400);
    let mut s_of_day = secs.rem_euclid(86_400) as u32;
    let h = s_of_day / 3600;
    s_of_day %= 3600;
    let mi = s_of_day / 60;
    let s = s_of_day % 60;
    let z = days + 719_468;
    let era = if z >= 0 {
        z / 146_097
    } else {
        (z - 146_096) / 146_097
    };
    let doe = (z - era * 146_097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    (y as i32, mo, d, h, mi, s)
}

// ---------------------------------------------------------------------------
// Chat UI — single-page HTML. Plain-old DOM + fetch; no framework.
// ---------------------------------------------------------------------------

const CHAT_HTML: &str = r#"<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenIT — Help Desk</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
.gate {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
}
.gate form {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 32px;
  max-width: 420px;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.gate h2 { margin: 0; font-size: 18px; font-weight: 600; }
.gate p { margin: 0; color: var(--text-muted); font-size: 13px; }
.gate label {
  display: block;
  margin-top: 8px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-muted);
}
.gate input[type=email] {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 14px;
  font-family: inherit;
  box-sizing: border-box;
}
.gate button {
  margin-top: 8px;
}
.gate-error {
  color: #c0392b;
  font-size: 12px;
  margin: 0;
}
.gate-not-you {
  background: transparent;
  border: 0;
  padding: 4px 0 0;
  margin: 0;
  font: inherit;
  font-size: 12px;
  color: var(--text-muted);
  text-decoration: underline;
  cursor: pointer;
  align-self: center;
}
.gate-not-you:hover { color: var(--text); }
/* Make the HTML `hidden` attribute win against display:flex on
   chat/form/banner — those have explicit display rules in the main
   stylesheet that would otherwise override the user agent's hidden
   { display: none } default. */
[hidden] { display: none !important; }
</style>
<style>
:root {
  /* Mirrors the desktop app's design tokens (src/App.css):
     cream background + clay/orange accent + warm beige borders. */
  --bg: #fbf7ec;
  --bg-canvas: #f7f1e1;
  --surface: #ffffff;
  --surface-soft: #f5edd8;
  --border: #e7decb;
  --border-strong: #cfc3a3;
  --text: #25201a;
  --text-muted: #67604f;
  --text-faint: #978d76;
  --accent: #c75a2c;
  --accent-hover: #ad4a22;
  --accent-soft: #f5d9c2;
  --accent-faint: #fbeede;
  --r-sm: 4px;
  --r-md: 6px;
  --r-lg: 10px;
  --r-xl: 16px;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  color: var(--text);
  font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
header {
  padding: 12px 20px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}
header h1 { margin: 0; font-size: 16px; font-weight: 600; }
header p { margin: 4px 0 0; color: var(--text-muted); font-size: 12px; }
#chat {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.bubble {
  max-width: 75%;
  padding: 10px 14px;
  border-radius: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}
.bubble.user {
  align-self: flex-end;
  background: var(--accent-soft);
  border: 1px solid var(--accent-soft);
  border-top-right-radius: 2px;
}
.bubble.assistant, .bubble.admin {
  align-self: flex-start;
  background: var(--surface);
  border: 1px solid var(--border);
  border-top-left-radius: 2px;
}
.bubble .meta {
  display: block;
  font-size: 10px;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 4px;
}
.typing {
  align-self: flex-start;
  color: var(--text-faint);
  font-style: italic;
  font-size: 12px;
  padding: 4px 14px;
}
form {
  display: flex;
  gap: 8px;
  padding: 12px 20px;
  border-top: 1px solid var(--border);
  background: var(--surface);
}
input[type=text] {
  flex: 1;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 14px;
  font-family: inherit;
}
button {
  padding: 10px 18px;
  background: var(--accent);
  color: white;
  border: 0;
  border-radius: var(--r-md);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.1s ease, transform 0.05s ease;
}
button:hover:not(:disabled) { background: var(--accent-hover); transform: translateY(-1px); }
button:disabled { opacity: 0.5; cursor: not-allowed; }
.status-banner {
  padding: 8px 20px;
  font-size: 12px;
  background: var(--accent-soft);
  border-bottom: 1px solid var(--accent-soft);
  color: var(--accent);
}
.status-banner.escalated {
  background: var(--accent-faint);
  border-color: var(--accent-soft);
  color: var(--accent-hover);
}
.status-banner:empty { display: none; }
/* --- Attachments --- */
.bubble .attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}
.bubble .attachments img {
  max-width: 240px;
  max-height: 240px;
  border-radius: 8px;
  border: 1px solid var(--border);
  object-fit: cover;
  cursor: zoom-in;
}
.bubble .attachments a.attach-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  font-size: 12px;
  border-radius: 6px;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--text);
  text-decoration: none;
}
.bubble .attachments a.attach-link:hover {
  background: var(--accent-soft);
  border-color: var(--accent-soft);
}
.bubble .attachments .attach-icon { font-size: 14px; }
form {
  position: relative;
}
form.drag-over {
  background: var(--accent-soft);
  outline: 2px dashed var(--accent-soft);
  outline-offset: -4px;
}
.compose-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0 20px 6px;
  background: var(--surface);
  border-top: 1px solid var(--border);
}
.compose-chips:empty { display: none; }
.compose-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  font-size: 11px;
  background: var(--accent-soft);
  border: 1px solid var(--accent-soft);
  border-radius: 999px;
  max-width: 200px;
}
.compose-chip-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.compose-chip-status {
  color: var(--text-muted);
  font-size: 10px;
}
.compose-chip-remove {
  background: transparent;
  border: 0;
  padding: 0 0 0 4px;
  font-size: 14px;
  line-height: 1;
  color: var(--text-muted);
  cursor: pointer;
}
.compose-chip-remove:hover { color: var(--text); }
.attach-btn {
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--text-muted);
  padding: 0 12px;
  border-radius: 8px;
  font-size: 16px;
  cursor: pointer;
}
.attach-btn:hover { background: var(--accent-soft); color: var(--text); }
</style>
</head>
<body>
<header>
  <h1>OpenIT — Help Desk</h1>
  <p>Describe your issue. The agent will try to help, or escalate to a human.</p>
</header>

<!-- Gate: collect email before starting the chat. Hidden once the
     session is created. -->
<div class="gate" id="gate">
  <form id="gateForm">
    <h2>Before we start</h2>
    <p>What's your email? The IT admin uses this to follow up if your question needs a human.</p>
    <label for="email">Email</label>
    <input id="email" name="email" type="email" autocomplete="email" placeholder="you@company.com" required>
    <p class="gate-error" id="gateError"></p>
    <button type="submit">Start chat</button>
  </form>
</div>

<!-- Chat surface — hidden until the gate is satisfied. -->
<div class="status-banner" id="banner" hidden></div>
<div id="chat" hidden></div>
<div class="compose-chips" id="chips" hidden></div>
<form id="form" hidden>
  <button type="button" class="attach-btn" id="attachBtn" title="Attach a file">📎</button>
  <input id="fileInput" type="file" multiple hidden>
  <input id="msg" type="text" placeholder="Type your message…" autocomplete="off">
  <button type="submit" id="send">Send</button>
</form>
<script>
let sessionId = null;
let ticketId = null;
let userEmail = null;
let lastSeen = '';
let pollTimer = null;
const seenTurnKeys = new Set();
const chat = document.getElementById('chat');
const form = document.getElementById('form');
const input = document.getElementById('msg');
const sendBtn = document.getElementById('send');
const banner = document.getElementById('banner');
const gate = document.getElementById('gate');
const gateForm = document.getElementById('gateForm');
const emailInput = document.getElementById('email');
const gateError = document.getElementById('gateError');
const chipsBar = document.getElementById('chips');
const fileInput = document.getElementById('fileInput');
const attachBtn = document.getElementById('attachBtn');

// Pending attachments awaiting Send. Each entry tracks its upload
// state so the chip renders accurately and the submit handler only
// includes successfully-uploaded paths. Browser-native File objects
// are stashed for retry on transient failures.
const pendingAttachments = [];

function renderChips() {
  chipsBar.innerHTML = '';
  if (pendingAttachments.length === 0) {
    chipsBar.hidden = true;
    return;
  }
  chipsBar.hidden = false;
  for (const att of pendingAttachments) {
    const chip = document.createElement('span');
    chip.className = 'compose-chip';
    const name = document.createElement('span');
    name.className = 'compose-chip-name';
    name.textContent = att.filename;
    chip.appendChild(name);
    if (att.status !== 'ready') {
      const status = document.createElement('span');
      status.className = 'compose-chip-status';
      status.textContent = att.status;
      chip.appendChild(status);
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'compose-chip-remove';
    remove.title = 'Remove';
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      const idx = pendingAttachments.indexOf(att);
      if (idx >= 0) pendingAttachments.splice(idx, 1);
      renderChips();
    });
    chip.appendChild(remove);
    chipsBar.appendChild(chip);
  }
}

async function uploadOne(att) {
  const fd = new FormData();
  fd.append('session_id', sessionId);
  fd.append('file', att.file, att.filename);
  try {
    const r = await fetch('/chat/upload', { method: 'POST', body: fd });
    if (!r.ok) {
      const txt = await r.text();
      att.status = 'failed: ' + (txt || r.status);
      renderChips();
      return;
    }
    const j = await r.json();
    att.path = j.path;
    att.filename = j.filename;
    att.status = 'ready';
  } catch (e) {
    att.status = 'failed: network';
  }
  renderChips();
}

function addFiles(files) {
  if (!sessionId) return;
  for (const file of files) {
    const att = {
      file,
      filename: file.name || 'upload',
      status: 'uploading…',
      path: null,
    };
    pendingAttachments.push(att);
    void uploadOne(att);
  }
  renderChips();
}

function isImagePath(p) {
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(p);
}

function attachmentUrl(path) {
  return '/chat/file?session_id=' + encodeURIComponent(sessionId) + '&path=' + encodeURIComponent(path);
}

function basenameFromPath(p) {
  const slash = p.lastIndexOf('/');
  return slash >= 0 ? p.slice(slash + 1) : p;
}

function renderAttachmentsInto(el, attachments) {
  if (!attachments || attachments.length === 0) return;
  const wrap = document.createElement('div');
  wrap.className = 'attachments';
  for (const path of attachments) {
    if (isImagePath(path)) {
      const img = document.createElement('img');
      img.src = attachmentUrl(path);
      img.alt = basenameFromPath(path);
      img.title = basenameFromPath(path);
      img.addEventListener('click', () => {
        // Clicking an inline image opens it full-size in a new tab
        // so the asker can pinch-zoom on phones / inspect details.
        window.open(img.src, '_blank');
      });
      wrap.appendChild(img);
    } else {
      const link = document.createElement('a');
      link.className = 'attach-link';
      link.href = attachmentUrl(path);
      link.target = '_blank';
      link.rel = 'noopener';
      const icon = document.createElement('span');
      icon.className = 'attach-icon';
      icon.textContent = '📎';
      link.appendChild(icon);
      link.appendChild(document.createTextNode(basenameFromPath(path)));
      wrap.appendChild(link);
    }
  }
  el.appendChild(wrap);
}

function bubble(role, body, sender, attachments) {
  const el = document.createElement('div');
  el.className = 'bubble ' + role;
  if (sender) {
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = sender;
    el.appendChild(meta);
  }
  if (body) el.appendChild(document.createTextNode(body));
  renderAttachmentsInto(el, attachments);
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
}

function typing() {
  const el = document.createElement('div');
  el.className = 'typing';
  el.id = 'typing';
  el.textContent = 'Agent is typing…';
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
}
function untype() {
  const el = document.getElementById('typing');
  if (el) el.remove();
}

function setBanner(status) {
  if (status === 'escalated') {
    banner.textContent = 'Your question has been escalated to a human admin. They\'ll reply here when ready.';
    banner.classList.add('escalated');
  } else if (status === 'resolved') {
    banner.textContent = 'The agent answered your question. Reply if you need anything else.';
    banner.classList.remove('escalated');
  } else {
    banner.textContent = '';
    banner.classList.remove('escalated');
  }
}

// --- Email persistence (returning-visitor convenience) ---
//
// Remember the asker's email in a long-lived cookie so a second
// visit doesn't re-prompt. Cookie is scoped to the intake server
// origin only; SameSite=Lax keeps it out of cross-site requests.
const EMAIL_COOKIE = 'openit_intake_email';
const EMAIL_COOKIE_DAYS = 365;
function setCookie(name, val, days) {
  const exp = new Date(Date.now() + days * 86400000).toUTCString();
  document.cookie = name + '=' + encodeURIComponent(val) +
    ';path=/;expires=' + exp + ';SameSite=Lax';
}
function getCookie(name) {
  const m = document.cookie.match(
    new RegExp('(?:^|; )' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)'),
  );
  return m ? decodeURIComponent(m[1]) : null;
}
function clearCookie(name) {
  document.cookie = name + '=;path=/;expires=Thu, 01 Jan 1970 00:00:00 GMT;SameSite=Lax';
}

// On load: if a remembered email exists, rewrite the gate to a
// "Welcome back" surface with one-click continue + an opt-out link.
function applyRememberedEmail() {
  const remembered = getCookie(EMAIL_COOKIE);
  if (!remembered) return;
  emailInput.value = remembered;
  // Swap the gate copy for a returning-visitor flow without
  // restructuring the form (so the existing submit handler still
  // works — it just reads the prefilled value).
  const heading = gateForm.querySelector('h2');
  const lead = gateForm.querySelector('p:not(.gate-error)');
  const submit = gateForm.querySelector('button[type=submit]');
  if (heading) heading.textContent = 'Welcome back';
  if (lead) {
    lead.innerHTML = 'Continuing as <strong></strong>.';
    lead.querySelector('strong').textContent = remembered;
  }
  if (submit) submit.textContent = 'Continue';
  // Hide the label + input — the email is already known, and the
  // "not you?" link below covers the change-of-mind case.
  emailInput.type = 'hidden';
  const label = gateForm.querySelector('label[for=email]');
  if (label) label.hidden = true;
  // Add a small secondary affordance to forget the cookie.
  if (!gateForm.querySelector('.gate-not-you')) {
    const notYou = document.createElement('button');
    notYou.type = 'button';
    notYou.className = 'gate-not-you';
    notYou.textContent = 'Use a different email';
    notYou.addEventListener('click', () => {
      clearCookie(EMAIL_COOKIE);
      window.location.reload();
    });
    gateForm.appendChild(notYou);
  }
}

async function start(email) {
  const r = await fetch('/chat/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(txt || 'failed to start session');
  }
  const j = await r.json();
  sessionId = j.session_id;
  ticketId = j.ticket_id;
  userEmail = email;
  // Persist for next visit.
  setCookie(EMAIL_COOKIE, email, EMAIL_COOKIE_DAYS);
  // Hide the gate, show the chat surface.
  gate.hidden = true;
  chat.hidden = false;
  form.hidden = false;
  banner.hidden = false;
  input.focus();
  startPolling();
}

applyRememberedEmail();

async function poll() {
  if (!sessionId) return;
  try {
    const params = new URLSearchParams({ session_id: sessionId });
    if (lastSeen) params.set('since', lastSeen);
    const r = await fetch('/chat/poll?' + params.toString());
    if (!r.ok) return;
    const j = await r.json();
    for (const t of j.turns) {
      const key = t.timestamp + '|' + t.role + '|' + t.body;
      if (seenTurnKeys.has(key)) continue;
      seenTurnKeys.add(key);
      // Only render admin / agent turns we haven't seen via the
      // direct /chat/turn response. Asker turns we already echoed
      // when the user typed. Attachments come down on the same turn
      // payload now — pass through so the bubble renders them inline.
      if (t.role === 'admin') {
        bubble('admin', t.body, t.sender || 'admin', t.attachments);
      }
      lastSeen = t.timestamp;
    }
    if (j.status) setBanner(j.status);
  } catch (e) { /* swallow — next tick will retry */ }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(poll, 1000);
}

attachBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files && fileInput.files.length > 0) {
    addFiles(Array.from(fileInput.files));
    // Reset so re-selecting the same file re-fires `change`.
    fileInput.value = '';
  }
});

// Drag-and-drop on the composer area. We treat the form as the drop
// zone (visible + always present once gate is passed). The window-
// level dragover/drop handlers prevent the browser from navigating
// to the dropped file when the user releases outside the form.
['dragover', 'dragenter'].forEach((evt) => {
  form.addEventListener(evt, (e) => {
    if (!sessionId) return;
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    form.classList.add('drag-over');
  });
});
['dragleave', 'dragend'].forEach((evt) => {
  form.addEventListener(evt, () => form.classList.remove('drag-over'));
});
form.addEventListener('drop', (e) => {
  form.classList.remove('drag-over');
  if (!sessionId) return;
  if (!e.dataTransfer || !e.dataTransfer.files) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.dataTransfer.files.length > 0) {
    addFiles(Array.from(e.dataTransfer.files));
  }
});
// Stop the browser from navigating to a dropped file outside the
// form (would replace the whole chat with a file preview).
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!sessionId) return;
  // Allow attachment-only sends (text empty + at least one ready
  // attachment). The agent skill expects SOMETHING in `body`; supply
  // a placeholder so the turn JSON stays well-formed and the agent
  // can still triage based on the attachment.
  const readyAttachments = pendingAttachments.filter((a) => a.status === 'ready' && a.path);
  if (!text && readyAttachments.length === 0) return;
  // Block send while uploads are still in flight — surfacing the
  // chip status to the user is enough; we don't want to drop their
  // attachment because they hit Send too soon.
  if (pendingAttachments.some((a) => a.status === 'uploading…')) return;

  const turnText = text || '(attachment)';
  const attachmentPaths = readyAttachments.map((a) => a.path);
  bubble('user', text, undefined, attachmentPaths);
  // Clear the composer + chips immediately. Failed attachments are
  // already filtered out (only `ready` ones are sent).
  input.value = '';
  pendingAttachments.length = 0;
  renderChips();
  sendBtn.disabled = true;
  typing();
  try {
    const r = await fetch('/chat/turn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        message: turnText,
        attachments: attachmentPaths,
      }),
    });
    untype();
    if (!r.ok) {
      const txt = await r.text();
      bubble('assistant', '⚠ Agent error: ' + txt);
      return;
    }
    const j = await r.json();
    bubble('assistant', j.reply);
    lastSeen = j.polled_at || lastSeen;
    setBanner(j.status);
  } catch (err) {
    untype();
    bubble('assistant', '⚠ Network error: ' + err.message);
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
});

gateForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  gateError.textContent = '';
  const email = emailInput.value.trim();
  if (!email || !email.includes('@')) {
    gateError.textContent = 'Please enter a valid email address.';
    return;
  }
  try {
    await start(email);
  } catch (err) {
    gateError.textContent = err.message || 'Could not start chat session.';
  }
});
</script>
</body>
</html>"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_answered_marker() {
        let raw = "Per our VPN guide, click Reset.\n\n<<STATUS:answered>>";
        let (body, status) = parse_status_marker(raw);
        assert_eq!(status, DecidedStatus::Answered);
        assert_eq!(body, "Per our VPN guide, click Reset.");
    }

    #[test]
    fn parses_resolved_marker() {
        // `resolved` is a first-class outcome — agent emits it when the
        // asker has confirmed the case is done. The dispatcher flips
        // the ticket to terminal `resolved`.
        let raw = "Glad to hear it!\n\n<<STATUS:resolved>>";
        let (body, status) = parse_status_marker(raw);
        assert_eq!(status, DecidedStatus::Resolved);
        assert_eq!(body, "Glad to hear it!");
    }

    #[test]
    fn parses_escalated_marker() {
        let raw = "I don't have an answer yet.\n<<STATUS:escalated>>\n";
        let (body, status) = parse_status_marker(raw);
        assert_eq!(status, DecidedStatus::Escalated);
        assert_eq!(body, "I don't have an answer yet.");
    }

    #[test]
    fn parses_clarifying_marker() {
        // Legacy variant — kept so older skills still parse, but the
        // dispatcher treats it the same as Escalated.
        let raw = "Which system do you mean?\n\n<<STATUS:clarifying>>";
        let (body, status) = parse_status_marker(raw);
        assert_eq!(status, DecidedStatus::Clarifying);
        assert_eq!(body, "Which system do you mean?");
    }

    #[test]
    fn missing_marker_defaults_to_escalated() {
        let raw = "Some reply with no marker.";
        let (body, status) = parse_status_marker(raw);
        assert_eq!(status, DecidedStatus::Escalated);
        assert_eq!(body, "Some reply with no marker.");
    }

    #[test]
    fn unknown_marker_value_defaults_to_escalated() {
        let raw = "reply\n<<STATUS:bogus>>";
        let (_body, status) = parse_status_marker(raw);
        assert_eq!(status, DecidedStatus::Escalated);
    }

    #[test]
    fn last_marker_wins_when_multiple_present() {
        // The agent might mention an earlier status inline; the final
        // marker is the authoritative decision.
        let raw = "I considered <<STATUS:clarifying>> but actually:\n\nHere's the answer.\n<<STATUS:answered>>";
        let (body, status) = parse_status_marker(raw);
        assert_eq!(status, DecidedStatus::Answered);
        assert!(body.contains("Here's the answer"));
        // Both markers stripped.
        assert!(!body.contains("<<STATUS:"));
    }

    #[test]
    fn marker_with_surrounding_whitespace() {
        let raw = "answer\n<<STATUS: answered >>";
        let (_body, status) = parse_status_marker(raw);
        assert_eq!(status, DecidedStatus::Answered);
    }

    #[test]
    fn iso_one_second_ago_is_lt_now() {
        let ago = iso_one_second_ago();
        let now = now_iso();
        // Lexicographic compare on ISO-8601 second-precision strings is
        // strictly less for any pair not within the same wall-clock
        // second. We can't deterministically assert <, but we can
        // assert it's no greater than now.
        assert!(ago <= now);
    }

    /// Regression: a follow-up asker turn on a `resolved` ticket must
    /// flip status back to `agent-responding` so the indicator banner
    /// fires and the agent can re-evaluate. Earlier behavior skipped
    /// the flip for terminal states, leaving a "wait it broke again"
    /// follow-up silently stuck at `resolved`.
    #[tokio::test]
    async fn ensure_responding_stub_reopens_resolved_ticket() {
        let tmp = tempfile::tempdir().expect("tmpdir");
        let repo = tmp.path();
        let ticket_id = "test-2026-04-27T18-07-02Z-reopen";
        let email = "asker@example.com";

        // Seed a resolved ticket on disk.
        let tickets_dir = repo.join("databases").join("tickets");
        std::fs::create_dir_all(&tickets_dir).unwrap();
        let ticket_path = tickets_dir.join(format!("{}.json", ticket_id));
        let row = serde_json::json!({
            "subject": "i cant login",
            "description": "i cant login",
            "asker": email,
            "askerChannel": "chat",
            "status": "resolved",
            "priority": "normal",
            "tags": [],
            "createdAt": "2026-04-27T18:07:07Z",
            "updatedAt": "2026-04-27T18:32:00Z",
        });
        std::fs::write(&ticket_path, serde_json::to_string_pretty(&row).unwrap()).unwrap();

        // Asker sends a follow-up. Pass TransportMeta::Chat to match
        // the seeded ticket's askerChannel — this argument was added
        // by the slack-channel-local branch so non-web transports
        // (Slack listener etc.) can stamp ticket provenance on first
        // turn without a follow-up Edit.
        ensure_responding_stub(
            repo,
            ticket_id,
            email,
            "wait it broke again",
            &[],
            &TransportMeta::Chat,
        )
        .await
        .expect("stub run");

        // Status should now be `agent-responding` regardless of prior
        // terminal state — the dispatcher will pick the final outcome
        // after claude -p runs.
        let status = read_ticket_status(repo, ticket_id).await;
        assert_eq!(status.as_deref(), Some("agent-responding"));
    }
}
