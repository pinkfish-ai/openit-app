use std::fs;
use std::path::PathBuf;

use serde::Serialize;

use crate::git_ops;

#[derive(Serialize)]
pub struct BootstrapResult {
    pub path: String,
    pub created: bool,
}

/// Make sure `~/OpenIT/<org_id>/` exists. Returns the absolute path
/// and whether it was newly created. Uses org_id for the folder name (stable, unique).
/// Lives at the home root (not under ~/Documents) so macOS TCC doesn't block
/// fs/git ops in dev or in unsigned builds.
#[tauri::command]
pub fn project_bootstrap(org_name: String, org_id: String) -> Result<BootstrapResult, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    if org_id.is_empty() {
        return Err("org_id cannot be empty".into());
    }
    let path: PathBuf = [&home, "OpenIT", &org_id].iter().collect();

    let already_existed = path.exists();
    if !already_existed {
        fs::create_dir_all(&path).map_err(|e| format!("create_dir_all failed: {}", e))?;
        let welcome = format!(
            "# Welcome `{}`\n\n\
             ## The idea\n\n\
             Describe IT work in plain English and Claude builds it for you — \
             triage tickets, onboard new hires, audit access, write runbooks. \
             Everything lands as a regular file in this folder: agents, \
             workflows, ticket data, knowledge articles. You own it, it \
             versions cleanly, and it stays useful even outside this app.\n\n\
             ## Getting started\n\n\
             The bubbles below the chat (right pane) are good starting points. \
             Click one, or just type a request.\n\n\
             ## A few things to try\n\n\
             - **Triage today's tickets.** Claude reads `databases/openit-tickets/`, \
               groups by urgency, and suggests next actions for each.\n\n\
             - **Onboard a new hire** — \"Onboard Alice in Engineering.\" Claude \
               runs the `/onboard` skill: creates the people record, drafts the \
               welcome email, queues access requests.\n\n\
             - **Audit access to a system** — \"Who has admin on GitHub?\" \
               Cross-references your connected systems against `databases/openit-people/`.\n\n\
             - **Build a new workflow** — \"Draft a workflow that escalates SLA \
               breaches to the team lead.\" Claude scaffolds the `workflows/<name>.json` \
               and any agents it needs.\n\n\
             - **Update or create a knowledge-base article** — \"Write a runbook \
               for resetting a Slack workspace owner.\" Lands in `knowledge-base/`.\n\n\
             ## How it works\n\n\
             Everything in this folder is a regular file on your disk. Edit \
             agents and workflows in your editor of choice; the **Sync** tab \
             pushes changes back to Pinkfish (`{}`). You can also run Claude \
             here without OpenIT — same project, same files.\n",
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
