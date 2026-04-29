use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::git_ops;

/// Find a free destination filename in `dir` for a migration. If
/// `<name>` doesn't exist returns it; otherwise tries
/// `<name>.legacy`, `<name>.legacy.2`, … until a free slot is found.
/// Falls back to a timestamp-suffixed name after 99 attempts (a
/// pathological case where the user's project has a hundred
/// duplicates) — better than overwriting silently. The earlier
/// single-`.legacy` policy could lose data on a re-run when the
/// user had already accepted a previous `.legacy` rename.
fn unique_legacy_dest(dir: &Path, name: &OsStr) -> PathBuf {
    let direct = dir.join(name);
    if !direct.exists() {
        return direct;
    }
    let base = name.to_string_lossy().into_owned();
    let first = format!("{}.legacy", base);
    let candidate = dir.join(&first);
    if !candidate.exists() {
        return candidate;
    }
    for n in 2..100u32 {
        let next = format!("{}.legacy.{}", base, n);
        let candidate = dir.join(&next);
        if !candidate.exists() {
            return candidate;
        }
    }
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    dir.join(format!("{}.legacy.{}", base, ms))
}

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
        // _welcome.md used to live here as the first-launch surface;
        // the React Getting Started page (Viewer.tsx kind:
        // "getting-started") replaces it, so no markdown file is
        // written. Existing projects with the legacy file on disk
        // still work — the viewer just doesn't auto-open it anymore.
        let _ = (org_name, org_id);

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
            // On-demand markdown reports — populated by the
            // "Generate overview" button in the explorer (which shells
            // out to .claude/scripts/report-overview.mjs) and by the
            // /report skill. Always create so the sidebar entry isn't
            // empty on a fresh project.
            "reports",
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
    // Same idempotent guard for `reports/` so projects bootstrapped
    // before the reports feature shipped get the dir on next open.
    let _ = fs::create_dir_all(path.join("reports"));

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
                let to = unique_legacy_dest(&library_dir, &name);
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
    // semantics as filestore (`.legacy` / `.legacy.2` / `.legacy.3`
    // suffix until we find a free slot).
    let legacy_kb = path.join("knowledge-base");
    if legacy_kb.is_dir() {
        let default_kb = path.join("knowledge-bases").join("default");
        if let Ok(entries) = fs::read_dir(&legacy_kb) {
            for entry in entries.flatten() {
                let from = entry.path();
                let name = entry.file_name();
                let to = unique_legacy_dest(&default_kb, &name);
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

// ---------------------------------------------------------------------------
// Cloud binding marker (Phase 1 of V2 sync — PIN-5775).
//
// `~/OpenIT/<orgId>/` as a folder convention is going away. Instead, the
// user's bound folder (default `~/OpenIT/local/`) holds a metadata file at
// `.openit/cloud.json` that records which Pinkfish org it's associated with.
// This lets the app know the binding without renaming the folder.
//
// `cloud.json` lives under `.openit/` which is already gitignored, so the
// marker doesn't end up in git history.
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct CloudBinding {
    #[serde(rename = "orgId")]
    pub org_id: String,
    #[serde(rename = "orgName")]
    pub org_name: String,
    /// Unix epoch milliseconds when the binding was first written.
    #[serde(rename = "connectedAt")]
    pub connected_at: u64,
    /// Unix epoch milliseconds of the most recent successful sync. `None`
    /// before the first poll completes.
    #[serde(rename = "lastSyncAt")]
    pub last_sync_at: Option<u64>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn cloud_json_path(repo: &str) -> PathBuf {
    Path::new(repo).join(".openit").join("cloud.json")
}

fn read_cloud_binding_from_disk(path: &Path) -> Result<Option<CloudBinding>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let s = fs::read_to_string(path).map_err(|e| format!("read cloud.json: {}", e))?;
    let binding: CloudBinding =
        serde_json::from_str(&s).map_err(|e| format!("parse cloud.json: {}", e))?;
    Ok(Some(binding))
}

fn write_cloud_binding_to_disk(path: &Path, binding: &CloudBinding) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create_dir_all: {}", e))?;
    }
    let json = serde_json::to_string_pretty(binding)
        .map_err(|e| format!("serialize cloud.json: {}", e))?;
    fs::write(path, json).map_err(|e| format!("write cloud.json: {}", e))
}

/// Bind a folder to a Pinkfish org. Writes `.openit/cloud.json`. Idempotent
/// for the same `org_id` — reuses the existing `connected_at` and returns
/// the (possibly-pre-existing) binding. Errors if the folder is already
/// bound to a *different* org so callers can surface the conflict instead
/// of silently overwriting.
#[tauri::command]
pub fn project_bind_to_cloud(
    repo: String,
    org_id: String,
    org_name: String,
) -> Result<CloudBinding, String> {
    if repo.is_empty() {
        return Err("repo cannot be empty".into());
    }
    if org_id.is_empty() {
        return Err("org_id cannot be empty".into());
    }
    let path = cloud_json_path(&repo);
    if let Some(existing) = read_cloud_binding_from_disk(&path)? {
        if existing.org_id == org_id {
            // Same org: idempotent — keep connected_at, refresh org_name in
            // case the user's display name changed upstream.
            if existing.org_name == org_name {
                return Ok(existing);
            }
            let updated = CloudBinding {
                org_id: existing.org_id,
                org_name,
                connected_at: existing.connected_at,
                last_sync_at: existing.last_sync_at,
            };
            write_cloud_binding_to_disk(&path, &updated)?;
            return Ok(updated);
        }
        return Err(format!(
            "folder already bound to org '{}' (id: {}); cannot rebind to org '{}' (id: {})",
            existing.org_name, existing.org_id, org_name, org_id
        ));
    }
    let binding = CloudBinding {
        org_id,
        org_name,
        connected_at: now_ms(),
        last_sync_at: None,
    };
    write_cloud_binding_to_disk(&path, &binding)?;
    Ok(binding)
}

/// Read the current binding. `Ok(None)` for unbound folders.
#[tauri::command]
pub fn project_get_cloud_binding(repo: String) -> Result<Option<CloudBinding>, String> {
    if repo.is_empty() {
        return Ok(None);
    }
    let path = cloud_json_path(&repo);
    read_cloud_binding_from_disk(&path)
}

/// Update `last_sync_at` to the current time. No-op (returns Ok) if the
/// folder is unbound — callers shouldn't have to special-case that.
#[tauri::command]
pub fn project_update_last_sync_at(repo: String) -> Result<(), String> {
    if repo.is_empty() {
        return Ok(());
    }
    let path = cloud_json_path(&repo);
    let Some(mut binding) = read_cloud_binding_from_disk(&path)? else {
        return Ok(());
    };
    binding.last_sync_at = Some(now_ms());
    write_cloud_binding_to_disk(&path, &binding)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn repo() -> (TempDir, String) {
        let dir = TempDir::new().expect("tempdir");
        let path = dir.path().to_string_lossy().into_owned();
        (dir, path)
    }

    #[test]
    fn bind_writes_cloud_json_with_expected_shape() {
        let (_dir, repo) = repo();
        let binding =
            project_bind_to_cloud(repo.clone(), "org-123".into(), "Acme Inc".into()).unwrap();
        assert_eq!(binding.org_id, "org-123");
        assert_eq!(binding.org_name, "Acme Inc");
        assert!(binding.connected_at > 0);
        assert_eq!(binding.last_sync_at, None);

        let path = cloud_json_path(&repo);
        assert!(path.exists(), "cloud.json should exist after bind");
        let raw = fs::read_to_string(&path).unwrap();
        // Camel-case JSON keys for frontend consumption.
        assert!(raw.contains("\"orgId\""));
        assert!(raw.contains("\"orgName\""));
        assert!(raw.contains("\"connectedAt\""));
        assert!(raw.contains("\"lastSyncAt\""));
    }

    #[test]
    fn bind_is_idempotent_for_same_org() {
        let (_dir, repo) = repo();
        let first =
            project_bind_to_cloud(repo.clone(), "org-1".into(), "First Org".into()).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let second =
            project_bind_to_cloud(repo.clone(), "org-1".into(), "First Org".into()).unwrap();
        assert_eq!(
            first.connected_at, second.connected_at,
            "connected_at should be preserved on rebind"
        );
    }

    #[test]
    fn bind_updates_org_name_for_same_org_id() {
        let (_dir, repo) = repo();
        let _ = project_bind_to_cloud(repo.clone(), "org-1".into(), "Old Name".into()).unwrap();
        let updated =
            project_bind_to_cloud(repo.clone(), "org-1".into(), "New Name".into()).unwrap();
        assert_eq!(updated.org_name, "New Name");
    }

    #[test]
    fn bind_rejects_different_org_id() {
        let (_dir, repo) = repo();
        let _ = project_bind_to_cloud(repo.clone(), "org-1".into(), "First".into()).unwrap();
        let err = project_bind_to_cloud(repo.clone(), "org-2".into(), "Second".into()).unwrap_err();
        assert!(err.contains("already bound"), "got: {}", err);
        assert!(err.contains("org-1"), "should mention existing org id");
        assert!(err.contains("org-2"), "should mention attempted org id");
    }

    #[test]
    fn bind_rejects_empty_inputs() {
        let (_dir, repo) = repo();
        assert!(project_bind_to_cloud("".into(), "org".into(), "Org".into()).is_err());
        assert!(project_bind_to_cloud(repo, "".into(), "Org".into()).is_err());
    }

    #[test]
    fn get_binding_returns_none_for_unbound() {
        let (_dir, repo) = repo();
        let result = project_get_cloud_binding(repo).unwrap();
        assert_eq!(result, None);
    }

    #[test]
    fn get_binding_round_trips() {
        let (_dir, repo) = repo();
        let written =
            project_bind_to_cloud(repo.clone(), "org-9".into(), "Round Trip".into()).unwrap();
        let read = project_get_cloud_binding(repo).unwrap().expect("binding");
        assert_eq!(written, read);
    }

    #[test]
    fn update_last_sync_at_sets_field_and_preserves_others() {
        let (_dir, repo) = repo();
        let original = project_bind_to_cloud(repo.clone(), "org-1".into(), "Org".into()).unwrap();
        // Sleep so now_ms strictly advances past `original.connected_at`.
        std::thread::sleep(std::time::Duration::from_millis(5));
        project_update_last_sync_at(repo.clone()).unwrap();
        let after = project_get_cloud_binding(repo).unwrap().expect("binding");
        assert_eq!(after.org_id, original.org_id);
        assert_eq!(after.org_name, original.org_name);
        assert_eq!(after.connected_at, original.connected_at);
        assert!(after.last_sync_at.is_some());
        assert!(after.last_sync_at.unwrap() >= original.connected_at);
    }

    #[test]
    fn update_last_sync_at_is_noop_for_unbound() {
        let (_dir, repo) = repo();
        // Should not error even though there's no binding to update.
        project_update_last_sync_at(repo.clone()).unwrap();
        assert_eq!(project_get_cloud_binding(repo).unwrap(), None);
    }
}
