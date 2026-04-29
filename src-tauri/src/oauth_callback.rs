// Localhost OAuth callback listener for the "Connect to Cloud" flow.
//
// V1 of PIN-5774. The frontend asks us to spawn an axum server on
// 127.0.0.1:<random>/cb, then opens https://app.pinkfish.ai/openit/connect
// in the user's default browser with `cb` and `state` in the query
// string. After the user authorizes in the browser, the web app
// form-POSTs the freshly-minted Pinkfish credentials back to our
// localhost listener. We validate `state`, hand the creds to the
// frontend via a oneshot channel, and shut down.
//
// Why localhost callback (and not deep links / device code / etc.):
// localhost is the standard CLI auth pattern (gh, gcloud, vercel, …)
// and works identically across macOS/Windows/Linux without any OS
// scheme registration. See auto-dev/plans/2026-04-28-pin-5774-...
//
// Lifecycle: `oauth_callback_start` binds + spawns. `oauth_callback_await`
// blocks until the callback POSTs (or 5 minutes pass). `oauth_callback_cancel`
// force-tears-down, used when the user clicks Cancel mid-flow.

use axum::{
    extract::{Form, State},
    response::{Html, IntoResponse},
    routing::post,
    Router,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::sync::{oneshot, Mutex as TokioMutex};
use tokio::task::JoinHandle;

// 5-minute hard cap on how long we'll wait for the user to complete
// the browser flow. After this we drop the listener and surface a
// retry to the user.
const CALLBACK_TIMEOUT_SECS: u64 = 5 * 60;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct OauthCallbackState {
    inner: Mutex<Option<RunningCallback>>,
    // Serializes start/cancel so a concurrent start from a re-clicked
    // Connect button can't race the previous teardown.
    cmd_lock: TokioMutex<()>,
}

struct RunningCallback {
    shutdown: Option<oneshot::Sender<()>>,
    handle: JoinHandle<()>,
    // Receives the creds from the HTTP handler. Wrapped in a Mutex so
    // `oauth_callback_await` can `take()` it without holding any lock
    // across the .await.
    creds_rx: Arc<TokioMutex<Option<oneshot::Receiver<CallbackCreds>>>>,
}

#[derive(Clone)]
struct ServerCtx {
    expected_state: String,
    // Tucked in an Arc<Mutex<Option<...>>> so the handler can `take()`
    // the Sender once and reject any subsequent POSTs as "already used".
    creds_tx: Arc<Mutex<Option<oneshot::Sender<CallbackCreds>>>>,
}

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct CallbackForm {
    client_id: String,
    client_secret: String,
    org_id: String,
    token_url: String,
    state: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CallbackCreds {
    pub client_id: String,
    pub client_secret: String,
    pub org_id: String,
    pub token_url: String,
}

#[derive(Debug, Serialize)]
pub struct StartResult {
    pub url: String,
    pub port: u16,
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn oauth_callback_start(
    state: tauri::State<'_, OauthCallbackState>,
    expected_state: String,
) -> Result<StartResult, String> {
    if expected_state.is_empty() {
        return Err("expected_state must not be empty".into());
    }

    let _cmd_guard = state.cmd_lock.lock().await;
    cancel_inner(&state).await;

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("bind failed: {}", e))?;
    let addr = listener
        .local_addr()
        .map_err(|e| format!("local_addr failed: {}", e))?;

    let (creds_tx, creds_rx) = oneshot::channel::<CallbackCreds>();
    let ctx = ServerCtx {
        expected_state,
        creds_tx: Arc::new(Mutex::new(Some(creds_tx))),
    };

    let app = Router::new().route("/cb", post(handle_cb)).with_state(ctx);

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let handle = tokio::spawn(async move {
        let result = axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await;
        if let Err(e) = result {
            eprintln!("[oauth_callback] server exited with error: {}", e);
        }
    });

    let creds_rx = Arc::new(TokioMutex::new(Some(creds_rx)));
    {
        let mut guard = state.inner.lock();
        *guard = Some(RunningCallback {
            shutdown: Some(shutdown_tx),
            handle,
            creds_rx,
        });
    }

    Ok(StartResult {
        url: format!("http://{}/cb", addr),
        port: addr.port(),
    })
}

#[tauri::command]
pub async fn oauth_callback_await(
    state: tauri::State<'_, OauthCallbackState>,
) -> Result<CallbackCreds, String> {
    // Snapshot the receiver out of state without holding the parking_lot
    // mutex across the .await below.
    let creds_rx_arc = {
        let guard = state.inner.lock();
        guard
            .as_ref()
            .map(|s| s.creds_rx.clone())
            .ok_or_else(|| "oauth_callback_await: no listener running".to_string())?
    };

    let rx_opt = creds_rx_arc.lock().await.take();
    let rx = rx_opt.ok_or_else(|| "oauth_callback_await: already awaited".to_string())?;

    // Race the receiver against the timeout. Whichever wins, we tear
    // the listener down (we're done, one way or another).
    let result = tokio::time::timeout(Duration::from_secs(CALLBACK_TIMEOUT_SECS), rx).await;

    // Hold cmd_lock across cleanup so a concurrent
    // `oauth_callback_start` (e.g. user clicked Cancel and immediately
    // re-clicked Connect) can't have its freshly stored RunningCallback
    // taken out from under it. Also only cancel if the receiver we
    // owned is still the one in state — otherwise a newer start has
    // replaced it and we shouldn't touch its server.
    let _cmd_guard = state.cmd_lock.lock().await;
    let still_ours = {
        let guard = state.inner.lock();
        guard
            .as_ref()
            .map(|s| Arc::ptr_eq(&s.creds_rx, &creds_rx_arc))
            .unwrap_or(false)
    };
    if still_ours {
        cancel_inner(&state).await;
    }
    drop(_cmd_guard);

    match result {
        Ok(Ok(creds)) => Ok(creds),
        Ok(Err(_)) => Err("oauth_callback_await: listener shut down before callback".into()),
        Err(_) => Err(format!(
            "no callback received in {} seconds",
            CALLBACK_TIMEOUT_SECS
        )),
    }
}

#[tauri::command]
pub async fn oauth_callback_cancel(
    state: tauri::State<'_, OauthCallbackState>,
) -> Result<(), String> {
    let _cmd_guard = state.cmd_lock.lock().await;
    cancel_inner(&state).await;
    Ok(())
}

async fn cancel_inner(state: &tauri::State<'_, OauthCallbackState>) {
    let running = {
        let mut guard = state.inner.lock();
        guard.take()
    };
    if let Some(mut s) = running {
        if let Some(tx) = s.shutdown.take() {
            let _ = tx.send(());
        }
        let _ = s.handle.await;
    }
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

async fn handle_cb(
    State(ctx): State<ServerCtx>,
    Form(form): Form<CallbackForm>,
) -> impl IntoResponse {
    if form.state != ctx.expected_state {
        // Don't consume the sender — the genuine callback might still
        // be in flight. Just reject this stale / hostile POST.
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Html("<h1>state mismatch</h1>".to_string()),
        );
    }

    // `take()` the sender; any subsequent POST gets the "already used"
    // path below. This makes the handler idempotent against double
    // form-submits from the browser.
    let tx_opt = ctx.creds_tx.lock().take();
    let Some(tx) = tx_opt else {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Html("<h1>callback already received</h1>".to_string()),
        );
    };

    let _ = tx.send(CallbackCreds {
        client_id: form.client_id,
        client_secret: form.client_secret,
        org_id: form.org_id,
        token_url: form.token_url,
    });

    (axum::http::StatusCode::OK, Html(SUCCESS_HTML.to_string()))
}

const SUCCESS_HTML: &str = r#"<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>OpenIT — connected</title>
    <style>
      body { font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
             margin: 0; height: 100vh; display: flex; align-items: center;
             justify-content: center; background: #fafaf9; color: #1c1917; }
      .card { text-align: center; padding: 2rem; }
      h1 { font-size: 1.4rem; margin: 0 0 .5rem; }
      p { margin: 0; color: #57534e; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>✓ Connected to OpenIT</h1>
      <p>You can close this tab and return to the desktop app.</p>
    </div>
  </body>
</html>"#;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    async fn post_form(url: &str, body: &str) -> (u16, String) {
        let client = reqwest::Client::new();
        let resp = client
            .post(url)
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(body.to_string())
            .send()
            .await
            .expect("post failed");
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        (status, body)
    }

    fn build_test_app(
        expected_state: &str,
    ) -> (
        Router,
        Arc<Mutex<Option<oneshot::Sender<CallbackCreds>>>>,
        oneshot::Receiver<CallbackCreds>,
    ) {
        let (tx, rx) = oneshot::channel::<CallbackCreds>();
        let creds_tx = Arc::new(Mutex::new(Some(tx)));
        let ctx = ServerCtx {
            expected_state: expected_state.to_string(),
            creds_tx: creds_tx.clone(),
        };
        let app = Router::new().route("/cb", post(handle_cb)).with_state(ctx);
        (app, creds_tx, rx)
    }

    #[tokio::test]
    async fn matching_state_fires_oneshot_and_returns_200() {
        let (app, _tx_holder, rx) = build_test_app("expected-state");
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let body =
            "client_id=cid&client_secret=sec&org_id=oid&token_url=https://t&state=expected-state";
        let (status, _) = post_form(&format!("http://{}/cb", addr), body).await;
        assert_eq!(status, 200);

        let creds = tokio::time::timeout(Duration::from_secs(2), rx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(creds.client_id, "cid");
        assert_eq!(creds.client_secret, "sec");
        assert_eq!(creds.org_id, "oid");
        assert_eq!(creds.token_url, "https://t");
    }

    #[tokio::test]
    async fn state_mismatch_returns_400_and_does_not_fire_oneshot() {
        let (app, tx_holder, mut rx) = build_test_app("expected-state");
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let body = "client_id=cid&client_secret=sec&org_id=oid&token_url=https://t&state=WRONG";
        let (status, _) = post_form(&format!("http://{}/cb", addr), body).await;
        assert_eq!(status, 400);

        // Sender is still in place — the real callback can still arrive.
        assert!(tx_holder.lock().is_some());
        // And the receiver hasn't seen anything.
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn second_matching_post_returns_400_already_received() {
        let (app, _tx_holder, _rx) = build_test_app("s");
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let body = "client_id=a&client_secret=b&org_id=c&token_url=d&state=s";
        let (status1, _) = post_form(&format!("http://{}/cb", addr), body).await;
        assert_eq!(status1, 200);

        let (status2, body2) = post_form(&format!("http://{}/cb", addr), body).await;
        assert_eq!(status2, 400);
        assert!(body2.contains("already received"));
    }
}
