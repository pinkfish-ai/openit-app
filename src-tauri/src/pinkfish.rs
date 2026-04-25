use serde::{Deserialize, Serialize};

pub const DEFAULT_TOKEN_URL: &str = "https://app-api.app.pinkfish.ai/oauth/token";
pub const DEFAULT_ACCOUNT_URL: &str = "https://mcp.app.pinkfish.ai/pf-account";
pub const DEFAULT_CONNECTIONS_URL: &str =
    "https://proxy.pinkfish.ai/manage/user-connections?format=light";

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

#[derive(Serialize)]
pub struct OrgRow {
    pub id: String,
    pub name: String,
    pub can_read: bool,
    pub can_write: bool,
    pub administer: bool,
    pub parent_id: Option<String>,
}

/// Call the pf-account MCP endpoint with the user's bearer token to list every
/// org they can access. Doubles as a "is this token alive?" check — if the
/// token is bad, this returns an error. Flattens parent + sub-orgs into a
/// single list so the picker can show everything.
#[tauri::command]
pub async fn pinkfish_list_orgs(
    access_token: String,
    org_id: String,
    account_url: Option<String>,
) -> Result<Vec<OrgRow>, String> {
    let url = match account_url {
        Some(u) if !u.trim().is_empty() => u,
        _ => DEFAULT_ACCOUNT_URL.to_string(),
    };

    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": "pf_account_list_orgs",
            "arguments": {}
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
    let envelope: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("could not parse response: {} — body: {}", e, text))?;

    let orgs = envelope
        .get("result")
        .and_then(|r| r.get("structuredContent"))
        .and_then(|s| s.get("organizations"))
        .and_then(|o| o.as_array())
        .ok_or_else(|| "no organizations in response".to_string())?;

    let mut rows = Vec::new();
    for org in orgs {
        push_org(org, None, &mut rows);
        if let Some(subs) = org.get("subOrganizations").and_then(|s| s.as_array()) {
            let parent_id = org
                .get("account")
                .and_then(|a| a.get("number"))
                .and_then(|n| n.as_str())
                .map(|s| s.to_string());
            for sub in subs {
                push_org(sub, parent_id.clone(), &mut rows);
            }
        }
    }
    Ok(rows)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct UserConnection {
    pub id: String,
    pub name: String,
    pub service_key: String,
    pub status: String,
}

/// List the user's installed connections via proxy.pinkfish.ai. Used to check
/// whether Slack / Teams are connected. Note: this endpoint expects the auth
/// header `Auth-Token: Bearer <jwt>`, not standard `Authorization`.
#[tauri::command]
pub async fn pinkfish_list_connections(
    access_token: String,
    connections_url: Option<String>,
) -> Result<Vec<UserConnection>, String> {
    let url = match connections_url {
        Some(u) if !u.trim().is_empty() => u,
        _ => DEFAULT_CONNECTIONS_URL.to_string(),
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(&url)
        .header("Auth-Token", format!("Bearer {}", access_token))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("network error: {}", e))?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, text));
    }
    let arr: Vec<serde_json::Value> = serde_json::from_str(&text)
        .map_err(|e| format!("could not parse connections: {} — body: {}", e, text))?;

    Ok(arr
        .into_iter()
        .filter_map(|v| {
            Some(UserConnection {
                id: v.get("id")?.as_str()?.to_string(),
                name: v.get("name")?.as_str()?.to_string(),
                service_key: v.get("service_key")?.as_str()?.to_string(),
                status: v.get("status")?.as_str()?.to_string(),
            })
        })
        .collect())
}

fn push_org(org: &serde_json::Value, parent_id: Option<String>, out: &mut Vec<OrgRow>) {
    let acct = match org.get("account") {
        Some(v) => v,
        None => return,
    };
    let id = acct
        .get("number")
        .and_then(|n| n.as_str())
        .unwrap_or("")
        .to_string();
    if id.is_empty() {
        return;
    }
    let name = acct
        .get("name")
        .and_then(|n| n.as_str())
        .unwrap_or("Untitled")
        .to_string();
    let acl = org.get("acl");
    let can_read = acl
        .and_then(|a| a.get("canRead"))
        .and_then(|b| b.as_bool())
        .unwrap_or(false);
    let can_write = acl
        .and_then(|a| a.get("canWrite"))
        .and_then(|b| b.as_bool())
        .unwrap_or(false);
    let administer = acl
        .and_then(|a| a.get("administer"))
        .and_then(|b| b.as_bool())
        .unwrap_or(false);

    out.push(OrgRow {
        id,
        name,
        can_read,
        can_write,
        administer,
        parent_id,
    });
}
