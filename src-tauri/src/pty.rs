use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use anyhow::{anyhow, Result};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime, State};

/// Source URL for the official Claude Code native installer. Surfaced in the
/// onboarding UI so the user can see what we're about to fetch.
const CLAUDE_INSTALL_SCRIPT_URL: &str = "https://claude.ai/install.sh";

/// Hard cap on the auto-install. The installer normally finishes in ~5s; if
/// it's still running after 120s we kill it so the UI doesn't hang forever
/// on a captive portal or slow CDN.
const CLAUDE_INSTALL_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Default)]
pub struct PtyState {
    sessions: Mutex<HashMap<String, Session>>,
}

struct Session {
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
}

#[derive(Serialize, Clone)]
pub struct PtyData {
    pub session_id: String,
    pub data: String,
}

#[derive(Serialize, Clone)]
pub struct PtyExit {
    pub session_id: String,
    pub code: Option<i32>,
}

#[derive(Deserialize)]
pub struct SpawnArgs {
    pub session_id: String,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

/// Spawn a PTY session running `command` (or `claude` if available, else `bash`).
/// Streams stdout/stderr to the front-end as `pty://data` events, exit as `pty://exit`.
#[tauri::command]
pub fn pty_spawn<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, PtyState>,
    args: SpawnArgs,
) -> Result<(), String> {
    let SpawnArgs {
        session_id,
        command,
        args: cmd_args,
        cwd,
        cols,
        rows,
    } = args;

    let resolved = resolve_command(command.as_deref()).map_err(|e| e.to_string())?;

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(&resolved);
    // Allow Bash and Read operations for skills that need filesystem access
    if resolved.ends_with("claude") {
        cmd.arg("--allowedTools");
        cmd.arg("Bash Read");
    }
    for a in &cmd_args {
        cmd.arg(a);
    }
    if let Some(d) = cwd.as_deref() {
        cmd.cwd(d);
    }
    cmd.env("TERM", "xterm-256color");
    if let Some(path) = augmented_path() {
        cmd.env("PATH", path);
    }

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let killer = child.clone_killer();

    let master = Arc::new(Mutex::new(pair.master));
    let writer = {
        let m = master.lock();
        Arc::new(Mutex::new(m.take_writer().map_err(|e| e.to_string())?))
    };
    let reader = {
        let m = master.lock();
        m.try_clone_reader().map_err(|e| e.to_string())?
    };

    // Reader thread: stream PTY output to the front-end.
    let reader_session_id = session_id.clone();
    let reader_app = app.clone();
    thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = reader_app.emit(
                        "pty://data",
                        PtyData {
                            session_id: reader_session_id.clone(),
                            data,
                        },
                    );
                }
                Err(_) => break,
            }
        }
    });

    // Waiter thread: block on the child, emit exit with the real status code.
    let waiter_session_id = session_id.clone();
    let waiter_app = app.clone();
    thread::spawn(move || {
        let code = match child.wait() {
            Ok(status) => status.exit_code() as i32,
            Err(_) => -1,
        };
        let _ = waiter_app.emit(
            "pty://exit",
            PtyExit {
                session_id: waiter_session_id,
                code: Some(code),
            },
        );
    });

    state.sessions.lock().insert(
        session_id,
        Session {
            master,
            writer,
            killer,
        },
    );

    Ok(())
}

#[tauri::command]
pub fn pty_write(
    state: State<'_, PtyState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let sessions = state.sessions.lock();
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| format!("unknown session {}", session_id))?;
    let mut w = session.writer.lock();
    w.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    w.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(
    state: State<'_, PtyState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock();
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| format!("unknown session {}", session_id))?;
    let result = session.master.lock().resize(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    });
    result.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(state: State<'_, PtyState>, session_id: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock();
    let mut session = sessions
        .remove(&session_id)
        .ok_or_else(|| format!("unknown session {}", session_id))?;
    // Best-effort: if the child already exited, kill() returns an error we ignore.
    let _ = session.killer.kill();
    Ok(())
}

/// Detect a usable `claude` binary. Checks PATH first, then well-known install
/// locations the native installer drops into (which a GUI-launched app's PATH
/// won't see until the user opens a fresh terminal).
#[tauri::command]
pub fn claude_detect() -> Option<String> {
    locate_claude().map(|p| p.to_string_lossy().into_owned())
}

/// Run the official Claude Code installer (`claude.ai/install.sh`) and return
/// the resolved binary path on success. The installer drops the binary at
/// `~/.local/bin/claude` and updates the user's shell rc — but the running app
/// won't see the rc change, so callers should always go through `claude_detect`
/// or `resolve_command` afterwards (both probe known install dirs).
///
/// `async` so the Tauri command thread isn't blocked while curl runs (5–30s
/// typically; up to `CLAUDE_INSTALL_TIMEOUT` before we kill it).
///
/// Unix only: the install.sh is bash-only and supports macOS + Linux. On
/// Windows we return an error pointing at the manual install docs rather
/// than silently shelling out to bash (which would either fail or, worse,
/// install into WSL where the Windows-side OpenIT process can't see it).
#[tauri::command]
pub async fn claude_install() -> Result<String, String> {
    if let Some(existing) = locate_claude() {
        return Ok(existing.to_string_lossy().into_owned());
    }
    tauri::async_runtime::spawn_blocking(run_install_blocking)
        .await
        .map_err(|e| format!("background task failed: {}", e))?
}

#[cfg(unix)]
fn run_install_blocking() -> Result<String, String> {
    use std::process::{Command, Stdio};
    use std::time::Instant;

    let mut child = Command::new("bash")
        .arg("-c")
        .arg(format!("curl -fsSL {} | bash", CLAUDE_INSTALL_SCRIPT_URL))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn installer: {e}"))?;

    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if started.elapsed() > CLAUDE_INSTALL_TIMEOUT {
                    let _ = child.kill();
                    return Err(format!(
                        "installer timed out after {}s — check your network or install manually",
                        CLAUDE_INSTALL_TIMEOUT.as_secs()
                    ));
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(e) => return Err(format!("waiting on installer: {e}")),
        }
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("collecting installer output: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "installer exited with status {:?}\nstdout: {stdout}\nstderr: {stderr}",
            output.status.code()
        ));
    }

    locate_claude()
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| {
            "installer reported success but no claude binary found in expected locations"
                .to_string()
        })
}

#[cfg(not(unix))]
fn run_install_blocking() -> Result<String, String> {
    Err(
        "Auto-install is only supported on macOS and Linux. \
        Please install Claude Code manually from https://docs.anthropic.com/claude/docs/claude-code"
            .to_string(),
    )
}

/// Locate a usable `claude` binary: PATH first, then known install dirs.
/// Exposed so other Tauri commands that shell out to claude (e.g.
/// `claude_generate_commit_message`) resolve against the same set the
/// auto-installer drops binaries into.
pub(crate) fn locate_claude() -> Option<PathBuf> {
    if let Ok(p) = which::which("claude") {
        return Some(p);
    }
    locate_claude_among(&claude_install_candidates(), |p| p.is_file())
}

fn locate_claude_among(candidates: &[PathBuf], is_file: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    candidates.iter().find(|c| is_file(c)).cloned()
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

fn claude_install_candidates() -> Vec<PathBuf> {
    claude_install_candidates_for(home_dir().as_deref())
}

fn claude_install_candidates_for(home: Option<&Path>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(home) = home {
        out.push(home.join(".local/bin/claude"));
        out.push(home.join(".claude/local/claude"));
    }
    out.push(PathBuf::from("/usr/local/bin/claude"));
    out.push(PathBuf::from("/opt/homebrew/bin/claude"));
    out
}

/// Build a PATH that includes the install dirs the native installer uses, so
/// child processes spawned from a GUI-launched app can find `claude` even
/// before the user restarts their terminal. Returns `None` if PATH is fine
/// as-is or unreadable. Exposed for any module that spawns subprocesses
/// expected to find `claude` and its peers.
pub(crate) fn augmented_path() -> Option<String> {
    let home = home_dir()?;
    let current = std::env::var("PATH").unwrap_or_default();
    augmented_path_for(&home, &current, |p| p.is_dir())
}

fn augmented_path_for(
    home: &Path,
    current_path: &str,
    dir_exists: impl Fn(&Path) -> bool,
) -> Option<String> {
    let extra = [
        home.join(".local/bin"),
        home.join(".claude/local"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/opt/homebrew/bin"),
    ];
    let mut parts: Vec<String> = current_path
        .split(':')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();
    let mut changed = false;
    for dir in extra.iter() {
        if !dir_exists(dir) {
            continue;
        }
        let s = dir.to_string_lossy().to_string();
        if !parts.iter().any(|p| p == &s) {
            parts.insert(0, s);
            changed = true;
        }
    }
    if changed {
        Some(parts.join(":"))
    } else {
        None
    }
}

/// Resolve which binary to spawn. Preference: explicit override → `claude` on PATH or known install dir → user's $SHELL → /bin/bash.
fn resolve_command(override_cmd: Option<&str>) -> Result<String> {
    if let Some(c) = override_cmd {
        return Ok(c.to_string());
    }
    if let Some(p) = locate_claude() {
        return Ok(p.to_string_lossy().into_owned());
    }
    if let Ok(shell) = std::env::var("SHELL") {
        if !shell.is_empty() {
            return Ok(shell);
        }
    }
    if which::which("bash").is_ok() {
        return Ok("bash".to_string());
    }
    Err(anyhow!("no shell or claude binary found on PATH"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn resolve_command_uses_override() {
        let resolved = resolve_command(Some("/bin/echo")).unwrap();
        assert_eq!(resolved, "/bin/echo");
    }

    #[test]
    fn resolve_command_falls_back_to_shell_or_bash() {
        let resolved = resolve_command(None).unwrap();
        assert!(!resolved.is_empty());
    }

    #[test]
    fn install_candidates_include_local_bin_when_home_is_set() {
        let home = PathBuf::from("/tmp/fake-home");
        let cs = claude_install_candidates_for(Some(&home));
        assert!(cs.iter().any(|p| p == &home.join(".local/bin/claude")));
        assert!(cs.iter().any(|p| p == &home.join(".claude/local/claude")));
        assert!(cs
            .iter()
            .any(|p| p == &PathBuf::from("/usr/local/bin/claude")));
        assert!(cs
            .iter()
            .any(|p| p == &PathBuf::from("/opt/homebrew/bin/claude")));
    }

    #[test]
    fn install_candidates_omit_home_when_unset() {
        let cs = claude_install_candidates_for(None);
        // Only the absolute fallbacks remain.
        assert_eq!(cs.len(), 2);
        assert!(cs.iter().all(|p| p.is_absolute()));
    }

    #[test]
    fn locate_claude_among_returns_first_match() {
        let candidates = vec![
            PathBuf::from("/nope/a/claude"),
            PathBuf::from("/nope/b/claude"),
            PathBuf::from("/nope/c/claude"),
        ];
        // Pretend the second entry exists.
        let found = locate_claude_among(&candidates, |p| p == Path::new("/nope/b/claude"));
        assert_eq!(found, Some(PathBuf::from("/nope/b/claude")));
    }

    #[test]
    fn locate_claude_among_returns_none_when_nothing_exists() {
        let candidates = vec![PathBuf::from("/nope/a/claude")];
        let found = locate_claude_among(&candidates, |_| false);
        assert!(found.is_none());
    }

    #[test]
    fn augmented_path_prepends_only_existing_dirs() {
        let home = PathBuf::from("/tmp/fake-home");
        let current = "/usr/bin:/bin";
        // First dir exists, others don't.
        let only_local_bin = home.join(".local/bin");
        let augmented = augmented_path_for(&home, current, |p| p == only_local_bin.as_path());
        let s = augmented.expect("expected PATH augmentation");
        assert!(s.starts_with("/tmp/fake-home/.local/bin:"));
        assert!(s.ends_with(":/usr/bin:/bin"));
    }

    #[test]
    fn augmented_path_is_idempotent() {
        let home = PathBuf::from("/tmp/fake-home");
        // PATH already has the dir we'd otherwise prepend.
        let current = "/tmp/fake-home/.local/bin:/usr/bin";
        let only_local_bin = home.join(".local/bin");
        let augmented = augmented_path_for(&home, current, |p| p == only_local_bin.as_path());
        // No change needed → None.
        assert!(augmented.is_none());
    }

    #[test]
    fn augmented_path_returns_none_when_no_dirs_exist() {
        let home = PathBuf::from("/tmp/fake-home");
        let current = "/usr/bin";
        let augmented = augmented_path_for(&home, current, |_| false);
        assert!(augmented.is_none());
    }

    /// Drive the real PTY backend (without the Tauri event layer) to prove the
    /// spawn → read → exit pipeline works end-to-end. The `pty_spawn` Tauri
    /// command wraps these same primitives.
    #[test]
    fn pty_pipeline_spawns_reads_and_exits() {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();

        let mut cmd = CommandBuilder::new("/bin/echo");
        cmd.arg("hello-from-pty");
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut buf = Vec::new();
        let mut chunk = [0u8; 256];
        // Read until EOF; PTY closes when child exits.
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
                Err(_) => break,
            }
        }

        let output = String::from_utf8_lossy(&buf);
        assert!(
            output.contains("hello-from-pty"),
            "expected echo output, got: {:?}",
            output
        );

        let status = child.wait().unwrap();
        assert!(status.success(), "echo should exit 0");
    }

    #[test]
    fn pty_spawn_propagates_command_not_found() {
        // Mirror the spawn path used by `pty_spawn` and confirm the error
        // branch when the requested binary doesn't exist.
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();

        let cmd = CommandBuilder::new("/definitely/not/a/real/binary/openit-test");
        let result = pair.slave.spawn_command(cmd);
        assert!(
            result.is_err(),
            "spawn should fail for a nonexistent binary, got Ok"
        );
    }

    #[test]
    fn pty_resize_succeeds_on_open_master() {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();

        let result = pair.master.resize(PtySize {
            rows: 40,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        });
        assert!(result.is_ok());
    }
}
