// Localhost ticket-intake HTTP server. Phase 5 of the local-first plan.
//
// A coworker on the same machine (or LAN, once the toggle ships in
// Phase 3b) can hit the URL surfaced in the OpenIT header, fill out a
// short form, and file a support ticket. The POST handler writes a
// row JSON with `status: "incoming"` directly into the project's
// `databases/openit-tickets-<slug>/` dir; the existing fs watcher
// notices the new file and the IncomingTicketBanner (Phase 4) fires.
//
// Bind: 127.0.0.1 with an OS-assigned port (port 0). The OS-assigned
// port avoids collisions when two OpenIT instances run on the same
// machine. The URL changes per launch — that's fine for V1; we can
// add a stable port later if it becomes a real complaint.
//
// Lifecycle: started on project open from the frontend, stopped on
// project switch / app close. Shared state holds at most one running
// server at a time; `intake_start` swaps the previous instance.
//
// Default off LAN: 127.0.0.1 only. The "Allow LAN access" toggle that
// switches the bind to 0.0.0.0 is deferred to Phase 3b's settings UI.

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Form, Router,
};
use parking_lot::Mutex;
use serde::Deserialize;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use uuid::Uuid;

#[derive(Default)]
pub struct IntakeState {
    inner: Mutex<Option<RunningServer>>,
    // Serializes the entire start/stop lifecycle so a concurrent
    // `intake_start` can't slip into the window between this call's
    // stop_inner and its store. Without this, two concurrent calls
    // can both bind a server, both spawn a task, and then race to
    // store — whichever loses the store leaks its server task with
    // no shutdown handle. tokio::sync::Mutex is async-aware and
    // safe to hold across awaits (parking_lot::Mutex is not).
    cmd_lock: tokio::sync::Mutex<()>,
}

struct RunningServer {
    addr: SocketAddr,
    shutdown: Option<oneshot::Sender<()>>,
    handle: JoinHandle<()>,
}

#[derive(Clone)]
struct ServerState {
    repo: Arc<PathBuf>,
}

#[derive(Deserialize)]
struct TicketForm {
    name: Option<String>,
    email: Option<String>,
    question: String,
}

/// Start the intake server bound to a fresh OS-assigned localhost port,
/// scoped to `repo`. If a server is already running, stop it first
/// (simulating project switch).
///
/// Returns the URL clients should use (e.g. `http://127.0.0.1:54123`).
#[tauri::command]
pub async fn intake_start(
    state: tauri::State<'_, IntakeState>,
    repo: String,
) -> Result<String, String> {
    let repo_path = PathBuf::from(&repo);
    if !repo_path.is_dir() {
        return Err(format!("intake_start: not a directory: {}", repo));
    }

    // Hold the command lock for the whole start sequence so a
    // concurrent invocation can't slip between our stop and store.
    let _cmd_guard = state.cmd_lock.lock().await;

    // Stop any existing server before starting a new one. Awaits the
    // join handle so the previous task fully exits before we bind.
    stop_inner(&state).await;

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("bind failed: {}", e))?;
    let addr = listener
        .local_addr()
        .map_err(|e| format!("local_addr failed: {}", e))?;

    let app = build_router(repo_path);

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

    let mut guard = state.inner.lock();
    *guard = Some(RunningServer {
        addr,
        shutdown: Some(shutdown_tx),
        handle,
    });

    Ok(format!("http://{}", addr))
}

#[tauri::command]
pub async fn intake_stop(state: tauri::State<'_, IntakeState>) -> Result<(), String> {
    // Same cmd_lock as intake_start so a stop arriving mid-start
    // waits for the start to finish before tearing down. Otherwise
    // a stop could complete on `state == None` (between start's
    // stop_inner and store) and the start would still proceed to
    // store its newly-bound server, leaving us "running" after the
    // user requested stop.
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
    // Pull the running server out of the lock before awaiting — holding
    // a parking_lot mutex across `.await` would deadlock the runtime.
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

/// Build the axum router for a given repo. Factored out of
/// `intake_start` so the tests can drive the same routes through a
/// real TCP listener without going through Tauri state.
fn build_router(repo: PathBuf) -> Router {
    Router::new()
        .route("/", get(serve_form))
        .route("/ticket", post(handle_post))
        .with_state(ServerState {
            repo: Arc::new(repo),
        })
}

async fn serve_form() -> Html<&'static str> {
    Html(FORM_HTML)
}

async fn handle_post(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Form(form): Form<TicketForm>,
) -> Response {
    // CSRF: the form is served on http://127.0.0.1:<port> and the only
    // legitimate caller is that same origin. A malicious cross-origin
    // site that discovers the port can fire a CORS-simple POST without
    // preflight; reject it by requiring Origin's host to be a localhost
    // alias. We don't pin the port — it's OS-assigned per launch — and
    // the host-only check is enough to defeat the attacker scenario
    // because any attacker origin lives at a different hostname.
    if !origin_is_localhost(&headers) {
        return (StatusCode::FORBIDDEN, "cross-origin requests are not allowed")
            .into_response();
    }

    let trimmed_question = form.question.trim();
    if trimmed_question.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            "question is required",
        )
            .into_response();
    }

    // Email is required. Server-side check mirrors the form's HTML5
    // `required` + `type="email"` so a curl/script bypass still gets
    // the same answer the browser would.
    let email = form
        .email
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s.contains('@'));
    let Some(email) = email else {
        return (StatusCode::BAD_REQUEST, "a valid email is required")
            .into_response();
    };

    // Asker label = email (always present after validation above).
    let asker = email.clone();

    // Subject = first line of the question, capped at 80 chars.
    let subject = first_line_truncated(trimmed_question, 80);

    let now = chrono_iso8601_now();
    // Ticket id = ISO timestamp + short random suffix. Filesystem-safe
    // (colons replaced with dashes) and datetime-readable. Lex-sortable
    // ascending = oldest-first; the explorer reverses these for the
    // tickets/conversations dirs so the user sees newest-first.
    // Format: `2026-04-27T04-42-05Z-x9q1`. Doubles as the conversation
    // subfolder name so all turns for a thread live together.
    let rand4: String = Uuid::new_v4()
        .simple()
        .to_string()
        .chars()
        .take(4)
        .collect();
    let id = format!("{}-{}", now.replace(':', "-"), rand4);

    let row = serde_json::json!({
        "subject": subject,
        "description": trimmed_question,
        "asker": asker,
        "askerChannel": "web",
        "status": "incoming",
        "priority": "normal",
        "tags": [],
        "createdAt": now,
        "updatedAt": now,
    });

    // Tickets land in `databases/tickets/`. Slug-free dir names match
    // the bundled-schema convention and stay stable across local/cloud
    // modes (the cloud sync engine maps to `tickets-<orgId>` at push
    // time).
    let tickets_dir = state.repo.join("databases").join("tickets");
    if let Err(e) = tokio::fs::create_dir_all(&tickets_dir).await {
        eprintln!("[intake] mkdir {} failed: {}", tickets_dir.display(), e);
        return (StatusCode::INTERNAL_SERVER_ERROR, "could not create ticket directory")
            .into_response();
    }

    let path = tickets_dir.join(format!("{}.json", id));
    let json = match serde_json::to_string_pretty(&row) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[intake] serialize failed: {}", e);
            return (StatusCode::INTERNAL_SERVER_ERROR, "could not serialize ticket")
                .into_response();
        }
    };
    if let Err(e) = tokio::fs::write(&path, json).await {
        eprintln!("[intake] write {} failed: {}", path.display(), e);
        return (StatusCode::INTERNAL_SERVER_ERROR, "could not write ticket file")
            .into_response();
    }

    // Write the asker's first conversation turn into the thread
    // subfolder. Doing this here (not in triage) means the chat-thread
    // viewer is correct from the moment the form is submitted — no
    // dependency on the LLM running before the asker turn exists.
    if let Err(e) = write_first_conversation_turn(
        &state.repo,
        &id,
        &asker,
        trimmed_question,
        &now,
    )
    .await
    {
        eprintln!("[intake] first turn write failed (non-fatal): {}", e);
    }

    // Also create a people row idempotently. Email is required (checked
    // above), so this always runs.
    {
        if let Err(e) = ensure_people_row(
            &state.repo,
            &email,
            form.name.as_deref().unwrap_or("").trim(),
            &now,
        )
        .await
        {
            eprintln!("[intake] people row write failed (non-fatal): {}", e);
        }
    }

    Html(success_page(&id)).into_response()
}

/// Write the asker's opening message into
/// `databases/conversations/<ticketId>/msg-<unix-ms>-<rand>.json`.
/// Done at intake time (not triage time) so the chat-thread viewer
/// always has the asker's first turn — no dependency on Claude
/// running before the user opens the thread.
async fn write_first_conversation_turn(
    repo: &std::path::Path,
    ticket_id: &str,
    sender: &str,
    body: &str,
    now: &str,
) -> Result<(), String> {
    let dir = repo.join("databases").join("conversations").join(ticket_id);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("mkdir conversations/<id>: {}", e))?;

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

    let row = serde_json::json!({
        "id": msg_id,
        "ticketId": ticket_id,
        "role": "asker",
        "sender": sender,
        "timestamp": now,
        "body": body,
    });
    let json = serde_json::to_string_pretty(&row)
        .map_err(|e| format!("serialize first turn: {}", e))?;
    let path = dir.join(format!("{}.json", msg_id));
    tokio::fs::write(&path, json)
        .await
        .map_err(|e| format!("write first turn: {}", e))?;
    Ok(())
}

/// Create `databases/people/<sanitized-email>.json` if one doesn't
/// already exist. Sanitization: lowercase + replace anything outside
/// `[a-z0-9.-]` with `_`. Idempotent — repeat tickets from the same
/// email don't create duplicate rows. Returns the path written or
/// None when a row with that email was already on disk.
async fn ensure_people_row(
    repo: &std::path::Path,
    email: &str,
    name: &str,
    now: &str,
) -> Result<(), String> {
    let people_dir = repo.join("databases").join("people");
    tokio::fs::create_dir_all(&people_dir)
        .await
        .map_err(|e| format!("mkdir people: {}", e))?;

    let key = sanitize_email_key(email);
    let path = people_dir.join(format!("{}.json", key));
    if tokio::fs::try_exists(&path).await.unwrap_or(false) {
        return Ok(());
    }

    let display_name = if name.is_empty() {
        email.to_string()
    } else {
        name.to_string()
    };
    let row = serde_json::json!({
        "displayName": display_name,
        "email": email,
        "channels": [format!("web:{}", email)],
        "createdAt": now,
        "updatedAt": now,
    });
    let json = serde_json::to_string_pretty(&row)
        .map_err(|e| format!("serialize people row: {}", e))?;
    tokio::fs::write(&path, json)
        .await
        .map_err(|e| format!("write people row: {}", e))?;
    Ok(())
}

/// Convert an email to a filesystem-safe filename. `Alice@Example.com`
/// → `alice_example.com`. Doesn't preserve uniqueness across all
/// possible emails (e.g. `a@b.c` and `a_b.c` collide), but for the
/// realistic email shape it's stable and readable.
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

/// Validate the Origin (or, as a fallback, Referer) header against a
/// localhost-host allowlist. Returns true iff the request looks
/// same-origin to the OpenIT-bound localhost server.
///
/// Both headers are sent by modern browsers on POST. Origin is the
/// preferred CSRF signal — present on cross-origin POSTs and form
/// submissions alike. We accept either `127.0.0.1`, `localhost`, or
/// `[::1]` as a host (browsers may rewrite between them depending on
/// how the user typed the URL). Port intentionally not checked — the
/// intake port is OS-assigned and rotates per launch.
///
/// If neither header is present, reject. A modern browser always
/// includes one on a cross-origin POST; absence implies either an
/// attacker tool (curl, etc.) or an unusual client where we'd rather
/// be conservative than permissive.
fn origin_is_localhost(headers: &HeaderMap) -> bool {
    let candidate = headers
        .get("origin")
        .or_else(|| headers.get("referer"))
        .and_then(|v| v.to_str().ok());
    let Some(s) = candidate else { return false };
    let Ok(url) = reqwest::Url::parse(s) else {
        return false;
    };
    // Use Url::host() — returns a typed Host<&str> enum, which lets us
    // delegate loopback detection to the stdlib's `is_loopback` instead
    // of guessing whether `host_str()` returns IPv6 with or without
    // brackets (it returns "[::1]" — the bracketed form). Stdlib
    // `is_loopback` covers 127.0.0.0/8 and ::1 correctly.
    match url.host() {
        Some(url::Host::Domain(d)) => d == "localhost",
        Some(url::Host::Ipv4(addr)) => addr.is_loopback(),
        Some(url::Host::Ipv6(addr)) => addr.is_loopback(),
        None => false,
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

/// Minimal RFC-3339 "now" without pulling in chrono. Tauri builds already
/// rely on system time being correct; format `YYYY-MM-DDTHH:MM:SSZ` (no
/// sub-second precision, UTC).
fn chrono_iso8601_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    // Days from 1970-01-01 to compute Y-M-D using the proleptic
    // Gregorian calendar. Hand-rolled — small, no deps. Good enough
    // for ticket timestamps; anything that needs more precision uses
    // its own clock.
    let (y, mo, d, h, mi, s) = unix_to_ymdhms(secs);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y, mo, d, h, mi, s
    )
}

fn unix_to_ymdhms(secs: i64) -> (i32, u32, u32, u32, u32, u32) {
    let days = secs.div_euclid(86_400) as i64;
    let mut s_of_day = secs.rem_euclid(86_400) as u32;
    let h = s_of_day / 3600;
    s_of_day %= 3600;
    let mi = s_of_day / 60;
    let s = s_of_day % 60;
    // Convert days since 1970-01-01 (epoch) to civil date using
    // Howard Hinnant's algorithm.
    let z = days + 719_468;
    let era = if z >= 0 { z / 146_097 } else { (z - 146_096) / 146_097 };
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

fn success_page(id: &str) -> String {
    format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><title>Ticket filed — OpenIT</title>{styles}</head><body><main><h1>Thanks — your ticket is in</h1><p>Reference: <code>{id}</code></p><p>The IT team will follow up. You can close this tab.</p></main></body></html>"#,
        styles = STYLES,
        id = id
    )
}

const STYLES: &str = r#"<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f7; color: #1d1d1f; margin: 0; padding: 40px 20px; }
main { max-width: 480px; margin: 0 auto; background: white; padding: 32px; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.05); }
h1 { font-size: 22px; margin: 0 0 16px; }
label { display: block; margin: 16px 0 6px; font-size: 13px; font-weight: 500; color: #444; }
input, textarea { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #d2d2d7; border-radius: 8px; font-size: 14px; font-family: inherit; }
textarea { min-height: 140px; resize: vertical; }
button { margin-top: 20px; padding: 10px 20px; background: #1f4d2c; color: white; border: 0; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer; }
button:hover { background: #143620; }
.hint { color: #666; font-size: 12px; margin: 8px 0 16px; }
code { background: #f0f0f0; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
</style>"#;

const FORM_HTML: &str = r#"<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>File an IT ticket — OpenIT</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f7; color: #1d1d1f; margin: 0; padding: 40px 20px; }
main { max-width: 480px; margin: 0 auto; background: white; padding: 32px; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.05); }
h1 { font-size: 22px; margin: 0 0 16px; }
.hint { color: #666; font-size: 12px; margin: 0 0 20px; }
label { display: block; margin: 14px 0 6px; font-size: 13px; font-weight: 500; color: #444; }
input, textarea { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #d2d2d7; border-radius: 8px; font-size: 14px; font-family: inherit; }
textarea { min-height: 140px; resize: vertical; }
button { margin-top: 20px; padding: 10px 20px; background: #1f4d2c; color: white; border: 0; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer; }
button:hover { background: #143620; }
</style>
</head>
<body>
<main>
<h1>File an IT ticket</h1>
<p class="hint">Your question goes straight to the IT admin running OpenIT on this machine. They'll follow up.</p>
<form method="post" action="/ticket">
<label for="name">Your name</label>
<input id="name" name="name" type="text" autocomplete="name">
<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="email" required>
<label for="question">What's going on?</label>
<textarea id="question" name="question" required placeholder="Describe the problem. Include error messages, screenshots-text, what you've already tried."></textarea>
<button type="submit">File ticket</button>
</form>
</main>
</body>
</html>"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_line_truncated_short() {
        assert_eq!(first_line_truncated("hi", 80), "hi");
    }

    #[test]
    fn first_line_truncated_long_capped() {
        let long = "x".repeat(100);
        let out = first_line_truncated(&long, 10);
        assert_eq!(out.chars().count(), 10);
        assert!(out.ends_with('…'));
    }

    #[test]
    fn first_line_takes_only_first_line() {
        assert_eq!(first_line_truncated("first\nsecond", 80), "first");
    }

    #[test]
    fn unix_to_ymdhms_known_dates() {
        // 1970-01-01T00:00:00Z
        assert_eq!(unix_to_ymdhms(0), (1970, 1, 1, 0, 0, 0));
        // 2000-01-01T00:00:00Z
        assert_eq!(unix_to_ymdhms(946_684_800), (2000, 1, 1, 0, 0, 0));
        // 2026-04-27T09:14:02Z
        assert_eq!(unix_to_ymdhms(1_777_281_242), (2026, 4, 27, 9, 14, 2));
        // 2024-02-29T12:00:00Z (leap day)
        assert_eq!(unix_to_ymdhms(1_709_208_000), (2024, 2, 29, 12, 0, 0));
    }

    /// Stand up the intake router on an OS-assigned port pointed at a
    /// tempdir, return the base URL plus the tempdir handle. Caller
    /// drops the handle when done; the spawned server stays around
    /// (each test is short-lived so leaking is fine).
    async fn spawn_test_server() -> (String, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = dir.path().to_path_buf();
        let app = build_router(repo);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("local_addr");
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (format!("http://{}", addr), dir)
    }

    fn read_only_ticket_file(repo: &std::path::Path) -> serde_json::Value {
        // Tickets land in `databases/tickets/` post-rename (slug-free).
        let dir = repo.join("databases").join("tickets");
        let entries: Vec<_> = std::fs::read_dir(&dir)
            .unwrap_or_else(|e| panic!("read_dir {}: {}", dir.display(), e))
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("json"))
            .collect();
        assert_eq!(entries.len(), 1, "expected exactly one ticket file");
        let body = std::fs::read_to_string(&entries[0]).expect("read row");
        serde_json::from_str(&body).expect("parse row")
    }

    #[tokio::test]
    async fn get_root_serves_the_form() {
        let (base, _dir) = spawn_test_server().await;
        let resp = reqwest::get(&base).await.expect("GET /");
        assert!(resp.status().is_success());
        let body = resp.text().await.expect("body");
        assert!(body.contains("<form"));
        assert!(body.contains(r#"name="question""#));
    }

    #[tokio::test]
    async fn post_ticket_writes_a_row_with_incoming_status() {
        let (base, dir) = spawn_test_server().await;
        let resp = reqwest::Client::new()
            .post(format!("{}/ticket", base))
            .header("Origin", &base)
            .form(&[
                ("name", "Alice"),
                ("email", "alice@example.com"),
                ("question", "VPN broken since this morning"),
            ])
            .send()
            .await
            .expect("post");
        assert!(resp.status().is_success(), "status: {}", resp.status());

        let row = read_only_ticket_file(dir.path());
        assert_eq!(row["status"], "incoming");
        assert_eq!(row["askerChannel"], "web");
        assert_eq!(row["asker"], "alice@example.com");
        assert_eq!(row["description"], "VPN broken since this morning");
        assert_eq!(row["subject"], "VPN broken since this morning");
        assert_eq!(row["priority"], "normal");
        assert!(row["tags"].as_array().unwrap().is_empty());
        assert!(row["createdAt"].as_str().unwrap().ends_with("Z"));
        // createdAt and updatedAt should match on creation.
        assert_eq!(row["createdAt"], row["updatedAt"]);
    }

    #[tokio::test]
    async fn post_rejects_when_email_missing() {
        let (base, _dir) = spawn_test_server().await;
        let resp = reqwest::Client::new()
            .post(format!("{}/ticket", base))
            .header("Origin", &base)
            .form(&[("name", "Bob"), ("question", "x")])
            .send()
            .await
            .expect("post");
        assert_eq!(resp.status(), reqwest::StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn post_rejects_when_email_lacks_at_sign() {
        let (base, _dir) = spawn_test_server().await;
        let resp = reqwest::Client::new()
            .post(format!("{}/ticket", base))
            .header("Origin", &base)
            .form(&[("name", "Bob"), ("email", "not-an-email"), ("question", "x")])
            .send()
            .await
            .expect("post");
        assert_eq!(resp.status(), reqwest::StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn post_subject_is_first_line_only() {
        let (base, dir) = spawn_test_server().await;
        reqwest::Client::new()
            .post(format!("{}/ticket", base))
            .header("Origin", &base)
            .form(&[
                ("email", "u@x.com"),
                ("question", "first line\nsecond line\nthird line"),
            ])
            .send()
            .await
            .expect("post");
        let row = read_only_ticket_file(dir.path());
        assert_eq!(row["subject"], "first line");
        // description preserves the full multi-line input.
        assert_eq!(row["description"], "first line\nsecond line\nthird line");
    }

    #[tokio::test]
    async fn post_writes_asker_first_turn_into_thread_subfolder() {
        // Intake writes the asker's opening message at submission time,
        // not at triage time. Without this, a user clicking into the
        // conversation thread before Claude triages would see an empty
        // chat or just the agent reply (the bug that prompted this
        // change).
        let (base, dir) = spawn_test_server().await;
        let resp = reqwest::Client::new()
            .post(format!("{}/ticket", base))
            .header("Origin", &base)
            .form(&[("email", "alice@example.com"), ("question", "vpn broken")])
            .send()
            .await
            .expect("post");
        assert!(resp.status().is_success(), "status: {}", resp.status());

        // Locate the thread subfolder (named after the ticket id).
        let conv_root = dir.path().join("databases").join("conversations");
        let threads: Vec<_> = std::fs::read_dir(&conv_root)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .map(|e| e.path())
            .collect();
        assert_eq!(threads.len(), 1, "expected exactly one thread subfolder");

        let msgs: Vec<_> = std::fs::read_dir(&threads[0])
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("json"))
            .collect();
        assert_eq!(msgs.len(), 1, "expected exactly one msg file (the asker turn)");

        let body = std::fs::read_to_string(&msgs[0]).unwrap();
        let msg: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(msg["role"], "asker");
        assert_eq!(msg["sender"], "alice@example.com");
        assert_eq!(msg["body"], "vpn broken");
    }

    #[tokio::test]
    async fn post_rejects_empty_question() {
        let (base, _dir) = spawn_test_server().await;
        let resp = reqwest::Client::new()
            .post(format!("{}/ticket", base))
            .header("Origin", &base)
            .form(&[("name", "Alice"), ("question", "   ")])
            .send()
            .await
            .expect("post");
        assert_eq!(resp.status(), reqwest::StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn post_without_origin_header_is_rejected() {
        // CSRF guard: a modern browser always sends Origin (or at
        // minimum Referer) on a cross-origin POST. Missing both implies
        // an attacker tool — reject with 403.
        let (base, _dir) = spawn_test_server().await;
        let resp = reqwest::Client::new()
            .post(format!("{}/ticket", base))
            .form(&[("email", "u@x.com"), ("question", "x")])
            .send()
            .await
            .expect("post");
        assert_eq!(resp.status(), reqwest::StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn post_with_cross_origin_is_rejected() {
        // The substantive CSRF protection: a malicious page at
        // https://evil.com that has discovered the localhost port
        // can fire a CORS-simple form POST. The Origin header on
        // that request reveals the cross-origin host; reject.
        let (base, _dir) = spawn_test_server().await;
        let resp = reqwest::Client::new()
            .post(format!("{}/ticket", base))
            .header("Origin", "https://evil.com")
            .form(&[("email", "u@x.com"), ("question", "x")])
            .send()
            .await
            .expect("post");
        assert_eq!(resp.status(), reqwest::StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn post_with_localhost_origin_is_accepted() {
        // The bind URL uses 127.0.0.1; some browsers normalize URLs to
        // "localhost" when the user types that into the address bar.
        // Both should work.
        let (base, _dir) = spawn_test_server().await;
        // base looks like http://127.0.0.1:<port> — substitute the
        // host segment to test the localhost alias.
        let port = base.rsplit(':').next().expect("port");
        let localhost_origin = format!("http://localhost:{}", port);
        let resp = reqwest::Client::new()
            .post(format!("{}/ticket", base))
            .header("Origin", localhost_origin)
            .form(&[("email", "u@x.com"), ("question", "x")])
            .send()
            .await
            .expect("post");
        assert!(resp.status().is_success(), "status: {}", resp.status());
    }

    #[tokio::test]
    async fn post_with_ipv6_loopback_origin_is_accepted() {
        // Round-2 BugBot finding: an earlier version of the check
        // matched url.host_str() against bare "::1", but for IPv6
        // host_str returns the bracketed form. Using Url::host() with
        // stdlib is_loopback covers both. Lock the IPv6 acceptance in.
        let (base, _dir) = spawn_test_server().await;
        let port = base.rsplit(':').next().expect("port");
        let ipv6_origin = format!("http://[::1]:{}", port);
        let resp = reqwest::Client::new()
            .post(format!("{}/ticket", base))
            .header("Origin", ipv6_origin)
            .form(&[("email", "u@x.com"), ("question", "x")])
            .send()
            .await
            .expect("post");
        assert!(resp.status().is_success(), "status: {}", resp.status());
    }
}
