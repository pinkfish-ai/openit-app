//! Tools install/uninstall via Homebrew + project CLAUDE.md splicing.
//!
//! Hybrid model: the happy path runs `brew install` directly so the UI
//! sees deterministic success/failure. Brew failure surfaces stderr to
//! the frontend, which then offers a "Ask Claude to debug" fallback —
//! Claude gets the actual error and can pick an alternate install
//! method (curl, dnf, dotnet tool, etc.) that brew couldn't handle.
//!
//! The splicer maintains a marker block in the project CLAUDE.md so
//! Claude knows which tools are available. Pure-string transforms with
//! per-entry `<!-- entry:ID -->` sub-markers, idempotent and
//! independently unit-tested.

use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};

const BLOCK_START: &str = "<!-- openit:tools:start -->";
const BLOCK_END: &str = "<!-- openit:tools:end -->";
const ENTRY_PREFIX: &str = "<!-- entry:";
const ENTRY_SUFFIX: &str = " -->";

/// Returns true if `binary` is on PATH. Used by the catalog UI to flip
/// each card between "Install" and "Uninstall" without tracking
/// install-source state separately.
#[tauri::command]
pub fn tools_is_installed(binary: String) -> bool {
    which::which(&binary).is_ok()
}

/// Returns the target OS as a stable string the frontend can branch on:
/// "macos", "windows", "linux", or "unknown". macOS keeps the
/// programmatic brew install path; everywhere else routes through
/// Claude (which knows the right per-OS install method and avoids us
/// maintaining a per-tool, per-OS install matrix).
#[tauri::command]
pub fn tools_target_os() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unknown"
    }
}

#[derive(serde::Deserialize)]
pub struct ToolInstallArgs {
    pub project_root: String,
    pub brew_pkg: String,
    pub entry_id: String,
    /// Single-line guidance for Claude — written verbatim under the
    /// section header so Claude knows what the tool is good for.
    pub claude_md_line: String,
}

#[derive(serde::Deserialize)]
pub struct ToolUninstallArgs {
    pub project_root: String,
    pub brew_pkg: String,
    pub entry_id: String,
}

/// Run `brew install <pkg>` and add the entry to CLAUDE.md. Brew
/// failure short-circuits without writing the hint — we only register
/// tools that actually installed. Brew stderr propagates verbatim so
/// the UI can offer it to the "Ask Claude to debug" fallback.
#[tauri::command]
pub async fn tools_install(args: ToolInstallArgs) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || install_blocking(args))
        .await
        .map_err(|e| format!("background task failed: {}", e))?
}

fn install_blocking(args: ToolInstallArgs) -> Result<(), String> {
    brew_run("install", &args.brew_pkg)?;
    splice_claude_md(&args.project_root, |existing| {
        upsert_tool_entry(existing, &args.entry_id, &args.claude_md_line)
    })?;
    Ok(())
}

/// Run `brew uninstall <pkg>` and remove the entry from CLAUDE.md. We
/// proceed with the CLAUDE.md update even if brew uninstall fails (the
/// tool may have been installed by some other means — manual installer,
/// pip, etc.) so the hint goes away regardless. The error is still
/// surfaced so the UI can offer the recovery affordance.
#[tauri::command]
pub async fn tools_uninstall(args: ToolUninstallArgs) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || uninstall_blocking(args))
        .await
        .map_err(|e| format!("background task failed: {}", e))?
}

fn uninstall_blocking(args: ToolUninstallArgs) -> Result<(), String> {
    let brew_result = brew_run("uninstall", &args.brew_pkg);
    splice_claude_md(&args.project_root, |existing| {
        remove_tool_entry(existing, &args.entry_id)
    })?;
    brew_result
}

/// Strip the OpenIT-managed tools block entry from CLAUDE.md without
/// touching any installed binary. Used as the "remove from CLAUDE.md
/// only" recovery path when brew uninstall fails because the tool was
/// installed out-of-band.
#[tauri::command]
pub async fn tools_remove_hint_only(project_root: String, entry_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        splice_claude_md(&project_root, |existing| {
            remove_tool_entry(existing, &entry_id)
        })
    })
    .await
    .map_err(|e| format!("background task failed: {}", e))?
}

fn brew_run(verb: &str, pkg: &str) -> Result<(), String> {
    let brew = which::which("brew").map_err(|_| {
        "Homebrew not found on PATH — install brew first (https://brew.sh) or use the 'Ask Claude to debug' fallback for an alternate install path.".to_string()
    })?;
    let output = Command::new(&brew)
        .arg(verb)
        .arg(pkg)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("failed to spawn brew: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "brew {} {} failed (exit {}): {}",
            verb,
            pkg,
            output.status,
            stderr.trim()
        ));
    }
    Ok(())
}

/// Read CLAUDE.md (or treat as empty if missing), apply the mutator,
/// write back. Mutator is a pure string transform so the upsert/remove
/// helpers stay independently testable.
fn splice_claude_md<F>(project_root: &str, mutator: F) -> Result<(), String>
where
    F: FnOnce(&str) -> String,
{
    let path: PathBuf = [project_root, "CLAUDE.md"].iter().collect();
    let existing = fs::read_to_string(&path).unwrap_or_default();
    let next = mutator(&existing);
    if next == existing {
        return Ok(());
    }
    fs::write(&path, next).map_err(|e| format!("failed to write CLAUDE.md: {}", e))?;
    Ok(())
}

/// Add or replace the line for `entry_id` in the CLAUDE.md OpenIT
/// block. Idempotent — re-installing the same entry overwrites the
/// line in place rather than duplicating.
fn upsert_tool_entry(claude_md: &str, entry_id: &str, line: &str) -> String {
    let entry_line = format!("{}{}{}- {}", ENTRY_PREFIX, entry_id, ENTRY_SUFFIX, line);
    let entries = parse_block(claude_md);
    let mut next: Vec<(String, String)> = entries
        .into_iter()
        .filter(|(id, _)| id != entry_id)
        .collect();
    next.push((entry_id.to_string(), entry_line));
    next.sort_by(|a, b| a.0.cmp(&b.0));
    rewrite_block(claude_md, next)
}

fn remove_tool_entry(claude_md: &str, entry_id: &str) -> String {
    let entries = parse_block(claude_md);
    let next: Vec<(String, String)> = entries
        .into_iter()
        .filter(|(id, _)| id != entry_id)
        .collect();
    rewrite_block(claude_md, next)
}

/// Extract `(entry_id, full_line)` pairs from inside the marker block.
/// Lines without an `<!-- entry:ID -->` prefix are ignored.
fn parse_block(claude_md: &str) -> Vec<(String, String)> {
    let Some(start) = claude_md.find(BLOCK_START) else {
        return Vec::new();
    };
    let Some(end_rel) = claude_md[start..].find(BLOCK_END) else {
        return Vec::new();
    };
    let body = &claude_md[start + BLOCK_START.len()..start + end_rel];
    let mut out = Vec::new();
    for line in body.lines() {
        if let Some(rest) = line.strip_prefix(ENTRY_PREFIX) {
            if let Some(idx) = rest.find(ENTRY_SUFFIX) {
                let id = rest[..idx].to_string();
                out.push((id, line.to_string()));
            }
        }
    }
    out
}

/// Rewrite the CLAUDE.md, replacing the existing OpenIT block (if any)
/// with one rendered from `entries`. Removing the last entry strips
/// the block entirely so the file doesn't accumulate empty scaffolding.
fn rewrite_block(claude_md: &str, entries: Vec<(String, String)>) -> String {
    let block = if entries.is_empty() {
        String::new()
    } else {
        let mut s = String::new();
        s.push_str(BLOCK_START);
        s.push_str("\n## Installed tools\n\n");
        s.push_str(
            "These tools are installed locally and available via Bash. Prefer them over hand-rolled API calls or scraping; for unfamiliar commands run `<tool> --help` to discover capabilities.\n\n",
        );
        for (_, line) in &entries {
            s.push_str(line);
            s.push('\n');
        }
        s.push_str(BLOCK_END);
        s
    };

    if let Some(start) = claude_md.find(BLOCK_START) {
        if let Some(end_rel) = claude_md[start..].find(BLOCK_END) {
            let end = start + end_rel + BLOCK_END.len();
            let mut next = String::new();
            next.push_str(&claude_md[..start]);
            if block.is_empty() {
                let trimmed = next.trim_end_matches('\n');
                next.truncate(trimmed.len());
                if !next.is_empty() {
                    next.push('\n');
                }
            } else {
                next.push_str(&block);
            }
            next.push_str(&claude_md[end..]);
            return next;
        }
    }

    if block.is_empty() {
        return claude_md.to_string();
    }
    let mut out = claude_md.trim_end_matches('\n').to_string();
    if !out.is_empty() {
        out.push_str("\n\n");
    }
    out.push_str(&block);
    out.push('\n');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upsert_into_empty_file_appends_block() {
        let result = upsert_tool_entry("", "gh", "GitHub CLI is installed.");
        assert!(result.contains(BLOCK_START));
        assert!(result.contains(BLOCK_END));
        assert!(result.contains("<!-- entry:gh -->- GitHub CLI is installed."));
    }

    #[test]
    fn upsert_preserves_existing_content_above() {
        let existing = "# My project\n\nSome notes.\n";
        let result = upsert_tool_entry(existing, "gh", "GitHub CLI is installed.");
        assert!(result.starts_with("# My project\n\nSome notes."));
        assert!(result.contains("<!-- entry:gh -->"));
    }

    #[test]
    fn upsert_replaces_in_place_for_same_id() {
        let first = upsert_tool_entry("", "gh", "Old hint.");
        let second = upsert_tool_entry(&first, "gh", "New hint.");
        assert!(!second.contains("Old hint."));
        assert!(second.contains("New hint."));
        let count = second.matches("<!-- entry:gh -->").count();
        assert_eq!(count, 1);
    }

    #[test]
    fn upsert_sorts_entries_by_id() {
        let s = upsert_tool_entry("", "gh", "gh hint.");
        let s = upsert_tool_entry(&s, "aws", "aws hint.");
        let aws_idx = s.find("entry:aws").unwrap();
        let gh_idx = s.find("entry:gh").unwrap();
        assert!(aws_idx < gh_idx, "aws should come before gh alphabetically");
    }

    #[test]
    fn remove_drops_entry_and_block_when_last() {
        let s = upsert_tool_entry("", "gh", "gh hint.");
        let s = remove_tool_entry(&s, "gh");
        assert!(!s.contains(BLOCK_START));
        assert!(!s.contains(BLOCK_END));
    }

    #[test]
    fn remove_keeps_block_when_other_entries_remain() {
        let s = upsert_tool_entry("", "gh", "gh hint.");
        let s = upsert_tool_entry(&s, "aws", "aws hint.");
        let s = remove_tool_entry(&s, "gh");
        assert!(s.contains(BLOCK_START));
        assert!(s.contains("entry:aws"));
        assert!(!s.contains("entry:gh"));
    }

    #[test]
    fn remove_is_noop_for_unknown_id() {
        let original = "# README\n";
        let result = remove_tool_entry(original, "nonexistent");
        assert_eq!(result, original);
    }

    #[test]
    fn parse_block_returns_entries_in_file_order() {
        let s = upsert_tool_entry("", "aws", "aws hint.");
        let s = upsert_tool_entry(&s, "gh", "gh hint.");
        let entries = parse_block(&s);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].0, "aws");
        assert_eq!(entries[1].0, "gh");
    }
}
