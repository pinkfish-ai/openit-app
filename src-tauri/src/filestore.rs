use reqwest::Client;
use std::time::Duration;

/// Fetch data collections (filestore) from the app-api URL.
#[tauri::command]
pub async fn filestore_list_collections(
    app_api_url: String,
    access_token: String,
    collection_type: Option<String>,
) -> Result<String, String> {
    let env_root = extract_env_root(&app_api_url)?;
    let mut url = format!("{}/datacollection/", env_root.trim_end_matches('/'));

    if let Some(ty) = collection_type {
        url.push_str(&format!("?type={}", ty));
    }

    println!("[filestore] Fetching from: {}", url);

    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(&url)
        .bearer_auth(&access_token)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch collections: {}", e))?;

    let status = resp.status();
    println!("[filestore] Response status: {}", status);

    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        println!("[filestore] Error response body: {}", text);
        return Err(format!("Collection fetch failed with status: {}", status));
    }

    resp.text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))
}

/// Fetch data collections (datastore) from the app-api URL.
#[tauri::command]
pub async fn datastore_list_collections(
    app_api_url: String,
    access_token: String,
) -> Result<String, String> {
    let env_root = extract_env_root(&app_api_url)?;
    let url = format!(
        "{}/datacollection/?type=datastore",
        env_root.trim_end_matches('/')
    );

    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(&url)
        .bearer_auth(&access_token)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch collections: {}", e))?;

    let status = resp.status();

    if !status.is_success() {
        return Err(format!("Collection fetch failed with status: {}", status));
    }

    resp.text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))
}

/// Extract environment root URL from app-api URL.
/// e.g., "https://app-api.dev20.pinkfish.dev/..." -> "https://dev20.pinkfish.dev"
fn extract_env_root(app_api_url: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(app_api_url)
        .map_err(|e| format!("Invalid app-api URL: {}", e))?;

    let host = url
        .host_str()
        .ok_or_else(|| "No host in URL".to_string())?;

    // Replace "app-api." prefix if present
    let env_host = if host.starts_with("app-api.") {
        &host[8..] // Skip "app-api."
    } else {
        host
    };

    Ok(format!("{}://{}", url.scheme(), env_host))
}
