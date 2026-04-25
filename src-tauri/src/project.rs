use std::fs;
use std::path::PathBuf;

use serde::Serialize;

use crate::git_ops;

#[derive(Serialize)]
pub struct BootstrapResult {
    pub path: String,
    pub created: bool,
}

/// Slugify an org name for use as a folder name. Lowercase, ASCII alnum +
/// dash, runs collapsed, trimmed.
fn slugify(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut last_dash = false;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash && !out.is_empty() {
            out.push('-');
            last_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

/// Make sure `~/Documents/OpenIT/<org_id>/` exists. Returns the absolute path
/// and whether it was newly created. Uses org_id for the folder name (stable, unique).
#[tauri::command]
pub fn project_bootstrap(org_name: String, org_id: String) -> Result<BootstrapResult, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    if org_id.is_empty() {
        return Err("org_id cannot be empty".into());
    }
    let path: PathBuf = [&home, "Documents", "OpenIT", &org_id].iter().collect();

    let already_existed = path.exists();
    if !already_existed {
        fs::create_dir_all(&path).map_err(|e| format!("create_dir_all failed: {}", e))?;
        let welcome = format!(
            "# Welcome to {}\n\n\
             Your OpenIT workspace for org `{}`.\n\n\
             ## What's in this folder?\n\n\
             **agents/** — AI agents that handle tasks. Create new agents via Claude Code with `/create-agent`.\n\n\
             **workflows/** — Automated processes triggered by events. Create workflows with `/run-workflow`.\n\n\
             **databases/** — Structured data tables from Pinkfish (openit-tickets, openit-people, etc.).\n\n\
             **filestore/** — Document storage. Ask Claude to upload or retrieve files here.\n\n\
             **knowledge-base/** — Solution articles. Syncs with Pinkfish; ask Claude to search or write KB articles.\n\n\
             ## Next steps\n\n\
             1. Open a project folder in Claude Code\n\
             2. Ask Claude to create your first agent: \"Create a helpdesk agent\"\n\
             3. Use `/create-workflow` to automate repetitive tasks\n\n\
             Everything you create here is a regular file on your disk. OpenIT just provides the interface.\n",
            org_name, org_id
        );
        fs::write(path.join("_welcome.md"), welcome)
            .map_err(|e| format!("could not write README: {}", e))?;

        // Create standard subdirectories so they appear in the file explorer even if empty
        for dir in &["agents", "workflows", "databases", "filestore", "knowledge-base"] {
            fs::create_dir_all(path.join(dir))
                .map_err(|e| format!("create_dir failed for {}: {}", dir, e))?;
        }
    }

    // Local git for sync history (idempotent if `.git` already exists).
    git_ops::git_ensure_repo(path.to_string_lossy().into_owned())
        .map_err(|e| format!("git init failed: {}", e))?;

    Ok(BootstrapResult {
        path: path.to_string_lossy().into_owned(),
        created: !already_existed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_collapses_punctuation() {
        assert_eq!(slugify("AcmeCo - Dev"), "acmeco-dev");
        assert_eq!(
            slugify("Ben Rigby's Organization"),
            "ben-rigby-s-organization"
        );
        assert_eq!(slugify("My Organization"), "my-organization");
        assert_eq!(slugify("   "), "");
        assert_eq!(slugify("CK's Personal Org"), "ck-s-personal-org");
    }
}
