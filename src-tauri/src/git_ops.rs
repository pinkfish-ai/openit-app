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

    // Ensure at least one tracked file for first commit. _welcome.md is created by
    // project_bootstrap, so skip creating README.md if _welcome.md exists.
    let welcome = Path::new(&repo).join("_welcome.md");
    let readme = Path::new(&repo).join("README.md");
    if !welcome.exists() && !readme.exists() {
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

/// Stage *specific* paths and commit. Returns `true` if a new commit was
/// created. Used by the sync layer so that auto-commits ("sync: pull @ …",
/// "sync: deployed @ …") only capture files the sync itself touched, never
/// the user's unrelated WIP.
#[tauri::command]
pub fn git_commit_paths(repo: String, paths: Vec<String>, message: String) -> Result<bool, String> {
    if !git_dir(&repo).exists() {
        git_ensure_repo(repo.clone())?;
    }
    if paths.is_empty() {
        return Ok(false);
    }

    let mut add_args = vec!["add", "--"];
    let refs: Vec<&str> = paths.iter().map(|s| s.as_str()).collect();
    add_args.extend(refs);
    let add = run_git(&repo, &add_args)?;
    if !add.status.success() {
        return Err(String::from_utf8_lossy(&add.stderr).into_owned());
    }

    // Commit only what we just staged. If nothing staged → no-op.
    let cached = run_git(&repo, &["diff", "--cached", "--quiet"])?;
    if cached.status.success() {
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

/// Stage all changes and commit. Returns `true` if a new commit was created.
/// Kept for tests / one-off cleanups; **not** for the sync auto-commits — use
/// `git_commit_paths` instead.
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

/// Parse `git status --porcelain -z -uall` records into (XY, path) tuples.
///
/// `-z` is required so that filenames containing spaces, quotes, or newlines
/// (which Pinkfish KB files genuinely can have) round-trip correctly. Records
/// are NUL-terminated; rename records `R<old>\0<new>` consume two records.
fn parse_porcelain_z(stdout: &[u8]) -> Vec<(char, char, String)> {
    let mut out = Vec::new();
    let mut iter = stdout.split(|&b| b == 0).peekable();
    while let Some(rec) = iter.next() {
        if rec.is_empty() {
            continue;
        }
        if rec.len() < 3 {
            continue;
        }
        let x = rec[0] as char;
        let y = rec[1] as char;
        // git puts a single space at index 2 separating XY from path.
        let path_bytes = &rec[3..];
        let path = String::from_utf8_lossy(path_bytes).into_owned();
        // Rename / copy records have form `R<old-or-new>\0<other>`. With `-z`
        // the destination is in the *current* record and the source in the
        // following one. Either way we want the destination — that's what's
        // staged or in the worktree now.
        if x == 'R' || x == 'C' || y == 'R' || y == 'C' {
            // Consume (and discard) the source record.
            iter.next();
        }
        out.push((x, y, path.trim_end_matches('/').to_string()));
    }
    out
}

/// `git status --porcelain -z -uall` mapped to simple statuses for the file
/// tree UI. Files that have both staged and unstaged changes appear twice
/// (once each).
#[tauri::command]
pub fn git_status_short(repo: String) -> Result<Vec<GitFileStatus>, String> {
    if !git_dir(&repo).exists() {
        return Ok(Vec::new());
    }
    let output = run_git(&repo, &["status", "--porcelain", "-z", "-uall"])?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }
    let mut out = Vec::new();
    for (x, y, path) in parse_porcelain_z(&output.stdout) {
        if path.is_empty() || x == '!' {
            continue;
        }
        if x == '?' && y == '?' {
            out.push(GitFileStatus { path, status: "?".to_string(), staged: false });
            continue;
        }
        if x == 'U' || y == 'U' || (x == 'A' && y == 'A') || (x == 'D' && y == 'D') {
            out.push(GitFileStatus { path, status: "UU".to_string(), staged: false });
            continue;
        }

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

/// Resolve `repo + rel` and assert it stays inside `repo`. Guards against
/// `..` segments / absolute paths sneaking in via server-controlled filenames.
fn safe_join(repo: &str, rel: &str) -> Result<PathBuf, String> {
    let repo_canon = fs::canonicalize(repo).map_err(|e| e.to_string())?;
    let candidate = Path::new(repo).join(rel);
    // canonicalize fails on non-existent paths; that's fine here because
    // git_discard only deletes things git just told us exist. For safety we
    // canonicalize the parent and re-append the file name.
    let parent = candidate
        .parent()
        .ok_or_else(|| format!("invalid path: {}", rel))?;
    let parent_canon = fs::canonicalize(parent).map_err(|e| e.to_string())?;
    if !parent_canon.starts_with(&repo_canon) {
        return Err(format!("refusing to touch path outside repo: {}", rel));
    }
    let name = candidate
        .file_name()
        .ok_or_else(|| format!("invalid path: {}", rel))?;
    Ok(parent_canon.join(name))
}

/// Discard working-tree changes for specific paths.
/// For tracked files: `git checkout HEAD -- <path>`.
/// For untracked files: removes them from disk.
#[tauri::command]
pub fn git_discard(repo: String, paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let output = run_git(&repo, &["status", "--porcelain", "-z", "-uall"])?;
    let untracked: std::collections::HashSet<String> = parse_porcelain_z(&output.stdout)
        .into_iter()
        .filter(|(x, y, _)| *x == '?' && *y == '?')
        .map(|(_, _, p)| p)
        .collect();

    let mut tracked_paths = Vec::new();
    for p in &paths {
        if untracked.contains(p.as_str()) {
            let full = safe_join(&repo, p)?;
            if full.is_file() {
                fs::remove_file(&full).map_err(|e| format!("remove {}: {}", p, e))?;
            } else if full.is_dir() {
                fs::remove_dir_all(&full).map_err(|e| format!("remove {}: {}", p, e))?;
            }
        } else {
            tracked_paths.push(p.as_str());
        }
    }

    if !tracked_paths.is_empty() {
        let mut args = vec!["checkout", "HEAD", "--"];
        args.extend(tracked_paths);
        let out = run_git(&repo, &args)?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).into_owned());
        }
    }
    Ok(())
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

    #[test]
    fn parse_porcelain_z_handles_spaces_and_renames() {
        // Untracked file with a space in the name + one staged modification.
        let raw = b"?? Q1 plan.md\0M  src/foo.rs\0";
        let parsed = parse_porcelain_z(raw);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0], ('?', '?', "Q1 plan.md".to_string()));
        assert_eq!(parsed[1], ('M', ' ', "src/foo.rs".to_string()));

        // Rename: `R  new\0old\0` — destination first, source second; we keep dest.
        let rename = b"R  new path.txt\0old path.txt\0M  other.rs\0";
        let parsed = parse_porcelain_z(rename);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0], ('R', ' ', "new path.txt".to_string()));
        assert_eq!(parsed[1], ('M', ' ', "other.rs".to_string()));
    }

    #[test]
    fn git_status_short_reports_files_with_spaces() {
        let dir = tempdir().unwrap();
        let p = dir.path().to_string_lossy().to_string();
        fs::write(dir.path().join("README.md"), "x").unwrap();
        git_ensure_repo(p.clone()).unwrap();
        // Create an untracked file whose name has spaces and a quote — this
        // is the case that broke pre-`-z` parsing.
        fs::write(dir.path().join("Q1 plan \"draft\".md"), "x").unwrap();
        let rows = git_status_short(p.clone()).unwrap();
        assert!(
            rows.iter().any(|r| r.path == "Q1 plan \"draft\".md" && r.status == "?"),
            "expected to see the quoted-name file as untracked: {:?}",
            rows
        );
    }
}
