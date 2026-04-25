//! Local git helpers for OpenIT: init, auto-commit, status, diffs.
//! Shells out to the system `git` CLI (same pattern as `git_history.rs`).

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

const GITIGNORE: &str = ".DS_Store\n.openit/kb-state.json\nknowledge-base/*.server.*\n";

fn git_dir(repo: &str) -> PathBuf {
    Path::new(repo).join(".git")
}

fn run_git(repo: &str, args: &[&str]) -> Result<std::process::Output, String> {
    let mut cmd = Command::new("git");
    cmd.args(["-C", repo]).args(args);
    cmd.output()
        .map_err(|e| format!("failed to run git: {}", e))
}

/// Ensure `.gitignore` exists with OpenIT defaults (idempotent append of missing lines).
fn write_gitignore(repo: &str) -> Result<(), String> {
    let path = Path::new(repo).join(".gitignore");
    let existing = if path.exists() {
        fs::read_to_string(&path).map_err(|e| e.to_string())?
    } else {
        String::new()
    };
    let mut out = existing;
    for line in GITIGNORE.lines() {
        let needle = line.trim();
        if needle.is_empty() {
            continue;
        }
        if !out.lines().any(|l| l.trim() == needle) {
            if !out.is_empty() && !out.ends_with('\n') {
                out.push('\n');
            }
            out.push_str(line);
            out.push('\n');
        }
    }
    fs::write(&path, out).map_err(|e| e.to_string())
}

/// Initialize a git repo at `repo` if missing. Writes `.gitignore`, sets local
/// identity, and creates an initial commit when possible.
#[tauri::command]
pub fn git_ensure_repo(repo: String) -> Result<(), String> {
    if git_dir(&repo).exists() {
        write_gitignore(&repo)?;
        return Ok(());
    }

    let output = run_git(
        &repo,
        &["init", "-b", "main"],
    )?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }

    // Local-only identity so commits never fail on missing user.name.
    let _ = run_git(&repo, &["config", "user.email", "openit@local"])?;
    let _ = run_git(&repo, &["config", "user.name", "OpenIT"])?;

    write_gitignore(&repo)?;

    // Ensure at least one tracked file for first commit (README may already exist).
    let readme = Path::new(&repo).join("README.md");
    if !readme.exists() {
        fs::write(
            &readme,
            "# OpenIT project\n\nLocal git tracks sync history for this folder.\n",
        )
        .map_err(|e| e.to_string())?;
    }

    let add = run_git(&repo, &["add", "-A"])?;
    if !add.status.success() {
        return Err(String::from_utf8_lossy(&add.stderr).into_owned());
    }

    let commit = run_git(
        &repo,
        &["commit", "-m", "init: OpenIT project", "--allow-empty"],
    )?;
    if !commit.status.success() {
        return Err(String::from_utf8_lossy(&commit.stderr).into_owned());
    }
    Ok(())
}

/// Stage all changes and commit. Returns `true` if a new commit was created.
#[tauri::command]
pub fn git_add_and_commit(repo: String, message: String) -> Result<bool, String> {
    if !git_dir(&repo).exists() {
        git_ensure_repo(repo.clone())?;
    }

    let porcelain = run_git(&repo, &["status", "--porcelain"])?;
    if !porcelain.status.success() {
        return Err(String::from_utf8_lossy(&porcelain.stderr).into_owned());
    }
    if String::from_utf8_lossy(&porcelain.stdout).trim().is_empty() {
        return Ok(false);
    }

    let add = run_git(&repo, &["add", "-A"])?;
    if !add.status.success() {
        return Err(String::from_utf8_lossy(&add.stderr).into_owned());
    }

    let commit = run_git(
        &repo,
        &["commit", "-m", message.as_str()],
    )?;
    if !commit.status.success() {
        let stderr = String::from_utf8_lossy(&commit.stderr);
        // Nothing to commit after add can happen with only ignored files.
        if stderr.contains("nothing to commit") {
            return Ok(false);
        }
        return Err(stderr.into_owned());
    }
    Ok(true)
}

#[derive(Serialize, Clone, Debug)]
pub struct GitFileStatus {
    pub path: String,
    /// One of: "?", "M", "A", "D", "UU" (unmerged / conflict).
    pub status: String,
    /// Whether the file is staged (in the index).
    pub staged: bool,
}

/// `git status --porcelain` mapped to simple statuses for the file tree UI.
/// Files that have both staged and unstaged changes appear twice (once each).
#[tauri::command]
pub fn git_status_short(repo: String) -> Result<Vec<GitFileStatus>, String> {
    if !git_dir(&repo).exists() {
        return Ok(Vec::new());
    }
    let output = run_git(&repo, &["status", "--porcelain"])?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim_end();
        if line.len() < 3 {
            continue;
        }
        let xy_bytes = line.as_bytes();
        let x = xy_bytes[0] as char;
        let y = xy_bytes[1] as char;
        let rest = line[2..].trim_start();
        if rest.is_empty() {
            continue;
        }
        if x == '!' {
            continue;
        }

        let path = if let Some(idx) = rest.rfind(" -> ") {
            rest[idx + 4..].trim().to_string()
        } else {
            rest.to_string()
        };

        if x == '?' && y == '?' {
            out.push(GitFileStatus { path, status: "?".to_string(), staged: false });
            continue;
        }
        if x == 'U' || y == 'U' || (x == 'A' && y == 'A') || (x == 'D' && y == 'D') {
            out.push(GitFileStatus { path, status: "UU".to_string(), staged: false });
            continue;
        }

        // Index (staged) status
        if x != ' ' {
            let st = match x {
                'M' | 'T' => "M",
                'A' => "A",
                'D' => "D",
                'R' => "M",
                'C' => "A",
                _ => "M",
            };
            out.push(GitFileStatus { path: path.clone(), status: st.to_string(), staged: true });
        }

        // Worktree (unstaged) status
        if y != ' ' {
            let st = match y {
                'M' | 'T' => "M",
                'D' => "D",
                _ => "M",
            };
            out.push(GitFileStatus { path: path.clone(), status: st.to_string(), staged: false });
        }
    }
    Ok(out)
}

/// Stage specific paths (`git add <paths>`).
#[tauri::command]
pub fn git_stage(repo: String, paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut args = vec!["add", "--"];
    let refs: Vec<&str> = paths.iter().map(|s| s.as_str()).collect();
    args.extend(refs);
    let out = run_git(&repo, &args)?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    Ok(())
}

/// Unstage specific paths (`git reset HEAD <paths>`).
#[tauri::command]
pub fn git_unstage(repo: String, paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut args = vec!["reset", "HEAD", "--"];
    let refs: Vec<&str> = paths.iter().map(|s| s.as_str()).collect();
    args.extend(refs);
    let out = run_git(&repo, &args)?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        if !stderr.contains("unstaged") {
            return Err(stderr.into_owned());
        }
    }
    Ok(())
}

/// Commit only what is currently staged. Returns `true` if a commit was created.
#[tauri::command]
pub fn git_commit_staged(repo: String, message: String) -> Result<bool, String> {
    if !git_dir(&repo).exists() {
        return Err("no git repository".to_string());
    }
    let diff = run_git(&repo, &["diff", "--cached", "--quiet"])?;
    if diff.status.success() {
        return Ok(false);
    }
    let commit = run_git(&repo, &["commit", "-m", message.as_str()])?;
    if !commit.status.success() {
        let stderr = String::from_utf8_lossy(&commit.stderr);
        if stderr.contains("nothing to commit") {
            return Ok(false);
        }
        return Err(stderr.into_owned());
    }
    Ok(true)
}

/// Unified diff of `path` against `HEAD`.
#[tauri::command]
pub fn git_file_diff(repo: String, path: String) -> Result<String, String> {
    let output = run_git(&repo, &["diff", "HEAD", "--", &path])?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// True if any tracked file contains unresolved merge conflict markers.
#[tauri::command]
pub fn git_has_conflict_markers(repo: String) -> Result<bool, String> {
    if !git_dir(&repo).exists() {
        return Ok(false);
    }
    let output = Command::new("git")
        .args(["-C", &repo, "grep", "-l", "<<<<<<<"])
        .output()
        .map_err(|e| format!("failed to run git grep: {}", e))?;
    if output.status.success() {
        return Ok(!output.stdout.is_empty());
    }
    // grep exits 1 when no matches — not an error.
    if output.status.code() == Some(1) {
        return Ok(false);
    }
    Err(String::from_utf8_lossy(&output.stderr).into_owned())
}

/// Paths changed between `base_sha` and `HEAD` (exclusive base, inclusive HEAD).
#[tauri::command]
pub fn git_diff_name_only(repo: String, base_sha: String) -> Result<Vec<String>, String> {
    if !git_dir(&repo).exists() {
        return Ok(Vec::new());
    }
    let range = format!("{}..HEAD", base_sha.trim());
    let output = Command::new("git")
        .args(["-C", &repo, "diff", "--name-only", &range])
        .output()
        .map_err(|e| format!("failed to run git diff: {}", e))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    Ok(text
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn git_ensure_repo_creates_git() {
        let dir = tempdir().unwrap();
        let p = dir.path().to_string_lossy().to_string();
        fs::write(dir.path().join("README.md"), "x").unwrap();
        git_ensure_repo(p.clone()).unwrap();
        assert!(git_dir(&p).exists());
        let log = crate::git_history::git_log(p.clone()).unwrap();
        assert!(!log.is_empty());
    }

    #[test]
    fn git_add_and_commit_no_op_when_clean() {
        let dir = tempdir().unwrap();
        let p = dir.path().to_string_lossy().to_string();
        fs::write(dir.path().join("README.md"), "x").unwrap();
        git_ensure_repo(p.clone()).unwrap();
        assert!(!git_add_and_commit(p.clone(), "noop".into()).unwrap());
    }
}
