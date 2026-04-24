use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;
use std::thread;

use anyhow::{anyhow, Result};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime, State};

#[derive(Default)]
pub struct PtyState {
    sessions: Mutex<HashMap<String, Session>>,
}

struct Session {
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    _child: Box<dyn portable_pty::Child + Send + Sync>,
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
    for a in &cmd_args {
        cmd.arg(a);
    }
    if let Some(d) = cwd.as_deref() {
        cmd.cwd(d);
    }
    cmd.env("TERM", "xterm-256color");

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let master = Arc::new(Mutex::new(pair.master));
    let writer = {
        let m = master.lock();
        Arc::new(Mutex::new(m.take_writer().map_err(|e| e.to_string())?))
    };
    let reader = {
        let m = master.lock();
        m.try_clone_reader().map_err(|e| e.to_string())?
    };

    let session_id_for_thread = session_id.clone();
    let app_for_thread = app.clone();
    thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_for_thread.emit(
                        "pty://data",
                        PtyData {
                            session_id: session_id_for_thread.clone(),
                            data,
                        },
                    );
                }
                Err(_) => break,
            }
        }
        let _ = app_for_thread.emit(
            "pty://exit",
            PtyExit {
                session_id: session_id_for_thread.clone(),
                code: None,
            },
        );
    });

    state.sessions.lock().insert(
        session_id,
        Session {
            master,
            writer,
            _child: child,
        },
    );

    Ok(())
}

#[tauri::command]
pub fn pty_write(state: State<'_, PtyState>, session_id: String, data: String) -> Result<(), String> {
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
    sessions
        .remove(&session_id)
        .ok_or_else(|| format!("unknown session {}", session_id))?;
    Ok(())
}

/// Resolve which binary to spawn. Preference: explicit override → `claude` on PATH → user's $SHELL → /bin/bash.
fn resolve_command(override_cmd: Option<&str>) -> Result<String> {
    if let Some(c) = override_cmd {
        return Ok(c.to_string());
    }
    if let Ok(path) = which::which("claude") {
        return Ok(path.to_string_lossy().into_owned());
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
