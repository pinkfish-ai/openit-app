//! Per-turn trace of what the chat-intake agent did.
//!
//! When the chat-intake server invokes `claude -p` with
//! `--output-format stream-json`, claude emits one JSON event per
//! line for each tool call (Read / Bash / Write / Edit / Glob /
//! Grep), each text chunk, and a final `result`. This module wraps
//! that stream:
//!
//!   1. `TraceEvent` is a normalized shape — kind, verb, raw input —
//!      easy to render in the desktop banner / center-panel viewer
//!      without re-parsing claude's wire format on the frontend.
//!   2. `verb_for_tool` maps a `tool_use` block's `name` + `input`
//!      to a human-readable summary ("Reading the ticket",
//!      "Searching the knowledge base for \"login reset\"").
//!   3. `persist_trace` writes the full per-turn trace to
//!      `.openit/agent-traces/<ticketId>/<turnIso>.json` so the
//!      admin can audit what the agent did, after the fact, even if
//!      they weren't watching live.
//!
//! Live streaming to the frontend (banner-shows-latest-verb,
//! center-panel viewer) is layered on top in a follow-up PR — this
//! module just builds the audit-log substrate.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::fs;

/// Normalized record of one step the agent took during a turn. Mostly
/// derived from claude's `stream-json` events; fields are
/// intentionally string-typed so the frontend doesn't need a
/// schema-aware parser. Unknown / unparseable claude events are still
/// captured (kind="raw") so the audit log is lossless.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TraceEvent {
    /// ISO-8601 UTC second-precision timestamp.
    pub ts: String,
    /// Event family. Common values: "tool_use", "tool_result",
    /// "text", "result", "raw".
    pub kind: String,
    /// Tool name when `kind == "tool_use"`. None otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    /// Friendly verb for UI rendering — e.g. "Searching the
    /// knowledge base for \"login reset\"". Falls back to the raw
    /// tool name for unrecognized tools.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verb: Option<String>,
    /// Raw event payload from claude (assistant message, tool_use
    /// block, tool_result, etc.). Kept verbatim so future UI surfaces
    /// can render details on demand without us having to re-stream.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw: Option<Value>,
    /// Plain text content from `text_delta` / final `result.result`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

/// Top-level trace document persisted to disk.
#[derive(Debug, Serialize, Deserialize)]
pub struct TraceDoc {
    pub ticket_id: String,
    pub turn_id: String,
    pub started_at: String,
    pub completed_at: String,
    pub model: String,
    /// Final outcome the dispatcher applied (`answered` / `escalated`
    /// / `resolved`). Filled in by `chat_turn` after parsing the
    /// marker.
    pub outcome: String,
    pub events: Vec<TraceEvent>,
}

/// Map a `tool_use` block to a friendly verb. Returns None for
/// unrecognized tools — caller falls back to the raw tool name in
/// the UI, so the user always sees *something*. Inputs are inspected
/// best-effort; missing / unexpected fields just mean a less specific
/// verb (e.g. "Searching the knowledge base" without the query).
pub fn verb_for_tool(tool: &str, input: &Value) -> Option<String> {
    match tool {
        "Read" => {
            let path = input
                .get("file_path")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            Some(verb_for_read_path(path))
        }
        "Glob" => {
            let pattern = input.get("pattern").and_then(|v| v.as_str()).unwrap_or("");
            if pattern.contains("knowledge-bases") {
                Some("Listing knowledge-base articles".to_string())
            } else if pattern.contains("databases/conversations") {
                Some("Listing the conversation thread".to_string())
            } else if !pattern.is_empty() {
                Some(format!("Searching files matching {}", pattern))
            } else {
                Some("Listing files".to_string())
            }
        }
        "Grep" => Some("Searching for a pattern in the project".to_string()),
        "Bash" => {
            let cmd = input.get("command").and_then(|v| v.as_str()).unwrap_or("");
            Some(verb_for_bash(cmd))
        }
        "Write" => {
            let path = input
                .get("file_path")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if path.contains("databases/conversations/") {
                // The skill is not supposed to write conversation
                // files (server does it), but if a turn does anyway
                // we still want it logged with a recognizable verb.
                Some("Writing a conversation turn (server will dedupe)".to_string())
            } else if path.contains("knowledge-bases/") {
                Some(format!(
                    "Writing the knowledge-base article {}",
                    short_basename(path)
                ))
            } else if !path.is_empty() {
                Some(format!("Writing {}", path))
            } else {
                Some("Writing a file".to_string())
            }
        }
        "Edit" => {
            let path = input
                .get("file_path")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if path.contains("databases/tickets/") {
                Some("Updating the ticket".to_string())
            } else if !path.is_empty() {
                Some(format!("Editing {}", path))
            } else {
                Some("Editing a file".to_string())
            }
        }
        _ => None,
    }
}

fn verb_for_read_path(path: &str) -> String {
    if path.contains("databases/tickets/") {
        "Reading the ticket".to_string()
    } else if path.contains("databases/conversations/") {
        "Reading the conversation history".to_string()
    } else if path.contains("knowledge-bases/") {
        format!("Reading the article \"{}\"", short_basename(path))
    } else if path.contains("agents/") {
        format!("Reading the agent {}", short_basename(path))
    } else if path.ends_with("_schema.json") {
        "Reading a datastore schema".to_string()
    } else if !path.is_empty() {
        format!("Reading {}", path)
    } else {
        "Reading a file".to_string()
    }
}

fn verb_for_bash(cmd: &str) -> String {
    // The skill's only sanctioned shell-out is the kb-search script.
    // Surface that case specially with the query for nicer banner copy.
    if cmd.contains(".claude/scripts/kb-search.mjs") {
        // Pull the first quoted token after the script name.
        if let Some(q) = extract_quoted_argument(cmd) {
            return format!("Searching the knowledge base for \"{}\"", q);
        }
        return "Searching the knowledge base".to_string();
    }
    if cmd.contains(".claude/scripts/sync-resolve-conflict.mjs") {
        return "Resolving a sync conflict".to_string();
    }
    if cmd.contains(".claude/scripts/sync-push.mjs") {
        return "Pushing to the cloud".to_string();
    }
    // Fall back to a truncated command echo so the audit log is still
    // readable for one-off bash runs.
    let short = cmd.chars().take(80).collect::<String>();
    format!("Running: {}", short)
}

/// Strip directory components and extension for a friendlier label.
/// Used in verb formatting so the user sees the article slug, not
/// the full repo-relative path.
fn short_basename(path: &str) -> String {
    let last = path.rsplit('/').next().unwrap_or(path);
    let dotted = last
        .rsplit_once('.')
        .map(|(stem, _ext)| stem)
        .unwrap_or(last);
    dotted.to_string()
}

/// Best-effort extraction of the first quoted argument from a shell
/// command string. Used to pull the kb-search query out of `node ...
/// kb-search.mjs "login reset"`. Handles double quotes only; any
/// shell-escaping nuance falls through to the un-quoted fallback in
/// `verb_for_bash`.
fn extract_quoted_argument(cmd: &str) -> Option<String> {
    let bytes = cmd.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'"' {
            let start = i + 1;
            let mut j = start;
            while j < bytes.len() && bytes[j] != b'"' {
                j += 1;
            }
            if j > start && j < bytes.len() {
                return std::str::from_utf8(&bytes[start..j])
                    .ok()
                    .map(|s| s.to_string());
            }
            return None;
        }
        i += 1;
    }
    None
}

/// Persist a per-turn trace to disk. Path:
///   `<repo>/.openit/agent-traces/<ticketId>/<startedAt-fs-safe>.json`
/// where `startedAt-fs-safe` is the start timestamp with `:`
/// replaced by `-` so the path is portable to Windows. Errors
/// are non-fatal — the agent's reply already landed; an audit-log
/// write failure shouldn't bubble up to the chat surface.
pub async fn persist_trace(repo: &Path, doc: &TraceDoc) -> Result<(), String> {
    let dir = repo
        .join(".openit")
        .join("agent-traces")
        .join(&doc.ticket_id);
    fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("mkdir agent-traces: {}", e))?;
    let safe_started = doc.started_at.replace(':', "-");
    let path = dir.join(format!("{}.json", safe_started));
    let json = serde_json::to_string_pretty(doc).map_err(|e| format!("serialize trace: {}", e))?;
    fs::write(&path, json)
        .await
        .map_err(|e| format!("write trace: {}", e))?;
    Ok(())
}

/// Tauri command: return the latest persisted trace document for a
/// given ticket, or `None` if no trace has been written yet (no
/// turns have been processed by the chat-intake agent for this
/// ticket).
///
/// Used by the desktop UI to render the agent-activity banner's
/// click-through into the center-panel timeline. Filenames are
/// ISO-8601 timestamps with `:` replaced by `-`, so a lex-max sort
/// over directory entries is equivalent to "most recent turn".
#[tauri::command]
pub async fn agent_trace_latest(
    repo: String,
    ticket_id: String,
) -> Result<Option<TraceDoc>, String> {
    let dir = Path::new(&repo)
        .join(".openit")
        .join("agent-traces")
        .join(&ticket_id);
    let mut read_dir = match fs::read_dir(&dir).await {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("read agent-traces dir: {}", e)),
    };
    let mut latest: Option<(String, std::path::PathBuf)> = None;
    while let Some(entry) = read_dir
        .next_entry()
        .await
        .map_err(|e| format!("walk agent-traces dir: {}", e))?
    {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".json") {
            continue;
        }
        let take = match &latest {
            None => true,
            Some((cur, _)) => name.as_str() > cur.as_str(),
        };
        if take {
            latest = Some((name, entry.path()));
        }
    }
    let Some((_, path)) = latest else {
        return Ok(None);
    };
    let bytes = fs::read(&path)
        .await
        .map_err(|e| format!("read trace file: {}", e))?;
    let doc: TraceDoc =
        serde_json::from_slice(&bytes).map_err(|e| format!("parse trace file: {}", e))?;
    Ok(Some(doc))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn verb_for_read_ticket_file() {
        let v = verb_for_tool(
            "Read",
            &json!({ "file_path": "databases/tickets/2026-04-27-abc.json" }),
        );
        assert_eq!(v.as_deref(), Some("Reading the ticket"));
    }

    #[test]
    fn verb_for_read_kb_article() {
        let v = verb_for_tool(
            "Read",
            &json!({ "file_path": "knowledge-bases/default/how-to-reset-password.md" }),
        );
        assert_eq!(
            v.as_deref(),
            Some("Reading the article \"how-to-reset-password\"")
        );
    }

    #[test]
    fn verb_for_kb_search_with_query() {
        let v = verb_for_tool(
            "Bash",
            &json!({ "command": "node .claude/scripts/kb-search.mjs \"login reset\"" }),
        );
        assert_eq!(
            v.as_deref(),
            Some("Searching the knowledge base for \"login reset\"")
        );
    }

    #[test]
    fn verb_for_kb_search_without_quoted_arg() {
        let v = verb_for_tool(
            "Bash",
            &json!({ "command": "node .claude/scripts/kb-search.mjs login" }),
        );
        assert_eq!(v.as_deref(), Some("Searching the knowledge base"));
    }

    #[test]
    fn verb_for_unknown_tool_returns_none() {
        let v = verb_for_tool("WebFetch", &json!({}));
        assert!(v.is_none());
    }

    #[test]
    fn extract_quoted_argument_basic() {
        assert_eq!(
            extract_quoted_argument("node script \"vpn password reset\""),
            Some("vpn password reset".to_string())
        );
    }

    #[test]
    fn extract_quoted_argument_no_quotes() {
        assert_eq!(extract_quoted_argument("node script bare-arg"), None);
    }

    #[test]
    fn short_basename_strips_dir_and_ext() {
        assert_eq!(
            short_basename("knowledge-bases/default/foo-bar.md"),
            "foo-bar"
        );
        assert_eq!(short_basename("plain-file"), "plain-file");
        assert_eq!(
            short_basename("/abs/path/with.many.dots.json"),
            "with.many.dots"
        );
    }

    #[tokio::test]
    async fn persist_trace_writes_file() {
        let tmp = tempfile::tempdir().expect("tmpdir");
        let doc = TraceDoc {
            ticket_id: "ticket-x".into(),
            turn_id: "msg-1".into(),
            started_at: "2026-04-27T18:07:08Z".into(),
            completed_at: "2026-04-27T18:07:25Z".into(),
            model: "haiku".into(),
            outcome: "answered".into(),
            events: vec![TraceEvent {
                ts: "2026-04-27T18:07:08Z".into(),
                kind: "tool_use".into(),
                tool: Some("Read".into()),
                verb: Some("Reading the ticket".into()),
                raw: Some(json!({ "file_path": "databases/tickets/x.json" })),
                text: None,
            }],
        };
        persist_trace(tmp.path(), &doc).await.unwrap();
        let written = tmp
            .path()
            .join(".openit")
            .join("agent-traces")
            .join("ticket-x")
            .join("2026-04-27T18-07-08Z.json");
        assert!(written.is_file());
        let raw = std::fs::read_to_string(written).unwrap();
        let parsed: TraceDoc = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed.events.len(), 1);
        assert_eq!(parsed.events[0].verb.as_deref(), Some("Reading the ticket"));
    }
}
