use serde::{Deserialize, Serialize};

pub const DEFAULT_TOKEN_URL: &str = "https://app-api.app.pinkfish.ai/oauth/token";
pub const DEFAULT_TEST_URL: &str = "https://mcp.app.pinkfish.ai/weather";

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: Option<u64>,
    token_type: Option<String>,
    scope: Option<String>,
}

#[derive(Serialize)]
pub struct OauthResult {
    pub access_token: String,
    pub expires_in: Option<u64>,
    pub token_type: Option<String>,
    pub scope: Option<String>,
}

/// Exchange client_credentials for a Pinkfish access token. The scope is
/// the org id (e.g. "org:689584191634"); client_id + client_secret come
/// from the user's Pinkfish admin console. `token_url` defaults to
/// DEFAULT_TOKEN_URL when null/empty so the user can override it for
/// staging environments.
#[tauri::command]
pub async fn pinkfish_oauth_exchange(
    client_id: String,
    client_secret: String,
    scope: String,
    token_url: Option<String>,
) -> Result<OauthResult, String> {
    let url = match token_url {
        Some(u) if !u.trim().is_empty() => u,
        _ => DEFAULT_TOKEN_URL.to_string(),
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .post(&url)
        .form(&[
            ("grant_type", "client_credentials"),
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("scope", scope.as_str()),
        ])
        .send()
        .await
        .map_err(|e| format!("network error: {}", e))?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, body));
    }

    let token: TokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("could not parse token response: {}", e))?;

    Ok(OauthResult {
        access_token: token.access_token,
        expires_in: token.expires_in,
        token_type: token.token_type,
        scope: token.scope,
    })
}

/// Hit the public weather MCP endpoint with the bearer token to confirm the
/// token is usable end-to-end. Returns the parsed JSON-RPC response or an
/// HTTP-style error string.
#[tauri::command]
pub async fn pinkfish_test_call(
    access_token: String,
    org_id: String,
    test_url: Option<String>,
) -> Result<serde_json::Value, String> {
    let url = match test_url {
        Some(u) if !u.trim().is_empty() => u,
        _ => DEFAULT_TEST_URL.to_string(),
    };

    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": "weather_get_current",
            "arguments": {"city": "London"}
        }
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .post(&url)
        .bearer_auth(&access_token)
        .header("X-Selected-Org", &org_id)
        .header("Accept", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("network error: {}", e))?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, text));
    }
    serde_json::from_str::<serde_json::Value>(&text)
        .map_err(|e| format!("could not parse response: {} — body: {}", e, text))
}
