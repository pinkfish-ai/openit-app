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
    let path = kb_dir(&repo).join(&filename);
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn kb_write_file(repo: String, filename: String, content: String) -> Result<(), String> {
    let dir = kb_dir(&repo);
    ensure_dir(&dir)?;
    let path = dir.join(&filename);
    fs::write(&path, content).map_err(|e| e.to_string())
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

    let dir = kb_dir(&repo);
    ensure_dir(&dir)?;
    let path = dir.join(&filename);
    fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(())
}
