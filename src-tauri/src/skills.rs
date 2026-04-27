use reqwest::Client;
use std::path::{Component, PathBuf};
use std::time::Duration;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager, Runtime};

/// Fetch the manifest from the openit-plugin directory at the environment root.
/// Uses the app-api URL to determine the environment root.
#[tauri::command]
pub async fn skills_fetch_manifest(app_api_url: String) -> Result<String, String> {
    // Extract the environment from app_api_url (e.g., "https://app-api.dev20.pinkfish.dev/..." -> "https://dev20.pinkfish.dev")
    let env_root = extract_env_root(&app_api_url)?;
    let manifest_url = format!("{}/openit-plugin/manifest.json", env_root.trim_end_matches('/'));

    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(&manifest_url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch manifest: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Manifest fetch failed with status: {}", resp.status()));
    }

    resp.text()
        .await
        .map_err(|e| format!("Failed to read manifest: {}", e))
}

/// Fetch a single skill file from the openit-plugin/skills directory.
#[tauri::command]
pub async fn skills_fetch_file(app_api_url: String, skill_path: String) -> Result<String, String> {
    let env_root = extract_env_root(&app_api_url)?;
    let file_url = format!(
        "{}/openit-plugin/{}",
        env_root.trim_end_matches('/'),
        skill_path.trim_start_matches('/')
    );

    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(&file_url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch skill: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Skill fetch failed with status: {}", resp.status()));
    }

    resp.text()
        .await
        .map_err(|e| format!("Failed to read skill: {}", e))
}

/// Read the bundled manifest shipped inside the app resources.
/// Used as the local-first source of truth (no network required).
#[tauri::command]
pub fn skills_fetch_bundled_manifest<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    let path = resolve_bundled_path(&app, "manifest.json")?;
    std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read bundled manifest at {}: {}", path.display(), e))
}

/// Read a single file from the bundled openit-plugin resources.
#[tauri::command]
pub fn skills_fetch_bundled_file<R: Runtime>(
    app: AppHandle<R>,
    skill_path: String,
) -> Result<String, String> {
    let path = resolve_bundled_path(&app, &skill_path)?;
    std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read bundled file at {}: {}", path.display(), e))
}

/// Resolve a path under the bundled `openit-plugin/` resource directory.
/// Rejects absolute paths and `..` traversal so a malformed manifest entry
/// can't read files outside the bundle.
fn resolve_bundled_path<R: Runtime>(
    app: &AppHandle<R>,
    rel: &str,
) -> Result<PathBuf, String> {
    let resource = sanitize_bundled_relpath(rel)?;
    app.path()
        .resolve(&resource, BaseDirectory::Resource)
        .map_err(|e| format!("could not resolve bundled resource {}: {}", resource, e))
}

/// Pure half of `resolve_bundled_path` — does the validation but not the
/// AppHandle-bound resource lookup. Returns the namespaced resource path
/// (`openit-plugin/<rel>`) on success, an error string on rejection.
/// Extracted so it can be unit-tested without spinning up a Tauri app.
fn sanitize_bundled_relpath(rel: &str) -> Result<String, String> {
    // Strip leading separators of either flavor — the resource resolver
    // anchors any result inside the bundle, but normalizing here closes
    // the defense-in-depth gap on Windows where a `\foo` prefix would
    // otherwise pass through unstripped.
    let trimmed = rel.trim_start_matches(|c| c == '/' || c == '\\');
    let candidate = PathBuf::from(trimmed);
    if candidate.is_absolute()
        || candidate
            .components()
            .any(|c| matches!(c, Component::ParentDir))
    {
        return Err(format!("invalid bundled path: {}", rel));
    }
    Ok(format!("openit-plugin/{}", trimmed))
}

#[cfg(test)]
mod tests {
    use super::sanitize_bundled_relpath;

    #[test]
    fn accepts_simple_relative_paths() {
        assert_eq!(
            sanitize_bundled_relpath("manifest.json").unwrap(),
            "openit-plugin/manifest.json",
        );
        assert_eq!(
            sanitize_bundled_relpath("skills/triage.md").unwrap(),
            "openit-plugin/skills/triage.md",
        );
        assert_eq!(
            sanitize_bundled_relpath("schemas/openit-tickets._schema.json").unwrap(),
            "openit-plugin/schemas/openit-tickets._schema.json",
        );
    }

    #[test]
    fn strips_a_single_leading_slash() {
        // Manifest entries shouldn't have one but if they do, behave the
        // same as the unprefixed form (instead of treating it as an
        // absolute path that must be rejected).
        assert_eq!(
            sanitize_bundled_relpath("/manifest.json").unwrap(),
            "openit-plugin/manifest.json",
        );
    }

    #[test]
    fn rejects_parent_dir_traversal() {
        assert!(sanitize_bundled_relpath("../etc/passwd").is_err());
        assert!(sanitize_bundled_relpath("skills/../../../etc/passwd").is_err());
        assert!(sanitize_bundled_relpath("a/../b").is_err());
    }

    #[test]
    fn leading_slashes_normalize_to_relative() {
        // Any leading slashes are stripped, and Tauri's resource resolver
        // then anchors the result inside the bundle. So a path like
        // `/etc/passwd` becomes `etc/passwd` and is read from
        // `<bundle-resources>/openit-plugin/etc/passwd` — which doesn't
        // exist. The actual escape we care about is `..` traversal, not
        // a leading slash.
        assert!(sanitize_bundled_relpath("/etc/passwd").is_ok());
        assert!(sanitize_bundled_relpath("//etc/passwd").is_ok());
    }

    #[test]
    fn windows_backslash_separators_also_stripped() {
        // BugBot Low #25: defense-in-depth. On Windows, a `\foo` prefix
        // would otherwise pass through unstripped. Verify the trim
        // handles both flavors uniformly so future refactors that drop
        // the `openit-plugin/` prefix don't expose the gap.
        assert_eq!(
            sanitize_bundled_relpath("\\manifest.json").unwrap(),
            "openit-plugin/manifest.json",
        );
        assert_eq!(
            sanitize_bundled_relpath("\\\\manifest.json").unwrap(),
            "openit-plugin/manifest.json",
        );
        // Mixed leading separators get fully stripped.
        assert_eq!(
            sanitize_bundled_relpath("/\\/manifest.json").unwrap(),
            "openit-plugin/manifest.json",
        );
    }

    #[test]
    fn rejects_dotdot_anywhere_in_path() {
        // The substantive guarantee: no manifest entry can climb out of
        // openit-plugin/. Validate by injecting `..` at every position.
        assert!(sanitize_bundled_relpath("../foo").is_err());
        assert!(sanitize_bundled_relpath("foo/..").is_err());
        assert!(sanitize_bundled_relpath("foo/../bar").is_err());
        assert!(sanitize_bundled_relpath("a/b/c/../../../etc/passwd").is_err());
    }

    #[test]
    fn rejects_double_dot_in_middle() {
        // "skills/..foo" is a regular filename and should pass; only a
        // bare ".." path component is rejected.
        assert!(sanitize_bundled_relpath("skills/..foo.md").is_ok());
        assert!(sanitize_bundled_relpath("skills/..").is_err());
    }
}

/// Extract environment root URL from app-api URL.
/// e.g., "https://app-api.dev20.pinkfish.dev/..." -> "https://dev20.pinkfish.dev"
fn extract_env_root(app_api_url: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(app_api_url)
        .map_err(|e| format!("Invalid app-api URL: {}", e))?;

    let host = url.host_str()
        .ok_or_else(|| "No host in URL".to_string())?;

    // Replace "app-api." prefix if present
    let env_host = if host.starts_with("app-api.") {
        &host[8..] // Skip "app-api."
    } else {
        host
    };

    Ok(format!(
        "{}://{}",
        url.scheme(),
        env_host
    ))
}
