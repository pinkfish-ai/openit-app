use std::path::Path;
use std::process::Command;

use serde::Serialize;

#[derive(Serialize, Debug)]
pub struct GitCommit {
    pub sha: String,
    pub short_sha: String,
    pub author: String,
    pub date: String,
    pub subject: String,
}

const LOG_LIMIT: usize = 100;

#[tauri::command]
pub fn git_log(repo: String) -> Result<Vec<GitCommit>, String> {
    if !Path::new(&repo).join(".git").exists() {
        return Err(format!("{} is not a git repository", repo));
    }

    let output = Command::new("git")
        .args([
            "-C",
            &repo,
            "log",
            "--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1e",
            "--date=iso-strict",
            "-n",
            &LOG_LIMIT.to_string(),
        ])
        .output()
        .map_err(|e| format!("failed to run git: {}", e))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let commits = stdout
        .split('\u{1e}')
        .filter(|s| !s.trim().is_empty())
        .filter_map(|record| {
            let parts: Vec<&str> = record.trim().splitn(5, '\u{1f}').collect();
            if parts.len() < 5 {
                return None;
            }
            Some(GitCommit {
                sha: parts[0].to_string(),
                short_sha: parts[1].to_string(),
                author: parts[2].to_string(),
                date: parts[3].to_string(),
                subject: parts[4].to_string(),
            })
        })
        .collect();
    Ok(commits)
}

#[tauri::command]
pub fn git_diff(repo: String, sha: String) -> Result<String, String> {
    let output = Command::new("git")
        .args(["-C", &repo, "show", "--no-color", &sha])
        .output()
        .map_err(|e| format!("failed to run git: {}", e))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;
    use tempfile::tempdir;

    fn init_repo_with_commit(dir: &Path) {
        let run = |args: &[&str]| {
            let status = Command::new("git")
                .args(args)
                .current_dir(dir)
                .status()
                .unwrap();
            assert!(status.success(), "git {:?} failed", args);
        };
        run(&["init", "-b", "main"]);
        run(&["config", "user.email", "test@example.com"]);
        run(&["config", "user.name", "Test"]);
        fs::write(dir.join("a.txt"), "hello").unwrap();
        run(&["add", "a.txt"]);
        run(&["commit", "-m", "first commit"]);
    }

    #[test]
    fn git_log_returns_commit_records() {
        let dir = tempdir().unwrap();
        init_repo_with_commit(dir.path());
        let log = git_log(dir.path().to_string_lossy().to_string()).unwrap();
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].subject, "first commit");
        assert!(!log[0].sha.is_empty());
        assert_eq!(log[0].short_sha.len(), 7);
    }

    #[test]
    fn git_log_rejects_non_repo() {
        let dir = tempdir().unwrap();
        let err = git_log(dir.path().to_string_lossy().to_string()).unwrap_err();
        assert!(err.contains("not a git repository"));
    }
}
