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
             [**Open the intake page**]({{INTAKE_URL}})\n\n\
             ## Making the intake page public\n\n\
             Right now your intake URL only works on this machine. \
             Connecting OpenIT to Pinkfish (the cloud companion) gets you \
             a stable public URL anyone can use, plus channel ingest \
             (Slack/Teams/email → tickets), always-on agents, and \
             multi-device sync.\n\n\
             [**Connect to Cloud**](openit://skill/connect-to-cloud)\n";
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
            // Filestore split into two purpose-specific collections.
            // `attachments` is operational (per-ticket file uploads from
            // the chat intake); `library` is curated (admin's go-to
            // runbooks/scripts). Both share the existing filestore sync
            // engine when cloud is connected.
            "filestores",
            "filestores/attachments",
            "filestores/library",
            // Knowledge bases got the same plural-with-default split
            // as filestores (2026-04-27): one folder per KB, with
            // `default` shipping out of the box. Skills target
            // `knowledge-bases/default/` unless explicitly told
            // otherwise; admins can `mkdir knowledge-bases/<custom>/`
            // to create additional collections.
            "knowledge-bases",
            "knowledge-bases/default",
        ] {
            fs::create_dir_all(path.join(dir))
                .map_err(|e| format!("create_dir failed for {}: {}", dir, e))?;
        }
    }

    // Idempotent layout maintenance: ensure the filestores/{attachments,library}
    // and knowledge-bases/default dirs exist for every project on every
    // open, even ones bootstrapped before the splits. Cheap to create,
    // lets the explorer render the canonical structure without waiting
    // for first-use.
    let _ = fs::create_dir_all(path.join("filestores").join("attachments"));
    let _ = fs::create_dir_all(path.join("filestores").join("library"));
    let _ = fs::create_dir_all(path.join("knowledge-bases").join("default"));

    // One-time migration: legacy `filestore/<file>` content moves into
    // the new `filestores/library/<file>` location. Idempotent — runs
    // only when the legacy dir exists; once empty it is removed so
    // the bootstrap loop can't recreate it on a future run. Files
    // shadowed by a same-named entry already in `library/` are kept
    // under their original names with a `.legacy` suffix to avoid
    // silent overwrites.
    let legacy_filestore = path.join("filestore");
    if legacy_filestore.is_dir() {
        let library_dir = path.join("filestores").join("library");
        if let Ok(entries) = fs::read_dir(&legacy_filestore) {
            for entry in entries.flatten() {
                let from = entry.path();
                let name = entry.file_name();
                let mut to = library_dir.join(&name);
                if to.exists() {
                    let mut alt_name = name.to_string_lossy().into_owned();
                    alt_name.push_str(".legacy");
                    to = library_dir.join(alt_name);
                }
                let _ = fs::rename(&from, &to);
            }
        }
        // Drop the legacy dir if it's empty after migration. Leave it
        // alone if the rename loop failed to drain it — better to
        // surface stranded files than silently delete.
        let _ = fs::remove_dir(&legacy_filestore);
    }

    // Same one-time migration for the knowledge-base split. Articles
    // sitting at the legacy flat `knowledge-base/<file>.md` location
    // move into `knowledge-bases/default/<file>.md`. Same collision
    // semantics as filestore (`<name>.legacy` suffix on duplicates).
    let legacy_kb = path.join("knowledge-base");
    if legacy_kb.is_dir() {
        let default_kb = path.join("knowledge-bases").join("default");
        if let Ok(entries) = fs::read_dir(&legacy_kb) {
            for entry in entries.flatten() {
                let from = entry.path();
                let name = entry.file_name();
                let mut to = default_kb.join(&name);
                if to.exists() {
                    let mut alt_name = name.to_string_lossy().into_owned();
                    alt_name.push_str(".legacy");
                    to = default_kb.join(alt_name);
                }
                let _ = fs::rename(&from, &to);
            }
        }
        let _ = fs::remove_dir(&legacy_kb);
    }

    // Local git for sync history (idempotent if `.git` already exists).
    git_ops::git_ensure_repo(path.to_string_lossy().into_owned())
        .map_err(|e| format!("git init failed: {}", e))?;

    Ok(BootstrapResult {
        path: path.to_string_lossy().into_owned(),
        created: !already_existed,
    })
}
