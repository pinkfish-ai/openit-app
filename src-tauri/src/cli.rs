use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::thread;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime};

#[derive(Deserialize)]
pub struct DeployArgs {
    pub repo: String,
    pub env: String,
}

#[derive(Serialize, Clone)]
pub struct DeployLine {
    pub stream: &'static str,
    pub line: String,
}

#[derive(Serialize, Clone)]
pub struct DeployExit {
    pub code: Option<i32>,
}

/// Run `pinkit deploy --env <env>` in the given repo, streaming output to the
/// front-end via `cli://deploy-line` events. If `pinkit` isn't on PATH and
/// `OPENIT_PINKIT_STUB=1` is set, fall back to `scripts/pinkit-stub.sh`.
#[tauri::command]
pub fn pinkit_deploy<R: Runtime>(app: AppHandle<R>, args: DeployArgs) -> Result<(), String> {
    let DeployArgs { repo, env } = args;

    let (program, prog_args): (String, Vec<String>) = if which::which("pinkit").is_ok() {
        ("pinkit".into(), vec!["deploy".into(), "--env".into(), env])
    } else if std::env::var("OPENIT_PINKIT_STUB").ok().as_deref() == Some("1") {
        let stub = std::path::Path::new(&repo).join("scripts/pinkit-stub.sh");
        (
            stub.to_string_lossy().into_owned(),
            vec!["deploy".into(), "--env".into(), env],
        )
    } else {
        return Err(
            "pinkit not found on PATH (set OPENIT_PINKIT_STUB=1 to use the local stub)".into(),
        );
    };

    let mut child = Command::new(&program)
        .args(&prog_args)
        .current_dir(&repo)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn {}: {}", program, e))?;

    if let Some(stdout) = child.stdout.take() {
        let app2 = app.clone();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let _ = app2.emit(
                    "cli://deploy-line",
                    DeployLine {
                        stream: "stdout",
                        line,
                    },
                );
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let app2 = app.clone();
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let _ = app2.emit(
                    "cli://deploy-line",
                    DeployLine {
                        stream: "stderr",
                        line,
                    },
                );
            }
        });
    }

    thread::spawn(move || {
        let code = child.wait().ok().and_then(|s| s.code());
        let _ = app.emit("cli://deploy-exit", DeployExit { code });
    });

    Ok(())
}
