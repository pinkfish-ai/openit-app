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
        // Welcome message: lead with what OpenIT *does*, not what's in
        // the folder. Both local-only and cloud-connected modes land
        // here; the cloud upgrade is an option exposed via the header
        // pill, not a state worth highlighting on first launch.
        let _ = (org_name, org_id);
        let welcome = "# Welcome to OpenIT\n\n\
             ## The idea\n\n\
             Describe IT work in plain English and Claude builds it for you — triage tickets, onboard new hires, audit access, write runbooks. Everything lands as a regular file in this folder: agents, workflows, ticket data, knowledge articles. You own it, it versions cleanly, and it stays useful even outside this app.\n\n\
             ## Try it in 30 seconds\n\n\
             1. **Click the Intake button** in the top-right of the header. It opens a ticket-submission form in your browser.\n\
             2. Fill in a name + a question (anything — *\"VPN broken\"*, *\"can't access GitHub\"*) and submit.\n\
             3. Watch the green banner appear above the file explorer — that's the new ticket.\n\
             4. Click **Triage in Claude** on the banner. Claude reads the row, drafts a reply, and updates the status.\n\n\
             That's the loop. Share the Intake URL with anyone on your machine and they can file tickets the same way.\n\n\
             ## Other starting points\n\n\
             The bubbles below the chat (right pane) are quick entry points. Click one, or just type a request.\n\n\
             ## A few things to try\n\n\
             - **Triage today's tickets.** Claude reads `databases/tickets/`, groups by urgency, and suggests next actions for each.\n\n\
             - **Onboard a new hire** — *\"Onboard Alice in Engineering.\"* Claude creates the people record, drafts a welcome email, queues access requests.\n\n\
             - **Audit access to a system** — *\"Who has admin on GitHub?\"* Cross-references connected systems against `databases/people/`.\n\n\
             - **Build a new workflow** — *\"Draft a workflow that escalates SLA breaches to the team lead.\"* Claude scaffolds `workflows/<name>.json` and any agents it needs.\n\n\
             - **Update or write a knowledge-base article** — *\"Write a runbook for resetting a Slack workspace owner.\"* Lands in `knowledge-base/`.\n\n\
             ## How it works\n\n\
             Everything in this folder is a regular file on your disk. Edit agents and workflows in your editor of choice; the **Deploy** tab on the left commits changes locally. **Connect to Cloud** in the header turns on multi-device sync, channel ingest (Slack/Teams/email → tickets), semantic KB search, and runs your agents server-side so they answer even when this app isn't open.\n";
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

