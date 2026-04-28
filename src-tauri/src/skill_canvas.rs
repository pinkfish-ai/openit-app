// Skill Canvas state — Tauri side.
//
// The "Skill Canvas" is OpenIT's primary interactive surface (see
// auto-dev/plans/2026-04-27-skill-canvas-plan.md). The shared
// source of truth between Claude (orchestrator) and React (renderer
// + click handler) is a JSON file per skill at:
//
//   <repo>/.openit/skill-state/<skill-name>.json
//
// Three loops meet here:
//
//   - Claude reads the skill markdown, advances state by Edit-ing
//     the JSON.
//   - React watches `.openit/` via the existing fs watcher, reads
//     the JSON when it changes, re-renders the canvas.
//   - Click handlers in the canvas write the JSON via these Tauri
//     commands AND inject a short prompt into the Claude session
//     so the orchestrator knows progress was made out-of-band.
//
// This module is intentionally thin: validate the skill name (it's
// a path component, so it must not contain separators or `..`),
// resolve the path under the repo, do an atomic write-temp +
// rename, and read back as a generic JSON Value. Every schema
// concern (steps, status, action kinds) lives on the FE side. New
// canvas-driven skills don't need a Rust change.

use serde_json::Value;
use std::path::{Path, PathBuf};

const SKILL_STATE_DIR: &str = ".openit/skill-state";

fn validate_skill_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("skill name is empty".into());
    }
    // Skill names are file-stem components — alphanumeric + dashes
    // + underscores. Anything else is either a bug or a
    // path-traversal attempt; reject hard.
    let bad = name
        .chars()
        .any(|c| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    if bad {
        return Err(format!(
            "skill name '{}' contains characters outside [A-Za-z0-9_-]",
            name
        ));
    }
    Ok(())
}

fn skill_state_path(repo: &Path, skill: &str) -> PathBuf {
    repo.join(SKILL_STATE_DIR).join(format!("{}.json", skill))
}

/// Read a skill's canvas state. Returns `Ok(None)` if the file
/// doesn't exist (a perfectly normal state — skill hasn't been
/// invoked yet, or has been completed and cleared); returns an
/// error only on actual IO / parse failure.
#[tauri::command]
pub async fn skill_state_read(repo: String, skill: String) -> Result<Option<Value>, String> {
    let repo_path = PathBuf::from(&repo);
    if !repo_path.is_dir() {
        return Err(format!("skill_state_read: not a directory: {}", repo));
    }
    validate_skill_name(&skill)?;
    let path = skill_state_path(&repo_path, &skill);
    let raw = match tokio::fs::read_to_string(&path).await {
        Ok(s) => s,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("read skill state: {}", err)),
    };
    serde_json::from_str(&raw)
        .map(Some)
        .map_err(|e| format!("parse skill state: {}", e))
}

/// Write (or overwrite) a skill's canvas state. Atomic: writes to a
/// `.tmp-<rand>` sibling and renames into place so the FE watcher
/// never observes a half-written file.
#[tauri::command]
pub async fn skill_state_write(repo: String, skill: String, state: Value) -> Result<(), String> {
    let repo_path = PathBuf::from(&repo);
    if !repo_path.is_dir() {
        return Err(format!("skill_state_write: not a directory: {}", repo));
    }
    validate_skill_name(&skill)?;
    let dir = repo_path.join(SKILL_STATE_DIR);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("mkdir skill-state dir: {}", e))?;
    let path = skill_state_path(&repo_path, &skill);
    let body = serde_json::to_string_pretty(&state)
        .map_err(|e| format!("serialize skill state: {}", e))?;
    let tmp = path.with_extension(format!(
        "tmp-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    tokio::fs::write(&tmp, body)
        .await
        .map_err(|e| format!("write tmp skill state: {}", e))?;
    tokio::fs::rename(&tmp, &path)
        .await
        .map_err(|e| format!("rename skill state into place: {}", e))?;
    Ok(())
}

/// Delete a skill's canvas state. Idempotent — non-existence is
/// not an error. Used by the `Disconnect` / `Done` paths to clear
/// the canvas without leaving a stale file behind.
#[tauri::command]
pub async fn skill_state_clear(repo: String, skill: String) -> Result<(), String> {
    let repo_path = PathBuf::from(&repo);
    if !repo_path.is_dir() {
        return Err(format!("skill_state_clear: not a directory: {}", repo));
    }
    validate_skill_name(&skill)?;
    let path = skill_state_path(&repo_path, &skill);
    match tokio::fs::remove_file(&path).await {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("delete skill state: {}", err)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skill_name_validation_rejects_traversal_and_separators() {
        assert!(validate_skill_name("connect-slack").is_ok());
        assert!(validate_skill_name("answer_ticket").is_ok());
        assert!(validate_skill_name("a1b2").is_ok());
        assert!(validate_skill_name("").is_err());
        assert!(validate_skill_name("..").is_err());
        assert!(validate_skill_name("foo/bar").is_err());
        assert!(validate_skill_name("foo\\bar").is_err());
        assert!(validate_skill_name("foo.bar").is_err()); // dots not allowed → no `.json` injection
        assert!(validate_skill_name(" foo").is_err());
    }

    #[tokio::test]
    async fn read_missing_returns_none() {
        let tmp = tempfile::tempdir().unwrap();
        let got = skill_state_read(
            tmp.path().to_string_lossy().into(),
            "connect-slack".to_string(),
        )
        .await
        .unwrap();
        assert!(got.is_none());
    }

    #[tokio::test]
    async fn write_then_read_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().to_string_lossy().into_owned();
        let payload = serde_json::json!({ "skill": "connect-slack", "active": true, "steps": [] });
        skill_state_write(repo.clone(), "connect-slack".to_string(), payload.clone())
            .await
            .unwrap();
        let got = skill_state_read(repo, "connect-slack".to_string())
            .await
            .unwrap()
            .expect("state file should exist after write");
        assert_eq!(got, payload);
    }

    #[tokio::test]
    async fn clear_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().to_string_lossy().into_owned();
        // Clear when nothing exists — no error.
        skill_state_clear(repo.clone(), "connect-slack".to_string())
            .await
            .unwrap();
        // Write then clear → file gone.
        skill_state_write(
            repo.clone(),
            "connect-slack".to_string(),
            serde_json::json!({}),
        )
        .await
        .unwrap();
        skill_state_clear(repo.clone(), "connect-slack".to_string())
            .await
            .unwrap();
        let got = skill_state_read(repo, "connect-slack".to_string())
            .await
            .unwrap();
        assert!(got.is_none());
    }
}
