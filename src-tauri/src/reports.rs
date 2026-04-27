// reports.rs — Tauri commands for the local reports/ feature.
//
// Currently exposes a single command, `report_overview_run`, which
// shells out to `.claude/scripts/report-overview.mjs` in the project
// repo. The script is the canonical implementation (a user without
// OpenIT can run the same command from the terminal); this Tauri
// command just gives the desktop "Generate overview" button a way to
// invoke it without typing into the embedded Claude pane.

use std::path::Path;
use std::process::Command;

use serde_json::Value;

#[tauri::command]
pub async fn report_overview_run(repo: String) -> Result<String, String> {
    let script = Path::new(&repo)
        .join(".claude")
        .join("scripts")
        .join("report-overview.mjs");
    if !script.is_file() {
        return Err(format!(
            "report-overview.mjs not found at {} — reconnect to cloud or copy the script into the project's .claude/scripts/ directory.",
            script.display()
        ));
    }

    let output = Command::new("node")
        .arg(&script)
        .current_dir(&repo)
        .output()
        .map_err(|e| format!("failed to spawn node: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        return Err(format!(
            "report-overview.mjs exited {}; stderr: {}; stdout: {}",
            output.status.code().unwrap_or(-1),
            stderr.trim(),
            stdout.trim(),
        ));
    }

    let line = stdout.trim();
    let parsed: Value = serde_json::from_str(line)
        .map_err(|e| format!("could not parse script output as JSON: {} (raw: {})", e, line))?;

    let ok = parsed.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    if !ok {
        let err = parsed
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown error");
        return Err(format!("script reported failure: {}", err));
    }

    let path = parsed
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("script ok=true but missing path field (raw: {})", line))?;
    Ok(path.to_string())
}
