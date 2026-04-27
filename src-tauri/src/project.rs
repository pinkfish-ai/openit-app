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
        // Welcome message: short, one CTA. The viewer substitutes
        // `{{INTAKE_URL}}` with the live intake server URL at render
        // time (the URL changes per app launch — different OS-assigned
        // port — so we can't bake a static URL in here at bootstrap).
        let _ = (org_name, org_id);
        let welcome = "# Getting started\n\n\
             ## The big idea\n\n\
             OpenIT is your AI-driven IT helpdesk that runs on your machine. \
             Anyone you share the intake link with can ask a question; an AI agent \
             triages it against your knowledge base and either answers them \
             directly or escalates to you.\n\n\
             ## Try it in 30 seconds\n\n\
             Open the intake page and ask a question to test it — \
             *\"I can't log in\"*, *\"how do I reset my VPN\"*, anything. The \
             agent will answer or flag it for you.\n\n\
             [**Open the intake page**]({{INTAKE_URL}})\n";
        let welcome = welcome.to_string();
        fs::write(path.join("_welcome.md"), welcome)
            .map_err(|e| format!("could not write README: {}", e))?;

        // Create standard subdirectories so they appear in the file
        // explorer even if empty. The three core datastore dirs
        // (tickets, people, conversations) are created upfront so the
        // explorer + Claude both see them on day-one — without this,
        // `databases/conversations/` only appeared after the first
        // turn was logged, which felt incomplete to users browsing
        // the layout.
        for dir in &[
            "agents",
            "workflows",
            "databases",
            "databases/tickets",
            "databases/people",
            "databases/conversations",
            "filestore",
            "knowledge-base",
        ] {
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
