use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use walkdir::WalkDir;

#[derive(Serialize, Clone)]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

const SKIP_DIRS: &[&str] = &["node_modules", ".git", "target", "dist", ".venv"];
const MAX_DEPTH: usize = 6;

#[tauri::command]
pub fn fs_list(root: String) -> Result<Vec<FileNode>, String> {
    let root_path = PathBuf::from(&root);
    if !root_path.exists() {
        return Err(format!("path does not exist: {}", root));
    }

    let mut nodes = Vec::new();
    let walker = WalkDir::new(&root_path)
        .min_depth(1)
        .max_depth(MAX_DEPTH)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !is_skipped(e.path(), &root_path));

    for entry in walker.flatten() {
        let path = entry.path();
        let rel = path.strip_prefix(&root_path).unwrap_or(path);
        // Top-level dotdirs split into two buckets:
        //   - Always hidden: `.git`, `.openit` (engine state),
        //     `.vscode`, `.env*` (creds). Tooling internals — the user
        //     never wants to see these.
        //   - User-toggleable: `.claude` (skills source). Returned
        //     here; the explorer filters under its "show system
        //     files" toggle.
        let top = rel
            .components()
            .next()
            .and_then(|c| c.as_os_str().to_str())
            .unwrap_or("");
        if top.starts_with('.') && top != ".claude" {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        // Skip OS noise files at any depth.
        if name == ".DS_Store" || name == "Thumbs.db" {
            continue;
        }
        nodes.push(FileNode {
            name,
            path: path.to_string_lossy().to_string(),
            is_dir: entry.file_type().is_dir(),
        });
    }
    // Sort by a custom key so each dir is followed by its descendants
    // — correct hierarchical reading order in a flat list. The custom
    // key inverts ordering for direct children of `databases/tickets/`
    // and `databases/conversations/` so the user sees newest-first
    // there (ticket / thread names start with an ISO timestamp prefix,
    // so descending name = descending time).
    nodes.sort_by(|a, b| {
        descending_for_threads_key(&a.path).cmp(&descending_for_threads_key(&b.path))
    });
    Ok(nodes)
}

/// Build a sort key that mostly preserves path order but reverses
/// direct children of `databases/tickets/` and `databases/conversations/`.
/// Implementation: detect whether the path lives under one of those
/// dirs and replace the immediate child segment with its character-
/// inverse (`u32::MAX - codepoint` per char), which makes lexical
/// ordering on the key equivalent to descending order on that segment.
/// All other segments stay as-is so hierarchy and depth-first
/// traversal are preserved.
fn descending_for_threads_key(path: &str) -> String {
    for marker in ["/databases/tickets/", "/databases/conversations/"] {
        if let Some(idx) = path.find(marker) {
            let prefix_end = idx + marker.len();
            let after = &path[prefix_end..];
            let (child, rest) = after
                .find('/')
                .map(|i| (&after[..i], &after[i..]))
                .unwrap_or((after, ""));
            let inverted: String = child
                .chars()
                .map(|c| char::from_u32(0x10_FFFF - (c as u32)).unwrap_or('\u{10FFFF}'))
                .collect();
            let mut key = String::with_capacity(path.len() + 8);
            key.push_str(&path[..prefix_end]);
            key.push_str(&inverted);
            key.push_str(rest);
            return key;
        }
    }
    path.to_string()
}

#[tauri::command]
pub fn fs_read(path: String) -> Result<String, String> {
    const MAX_BYTES: u64 = 1_000_000;
    let metadata = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if metadata.len() > MAX_BYTES {
        return Err(format!(
            "file is too large to preview ({} bytes; max {})",
            metadata.len(),
            MAX_BYTES
        ));
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Read a file as raw bytes. Used by the viewer to preview images and
/// other non-UTF8 content via data URLs.
#[tauri::command]
pub fn fs_read_bytes(path: String) -> Result<Vec<u8>, String> {
    const MAX_BYTES: u64 = 5_000_000;
    let metadata = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if metadata.len() > MAX_BYTES {
        return Err(format!(
            "file is too large to preview ({} bytes; max {})",
            metadata.len(),
            MAX_BYTES
        ));
    }
    std::fs::read(&path).map_err(|e| e.to_string())
}

fn is_skipped(p: &Path, root: &Path) -> bool {
    let rel = match p.strip_prefix(root) {
        Ok(r) => r,
        Err(_) => return false,
    };
    rel.components().any(|c| {
        let s = c.as_os_str().to_string_lossy();
        SKIP_DIRS.contains(&s.as_ref())
    })
}

#[tauri::command]
pub fn fs_reveal(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("-R")
            .arg(&path)
            .output()
            .map_err(|e| format!("failed to reveal file: {}", e))?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        // On Windows/Linux, open the parent directory
        if let Some(parent) = Path::new(&path).parent() {
            Command::new(if cfg!(target_os = "windows") {
                "explorer"
            } else {
                "xdg-open"
            })
            .arg(parent)
            .output()
            .map_err(|e| format!("failed to reveal file: {}", e))?;
        }
    }
    Ok(())
}

/// Delete a single file at `path`. Returns Ok(()) if the file was missing
/// (idempotent). Refuses to remove directories — used by the file
/// explorer's context menu where the user expects file-level deletes only.
#[tauri::command]
pub fn fs_delete(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Ok(());
    }
    if p.is_dir() {
        return Err(format!("refusing to delete a directory: {}", path));
    }
    std::fs::remove_file(p).map_err(|e| format!("failed to delete file: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn fs_list_skips_node_modules_and_dotfiles() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join("src")).unwrap();
        fs::create_dir(dir.path().join("node_modules")).unwrap();
        fs::write(dir.path().join("src/file.ts"), "x").unwrap();
        fs::write(dir.path().join("node_modules/foo.js"), "y").unwrap();
        fs::write(dir.path().join(".env"), "z").unwrap();
        fs::write(dir.path().join("README.md"), "w").unwrap();

        let nodes = fs_list(dir.path().to_string_lossy().to_string()).unwrap();
        let names: Vec<&str> = nodes.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&"file.ts"));
        assert!(names.contains(&"README.md"));
        assert!(!names.iter().any(|n| n.starts_with(".env")));
        assert!(!names.iter().any(|n| *n == "foo.js"));
    }

    #[test]
    fn fs_list_returns_dot_claude_but_hides_other_dot_dirs() {
        // `.claude` (skills source) is user-toggleable so fs_list
        // returns it; the frontend FileExplorer filters under a
        // "show system files" toggle. Everything else dotty
        // (`.git`, `.openit`, `.vscode`) is always hidden — those
        // are tooling internals the user never wants to see.
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join(".claude")).unwrap();
        fs::create_dir(dir.path().join(".claude/skills")).unwrap();
        fs::write(dir.path().join(".claude/skills/SKILL.md"), "x").unwrap();
        fs::create_dir(dir.path().join(".git")).unwrap();
        fs::write(dir.path().join(".git/HEAD"), "ref: x").unwrap();
        fs::write(dir.path().join("README.md"), "y").unwrap();

        let nodes = fs_list(dir.path().to_string_lossy().to_string()).unwrap();
        let names: Vec<&str> = nodes.iter().map(|n| n.name.as_str()).collect();
        // Regular files come through.
        assert!(names.contains(&"README.md"));
        // .claude AND its descendants come through (frontend will hide).
        assert!(names.contains(&".claude"));
        assert!(names.contains(&"SKILL.md"));
        // .git and its contents stay hidden — never surfaced.
        assert!(!names.contains(&".git"));
        assert!(!names.contains(&"HEAD"));
    }

    #[test]
    fn fs_read_rejects_oversized_files() {
        let dir = tempdir().unwrap();
        let big = dir.path().join("big.txt");
        fs::write(&big, vec![b'x'; 1_000_001]).unwrap();
        let err = fs_read(big.to_string_lossy().to_string()).unwrap_err();
        assert!(err.contains("too large"));
    }
}
