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

    let server_state = ServerState {
        repo: Arc::new(repo_path),
    };
    let app = Router::new()
        .route("/", get(serve_form))
        .route("/ticket", post(handle_post))
        .with_state(server_state);

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

    // Pick a single asker label: prefer email, fall back to name, then "unknown".
    // The schema's `asker` field is a free-form string.
    let asker = form
        .email
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            form.name
                .as_ref()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_else(|| "unknown".to_string());

    // Subject = first line of the question, capped at 80 chars.
    let subject = first_line_truncated(trimmed_question, 80);

    let now = chrono_iso8601_now();
    let id = format!("incoming-{}", Uuid::new_v4());

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

    let slug = state
        .repo
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("local")
        .to_string();
    let dir = state
        .repo
        .join("databases")
        .join(format!("openit-tickets-{}", slug));
    // tokio::fs to avoid blocking the runtime worker. Matters less in
    // practice (single user, fast local disk) but the async handler
    // shouldn't be the place we serialize tokio threads on slow IO.
    if let Err(e) = tokio::fs::create_dir_all(&dir).await {
        eprintln!("[intake] mkdir {} failed: {}", dir.display(), e);
        return (StatusCode::INTERNAL_SERVER_ERROR, "could not create ticket directory")
            .into_response();
    }

    let path = dir.join(format!("{}.json", id));
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

    Html(success_page(&id)).into_response()
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
<label for="email">Email (optional)</label>
<input id="email" name="email" type="email" autocomplete="email">
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
}
