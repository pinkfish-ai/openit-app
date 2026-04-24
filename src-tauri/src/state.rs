use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub struct AppState {
    pub last_repo: Option<String>,
    pub pane_sizes: Option<Vec<f64>>,
    pub pinned_bubbles: Option<Vec<String>>,
    pub onboarding_complete: bool,
}

fn state_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app_data_dir: {}", e))?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("state.json"))
}

#[tauri::command]
pub fn state_load<R: Runtime>(app: AppHandle<R>) -> Result<AppState, String> {
    let path = state_path(&app)?;
    if !path.exists() {
        return Ok(AppState::default());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn state_save<R: Runtime>(app: AppHandle<R>, state: AppState) -> Result<(), String> {
    let path = state_path(&app)?;
    let json = serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}
