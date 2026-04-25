use std::path::{Path, PathBuf};

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
        // Hide top-level dotfiles/dotdirs except `.claude`, which holds the
        // skills the user edits. Without this whitelist, .git/.vscode/.env
        // would clutter the explorer.
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
    // Sort by path so each dir is followed by its descendants — correct
    // hierarchical reading order in a flat list. Dirs-first within a parent
    // is enforced at render time by the front-end.
    nodes.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(nodes)
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
    fn fs_list_keeps_dot_claude_but_hides_other_dot_dirs() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join(".claude")).unwrap();
        fs::create_dir(dir.path().join(".claude/skills")).unwrap();
        fs::write(dir.path().join(".claude/skills/SKILL.md"), "x").unwrap();
        fs::create_dir(dir.path().join(".git")).unwrap();
        fs::write(dir.path().join(".git/HEAD"), "ref: x").unwrap();

        let nodes = fs_list(dir.path().to_string_lossy().to_string()).unwrap();
        let names: Vec<&str> = nodes.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&".claude"));
        assert!(names.contains(&"SKILL.md"));
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
