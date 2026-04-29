// Tunnel module — exposes the localhost intake server to the public
// internet via a no-signup SSH reverse tunnel (localhost.run).
//
// V0 strategy: shell out to the system `ssh` binary. The host
// `nokey@localhost.run` accepts unauthenticated reverse forwards and
// prints back a `https://<random>.lhr.life` URL on the channel. The
// tunnel lives exactly as long as the SSH session — laptop sleep /
// app close → URL dies. That ephemerality is intentional (it's the
// upgrade-to-cloud story), so we make no attempt to keep it alive
// across reconnects.
//
// Lifecycle mirrors `intake.rs`: a TunnelState held in Tauri state,
// `tunnel_start` swaps any existing tunnel under a single cmd_lock,
// `tunnel_stop` tears it down. Dropping the child kills ssh
// (kill_on_drop) so process exit cleans up automatically.
//
// We do NOT add a regex crate — the URL pattern is trivial enough to
// scan with manual substring matching (`https://` … `.lhr.life`).

use std::process::Stdio;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use parking_lot::Mutex;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command as TokioCommand};
use tokio::sync::{oneshot, Mutex as TokioMutex};
use tokio::task::JoinHandle;
use tokio::time::timeout;

// Shared with `intake.rs` so its CSRF / origin guard can accept the
// currently-active tunnel host (e.g. `c750a98aa3d133.lhr.life`) in
// addition to localhost. Set by `tunnel_start` on success, cleared by
// `tunnel_stop`. Reads are cheap (uncontended Mutex<Option<String>>).
static ACTIVE_TUNNEL_HOST: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn host_slot() -> &'static Mutex<Option<String>> {
    ACTIVE_TUNNEL_HOST.get_or_init(|| Mutex::new(None))
}

pub(crate) fn current_tunnel_host() -> Option<String> {
    host_slot().lock().clone()
}

fn set_current_tunnel_host(host: Option<String>) {
    *host_slot().lock() = host;
}

#[derive(Default)]
pub struct TunnelState {
    inner: Mutex<Option<RunningTunnel>>,
    // Async-aware lock so we can serialize across awaits without
    // holding parking_lot's sync mutex.
    cmd_lock: TokioMutex<()>,
}

struct RunningTunnel {
    url: String,
    // Held only so dropping the struct triggers kill_on_drop and reaps
    // the ssh process. Never accessed.
    _child: Child,
    // Reader tasks finish on their own when the child's pipes close,
    // but we hold the handles to abort them deterministically on stop.
    stdout_task: Option<JoinHandle<()>>,
    stderr_task: Option<JoinHandle<()>>,
}

/// How long to wait for localhost.run to print a URL after spawn.
/// Empirically the welcome banner + URL line lands within 1–3s on a
/// good connection; 20s leaves headroom for slow links and DNS hiccups.
const URL_WAIT_SECS: u64 = 20;

#[tauri::command]
pub async fn tunnel_start(
    state: tauri::State<'_, TunnelState>,
    local_url: String,
) -> Result<String, String> {
    let port = parse_port(&local_url)?;

    let _cmd_guard = state.cmd_lock.lock().await;
    stop_inner(&state).await;

    let mut child = TokioCommand::new("ssh")
        .args([
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-o",
            "ServerAliveInterval=30",
            "-o",
            "ServerAliveCountMax=3",
            "-o",
            "ExitOnForwardFailure=yes",
            "-T",
            "-R",
            &format!("80:127.0.0.1:{}", port),
            "nokey@localhost.run",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("spawn ssh failed: {}", e))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "child stdout missing".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "child stderr missing".to_string())?;

    let (url_tx, url_rx) = oneshot::channel::<String>();
    // Wrap in a Mutex<Option<...>> so whichever stream sees the URL
    // first wins; the loser harmlessly finds None.
    let url_tx = Arc::new(Mutex::new(Some(url_tx)));

    let stdout_task = spawn_url_scanner("out", stdout, url_tx.clone());
    let stderr_task = spawn_url_scanner("err", stderr, url_tx.clone());

    let url = match timeout(Duration::from_secs(URL_WAIT_SECS), url_rx).await {
        Ok(Ok(u)) => u,
        Ok(Err(_)) => {
            // Sender dropped without sending — both streams closed,
            // i.e. ssh exited before printing a URL. Most common cause:
            // network unreachable or localhost.run rejected the forward.
            stdout_task.abort();
            stderr_task.abort();
            return Err("ssh exited before printing tunnel URL".into());
        }
        Err(_) => {
            stdout_task.abort();
            stderr_task.abort();
            return Err(format!(
                "timed out after {}s waiting for tunnel URL",
                URL_WAIT_SECS
            ));
        }
    };

    // Publish the host to the shared allowlist before we make the URL
    // visible to the frontend — otherwise a fast asker could load the
    // page and POST before the intake server's origin check sees the
    // new host. (In practice the SSH handshake makes this lossless,
    // but ordering it this way keeps the invariant clear.)
    if let Ok(parsed) = url::Url::parse(&url) {
        if let Some(host) = parsed.host_str() {
            set_current_tunnel_host(Some(host.to_string()));
        }
    }

    let mut guard = state.inner.lock();
    *guard = Some(RunningTunnel {
        url: url.clone(),
        _child: child,
        stdout_task: Some(stdout_task),
        stderr_task: Some(stderr_task),
    });

    Ok(url)
}

#[tauri::command]
pub async fn tunnel_stop(state: tauri::State<'_, TunnelState>) -> Result<(), String> {
    let _cmd_guard = state.cmd_lock.lock().await;
    stop_inner(&state).await;
    Ok(())
}

#[tauri::command]
pub fn tunnel_url(state: tauri::State<'_, TunnelState>) -> Option<String> {
    let guard = state.inner.lock();
    guard.as_ref().map(|t| t.url.clone())
}

async fn stop_inner(state: &tauri::State<'_, TunnelState>) {
    let running = {
        let mut guard = state.inner.lock();
        guard.take()
    };
    if let Some(mut running) = running {
        if let Some(h) = running.stdout_task.take() {
            h.abort();
        }
        if let Some(h) = running.stderr_task.take() {
            h.abort();
        }
        // Dropping `_child` triggers kill_on_drop. ssh receives SIGKILL
        // and the localhost.run side closes the forward.
    }
    // Drop the allowlist entry too — once the tunnel is gone, only
    // genuine localhost requests should pass the origin check.
    set_current_tunnel_host(None);
}

fn spawn_url_scanner<R>(
    label: &'static str,
    reader: R,
    url_tx: Arc<Mutex<Option<oneshot::Sender<String>>>>,
) -> JoinHandle<()>
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            // Surface ssh's chatter in the dev console so first-run
            // failures (host key prompts, permission denied, etc.) are
            // visible without attaching a debugger.
            eprintln!("[tunnel/{}] {}", label, line);
            if let Some(found) = extract_lhr_url(&line) {
                if let Some(tx) = url_tx.lock().take() {
                    let _ = tx.send(found);
                }
            }
        }
    })
}

/// Find the first `https://<sub>.lhr.life` token in a line.
/// Manual parse to avoid pulling in `regex`.
fn extract_lhr_url(line: &str) -> Option<String> {
    let start = line.find("https://")?;
    // Scan forward until we hit a character that can't appear in a
    // tunnel hostname. lhr.life subdomains are hex-ish today but the
    // service has shipped both alphanumeric and dash forms over the
    // years, so accept the same character class as DNS labels.
    let tail = &line[start..];
    let end = tail
        .char_indices()
        .find(|(_, c)| !is_url_host_char(*c))
        .map(|(i, _)| i)
        .unwrap_or(tail.len());
    let candidate = &tail[..end];
    if candidate.ends_with(".lhr.life") {
        Some(candidate.to_string())
    } else {
        None
    }
}

fn is_url_host_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == ':' || c == '/'
}

fn parse_port(local_url: &str) -> Result<u16, String> {
    let parsed = url::Url::parse(local_url).map_err(|e| format!("bad local_url: {}", e))?;
    parsed
        .port()
        .ok_or_else(|| format!("local_url missing port: {}", local_url))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_lhr_url_from_banner_line() {
        let line =
            "48086740ce0c47.lhr.life tunneled with tls termination, https://48086740ce0c47.lhr.life";
        assert_eq!(
            extract_lhr_url(line).as_deref(),
            Some("https://48086740ce0c47.lhr.life"),
        );
    }

    #[test]
    fn ignores_non_lhr_https() {
        assert_eq!(extract_lhr_url("see https://example.com for docs"), None);
    }

    #[test]
    fn parses_port_from_intake_url() {
        assert_eq!(parse_port("http://127.0.0.1:54123").unwrap(), 54123);
    }
}
