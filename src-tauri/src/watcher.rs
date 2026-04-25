use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher, Event, EventKind};
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime, State};

/// Holds an optional active watcher so we can stop it on demand.
#[derive(Default)]
pub struct WatcherState {
    inner: Mutex<Option<RecommendedWatcher>>,
}

#[derive(Serialize, Clone, Debug)]
pub struct FsChanged {
    pub paths: Vec<String>,
}

/// Start watching `path` recursively. Emits `fs://changed` events to the
/// frontend whenever files are created, modified, or removed.
/// Debounces at 500ms so rapid writes (e.g. Claude saving multiple files)
/// collapse into a single event.
#[tauri::command]
pub fn fs_watch_start<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, WatcherState>,
    path: String,
) -> Result<(), String> {
    let mut guard = state.inner.lock();

    // Stop any existing watcher first.
    *guard = None;

    let watch_path = PathBuf::from(&path);
    if !watch_path.is_dir() {
        return Err(format!("Not a directory: {path}"));
    }

    // Collect changed paths into a buffer, flush on a timer.
    let buffer: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let buffer_for_flush = Arc::clone(&buffer);
    let app_for_flush = app.clone();

    // Flush thread: every 500ms, drain the buffer and emit one event.
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(500));
            let paths: Vec<String> = {
                let mut buf = buffer_for_flush.lock();
                if buf.is_empty() {
                    continue;
                }
                buf.drain(..).collect()
            };
            // Deduplicate
            let mut unique: Vec<String> = paths;
            unique.sort();
            unique.dedup();
            let _ = app_for_flush.emit("fs://changed", FsChanged { paths: unique });
        }
    });

    let buffer_for_handler = Arc::clone(&buffer);

    let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
        if let Ok(event) = res {
            match event.kind {
                EventKind::Create(_)
                | EventKind::Modify(_)
                | EventKind::Remove(_) => {
                    let mut buf = buffer_for_handler.lock();
                    for p in &event.paths {
                        // Skip .git directory changes — too noisy
                        let path_str = p.to_string_lossy();
                        if path_str.contains("/.git/") || path_str.ends_with("/.git") {
                            continue;
                        }
                        buf.push(path_str.into_owned());
                    }
                }
                _ => {}
            }
        }
    })
    .map_err(|e| format!("Failed to create watcher: {e}"))?;

    watcher
        .watch(&watch_path, RecursiveMode::Recursive)
        .map_err(|e| format!("Failed to watch {path}: {e}"))?;

    *guard = Some(watcher);
    Ok(())
}

/// Stop watching.
#[tauri::command]
pub fn fs_watch_stop(state: State<'_, WatcherState>) {
    let mut guard = state.inner.lock();
    *guard = None;
}
