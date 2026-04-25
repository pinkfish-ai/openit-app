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

/// Make sure `~/Documents/OpenIT/<slug>/` exists. Returns the absolute path
/// and whether it was newly created. Populates with a minimal README so
/// the user can see something on first open.
#[tauri::command]
pub fn project_bootstrap(org_name: String, org_id: String) -> Result<BootstrapResult, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let slug = slugify(&org_name);
    if slug.is_empty() {
        return Err("could not derive a folder name from the org name".into());
    }
    let path: PathBuf = [&home, "Documents", "OpenIT", &slug].iter().collect();

    let already_existed = path.exists();
    if !already_existed {
        fs::create_dir_all(&path).map_err(|e| format!("create_dir_all failed: {}", e))?;
        let readme = format!(
            "# {}\n\nOpenIT project folder for org `{}`.\n\nThis folder is a regular directory \
             on your disk. Anything you (or Claude Code) write here lives here. \
             OpenIT just opens this folder as the working directory for the embedded \
             Claude session.\n",
            org_name, org_id
        );
        fs::write(path.join("README.md"), readme)
            .map_err(|e| format!("could not write README: {}", e))?;
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
