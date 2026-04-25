use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

const KB_DIR: &str = "knowledge-base";
const STATE_FILE: &str = ".openit/kb-state.json";

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct KbState {
    pub collection_id: Option<String>,
    pub collection_name: Option<String>,
    /// filename → last-pulled remote version + mtime at pull time.
    #[serde(default)]
    pub files: HashMap<String, KbFileState>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct KbFileState {
    /// Whatever the server returns as a version (ISO timestamp string).
    pub remote_version: String,
    /// Local file mtime (ms since epoch) at the time of the last pull.
    pub pulled_at_mtime_ms: u128,
}

#[derive(Serialize)]
pub struct KbLocalFile {
    pub filename: String,
    /// Local mtime in ms since epoch. None if the file disappeared between
    /// the directory listing and the stat.
    pub mtime_ms: Option<u128>,
    pub size: u64,
}

fn kb_dir(repo: &str) -> PathBuf {
    Path::new(repo).join(KB_DIR)
}

fn state_path(repo: &str) -> PathBuf {
    Path::new(repo).join(STATE_FILE)
}

fn ensure_dir(p: &Path) -> Result<(), String> {
    fs::create_dir_all(p).map_err(|e| e.to_string())
}

/// Resolve a `<repo>/knowledge-base/<filename>` path and assert it stays
/// inside the KB directory. Guards against `..` segments, absolute paths, or
/// nested separators sneaking in via server responses or future drag sources.
/// `filename` must be a single path component (no directory parts).
fn safe_kb_path(repo: &str, filename: &str) -> Result<PathBuf, String> {
    if filename.is_empty() {
        return Err("filename is empty".into());
    }
    if filename.contains('/') || filename.contains('\\') {
        return Err(format!("filename must not contain path separators: {}", filename));
    }
    let as_path = Path::new(filename);
    if as_path.is_absolute() || as_path.components().count() != 1 {
        return Err(format!("invalid filename: {}", filename));
    }
    if filename == "." || filename == ".." {
        return Err(format!("invalid filename: {}", filename));
    }
    Ok(kb_dir(repo).join(filename))
}

#[tauri::command]
pub fn kb_init(repo: String) -> Result<String, String> {
    let dir = kb_dir(&repo);
    ensure_dir(&dir)?;
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn kb_list_local(repo: String) -> Result<Vec<KbLocalFile>, String> {
    let dir = kb_dir(&repo);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if name.starts_with('.') {
            continue;
        }
        let metadata = match fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let mtime_ms = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|d| d.as_millis());
        out.push(KbLocalFile {
            filename: name,
            mtime_ms,
            size: metadata.len(),
        });
    }
    out.sort_by(|a, b| a.filename.cmp(&b.filename));
    Ok(out)
}

#[tauri::command]
pub fn kb_read_file(repo: String, filename: String) -> Result<String, String> {
    let path = safe_kb_path(&repo, &filename)?;
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn kb_write_file(repo: String, filename: String, content: String) -> Result<(), String> {
    if !is_kb_supported(&filename) {
        let ext = Path::new(&filename)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");
        return Err(format!(
            "Unsupported file type '.{}'. Knowledge base supports: pdf, txt, md, json, csv, docx, xlsx, pptx, jpg, jpeg, png, gif, webp",
            ext
        ));
    }
    let path = safe_kb_path(&repo, &filename)?;
    ensure_dir(&kb_dir(&repo))?;
    fs::write(&path, content).map_err(|e| e.to_string())
}

/// Write raw bytes to `<repo>/knowledge-base/<filename>`. Used by the
/// drag-from-desktop handler so binary files (PDFs, images) round-trip
/// correctly.
#[tauri::command]
pub fn kb_write_file_bytes(repo: String, filename: String, bytes: Vec<u8>) -> Result<(), String> {
    if !is_kb_supported(&filename) {
        let ext = Path::new(&filename)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");
        return Err(format!(
            "Unsupported file type '.{}'. Knowledge base supports: pdf, txt, md, json, csv, docx, xlsx, pptx, jpg, jpeg, png, gif, webp",
            ext
        ));
    }
    let path = safe_kb_path(&repo, &filename)?;
    ensure_dir(&kb_dir(&repo))?;
    fs::write(&path, &bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn kb_delete_file(repo: String, filename: String) -> Result<(), String> {
    let path = safe_kb_path(&repo, &filename)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn kb_state_load(repo: String) -> Result<KbState, String> {
    let path = state_path(&repo);
    if !path.exists() {
        return Ok(KbState::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn kb_state_save(repo: String, state: KbState) -> Result<(), String> {
    let path = state_path(&repo);
    if let Some(parent) = path.parent() {
        ensure_dir(parent)?;
    }
    let json = serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct KbRemoteFile {
    pub id: String,
    pub filename: String,
    pub signed_url: Option<String>,
    pub file_size: Option<u64>,
    pub mime_type: Option<String>,
    pub updated_at: String,
}

/// List files in a Pinkfish KB collection via the skills REST endpoint.
/// `format=full` returns signedUrl per file — required for our pull path.
#[tauri::command]
pub async fn kb_list_remote(
    collection_id: String,
    skills_base_url: String,
    access_token: String,
) -> Result<Vec<KbRemoteFile>, String> {
    let url = format!(
        "{}/filestorage/items?collectionId={}&format=full",
        skills_base_url.trim_end_matches('/'),
        urlencode(&collection_id),
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(&url)
        .header("Auth-Token", format!("Bearer {}", access_token))
        .header("Accept", "*/*")
        .send()
        .await
        .map_err(|e| format!("network error: {}", e))?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, text));
    }

    let parsed: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("could not parse list response: {} — body: {}", e, text))?;
    // The endpoint may return either a bare array or { items: [...] }.
    let items = parsed
        .as_array()
        .cloned()
        .or_else(|| parsed.get("items").and_then(|v| v.as_array()).cloned())
        .unwrap_or_default();

    Ok(items
        .into_iter()
        .map(|it| KbRemoteFile {
            id: it
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            filename: it
                .get("filename")
                .and_then(|v| v.as_str())
                .or_else(|| {
                    it.get("metadata")
                        .and_then(|m| m.get("filename"))
                        .and_then(|v| v.as_str())
                })
                .unwrap_or("")
                .to_string(),
            signed_url: it
                .get("signedUrl")
                .or_else(|| it.get("file_url"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            file_size: it.get("file_size").and_then(|v| v.as_u64()),
            mime_type: it
                .get("mime_type")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            updated_at: it
                .get("updatedAt")
                .or_else(|| it.get("createdAt"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        })
        .collect())
}

#[derive(Serialize, Deserialize)]
pub struct KbUploadResult {
    pub id: String,
    pub filename: String,
    pub file_url: Option<String>,
    pub file_size: Option<u64>,
    pub mime_type: Option<String>,
}

/// Multipart upload of a file from `<repo>/knowledge-base/<filename>` to
/// the Pinkfish skills file storage endpoint. Returns the parsed response
/// (id, filename, etc.) on success. Works for any file type, including
/// binary — we stream the file bytes directly rather than going through
/// the MCP `upload_file` tool's string `fileContent` param.
#[tauri::command]
pub async fn kb_upload_file(
    repo: String,
    filename: String,
    collection_id: String,
    skills_base_url: String,
    access_token: String,
) -> Result<KbUploadResult, String> {
    let path = safe_kb_path(&repo, &filename)?;
    if !path.exists() {
        return Err(format!("file not found: {}", path.display()));
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;

    let url = format!(
        "{}/filestorage/items/upload?collectionId={}",
        skills_base_url.trim_end_matches('/'),
        urlencode(&collection_id)
    );

    let mime = mime_for(&filename);
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(filename.clone())
        .mime_str(&mime)
        .map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("metadata", "{}");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .post(&url)
        .header("Auth-Token", format!("Bearer {}", access_token))
        .header("Accept", "*/*")
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("network error: {}", e))?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, text));
    }
    let parsed: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("could not parse upload response: {} — body: {}", e, text))?;

    Ok(KbUploadResult {
        id: parsed
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        filename: parsed
            .get("metadata")
            .and_then(|m| m.get("filename"))
            .and_then(|v| v.as_str())
            .unwrap_or(filename.as_str())
            .to_string(),
        file_url: parsed
            .get("file_url")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        file_size: parsed.get("file_size").and_then(|v| v.as_u64()),
        mime_type: parsed
            .get("mime_type")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    })
}

/// Percent-encode `s` per RFC 3986 unreserved set, encoding each UTF-8 byte
/// individually so non-ASCII (e.g. accented collection names) round-trips
/// correctly. `c as u32` would emit the codepoint, which is wrong for any
/// multi-byte char.
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// Best-effort MIME from extension. Server detects, so this is just a hint.
fn mime_for(filename: &str) -> String {
    let ext = Path::new(filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "md" | "markdown" => "text/markdown",
        "txt" => "text/plain",
        "json" => "application/json",
        "yaml" | "yml" => "text/yaml",
        "html" | "htm" => "text/html",
        "csv" => "text/csv",
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        _ => "application/octet-stream",
    }
    .to_string()
}

/// Fetch a download URL and save the body into `<repo>/knowledge-base/<filename>`.
/// Used by the puller to materialize remote KB files locally.
#[tauri::command]
pub async fn kb_download_to_local(
    repo: String,
    filename: String,
    url: String,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("network error: {}", e))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!(
            "HTTP {}: {}",
            status,
            resp.text().await.unwrap_or_default()
        ));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;

    let path = safe_kb_path(&repo, &filename)?;
    ensure_dir(&kb_dir(&repo))?;
    fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(())
}

/// Returns true if the file extension is supported by the Pinkfish knowledge base.
/// Based on firebase-helpers/functions/src/utils/llm-supported-types.ts
fn is_kb_supported(filename: &str) -> bool {
    let ext = Path::new(filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(ext.as_str(),
        "pdf" | "txt" | "md" | "markdown" | "json" | "csv" |
        "docx" | "xlsx" | "pptx" |
        "jpg" | "jpeg" | "png" | "gif" | "webp"
    )
}

/// List of supported KB file extensions, for surfacing to the frontend.
#[tauri::command]
pub fn kb_supported_extensions() -> Vec<String> {
    vec![
        "pdf", "txt", "md", "markdown", "json", "csv",
        "docx", "xlsx", "pptx",
        "jpg", "jpeg", "png", "gif", "webp",
    ].into_iter().map(String::from).collect()
}

// ---------------------------------------------------------------------------
// Filestore commands — mirror the kb_* local commands but target
// `filestore/` and `.openit/fs-state.json`.
// ---------------------------------------------------------------------------

const FS_DIR: &str = "filestore";
const FS_STATE_FILE: &str = ".openit/fs-state.json";

fn fs_dir(repo: &str) -> PathBuf {
    Path::new(repo).join(FS_DIR)
}

fn fs_state_path(repo: &str) -> PathBuf {
    Path::new(repo).join(FS_STATE_FILE)
}

#[tauri::command]
pub fn fs_store_init(repo: String) -> Result<String, String> {
    let dir = fs_dir(&repo);
    ensure_dir(&dir)?;
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn fs_store_list_local(repo: String) -> Result<Vec<KbLocalFile>, String> {
    let dir = fs_dir(&repo);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if name.starts_with('.') {
            continue;
        }
        let metadata = match fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let mtime_ms = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|d| d.as_millis());
        out.push(KbLocalFile {
            filename: name,
            mtime_ms,
            size: metadata.len(),
        });
    }
    out.sort_by(|a, b| a.filename.cmp(&b.filename));
    Ok(out)
}

#[tauri::command]
pub fn fs_store_read_file(repo: String, filename: String) -> Result<String, String> {
    let path = fs_dir(&repo).join(&filename);
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fs_store_write_file(repo: String, filename: String, content: String) -> Result<(), String> {
    let dir = fs_dir(&repo);
    ensure_dir(&dir)?;
    let path = dir.join(&filename);
    fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fs_store_write_file_bytes(repo: String, filename: String, bytes: Vec<u8>) -> Result<(), String> {
    let dir = fs_dir(&repo);
    ensure_dir(&dir)?;
    let path = dir.join(&filename);
    fs::write(&path, &bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fs_store_state_load(repo: String) -> Result<KbState, String> {
    let path = fs_state_path(&repo);
    if !path.exists() {
        return Ok(KbState::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fs_store_state_save(repo: String, state: KbState) -> Result<(), String> {
    let path = fs_state_path(&repo);
    if let Some(parent) = path.parent() {
        ensure_dir(parent)?;
    }
    let json = serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Generic entity file writer — writes JSON files to arbitrary subdirectories
// within the repo (e.g. databases/openit-tickets/CS0001237.json).
// ---------------------------------------------------------------------------

/// Write a string (typically JSON) to `<repo>/<subdir>/<filename>`.
/// Creates the subdirectory if it doesn't exist.
#[tauri::command]
pub fn entity_write_file(repo: String, subdir: String, filename: String, content: String) -> Result<(), String> {
    let dir = Path::new(&repo).join(&subdir);
    ensure_dir(&dir)?;
    let path = dir.join(&filename);
    fs::write(&path, content).map_err(|e| e.to_string())
}

/// Remove all files in `<repo>/<subdir>` then recreate it empty.
/// Used to do a clean sync of entity directories.
#[tauri::command]
pub fn entity_clear_dir(repo: String, subdir: String) -> Result<(), String> {
    let dir = Path::new(&repo).join(&subdir);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    ensure_dir(&dir)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urlencode_handles_ascii_unreserved() {
        assert_eq!(urlencode("abcXYZ012-_.~"), "abcXYZ012-_.~");
    }

    #[test]
    fn urlencode_encodes_reserved_ascii() {
        assert_eq!(urlencode("a/b c"), "a%2Fb%20c");
        assert_eq!(urlencode("a+b&c=d"), "a%2Bb%26c%3Dd");
    }

    #[test]
    fn urlencode_encodes_utf8_bytes_not_codepoints() {
        // `é` is U+00E9 — codepoint 0xE9 — but UTF-8 is the two bytes
        // 0xC3 0xA9. The old impl emitted "%E9"; we want "%C3%A9".
        assert_eq!(urlencode("é"), "%C3%A9");
        assert_eq!(urlencode("café"), "caf%C3%A9");
        // 4-byte char (😀) → F0 9F 98 80
        assert_eq!(urlencode("😀"), "%F0%9F%98%80");
    }

    #[test]
    fn safe_kb_path_accepts_plain_filename() {
        let p = safe_kb_path("/tmp/repo", "notes.md").unwrap();
        assert!(p.ends_with("knowledge-base/notes.md"));
    }

    #[test]
    fn safe_kb_path_rejects_traversal_and_separators() {
        assert!(safe_kb_path("/tmp/repo", "../etc/passwd").is_err());
        assert!(safe_kb_path("/tmp/repo", "../../etc/passwd").is_err());
        assert!(safe_kb_path("/tmp/repo", "sub/dir/file.md").is_err());
        assert!(safe_kb_path("/tmp/repo", "/abs/path.md").is_err());
        assert!(safe_kb_path("/tmp/repo", "..").is_err());
        assert!(safe_kb_path("/tmp/repo", ".").is_err());
        assert!(safe_kb_path("/tmp/repo", "").is_err());
        assert!(safe_kb_path("/tmp/repo", "a\\b.md").is_err());
    }

    #[test]
    fn safe_kb_path_allows_dotfiles_and_spaces() {
        // Leading-dot files are filtered out elsewhere (kb_list_local skips
        // them); the path resolver itself shouldn't reject them.
        assert!(safe_kb_path("/tmp/repo", ".env").is_ok());
        assert!(safe_kb_path("/tmp/repo", "Q1 plan.md").is_ok());
        assert!(safe_kb_path("/tmp/repo", "café notes.md").is_ok());
    }
}
