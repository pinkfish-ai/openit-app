import { loadConfig, type IntegrationTestConfig } from "./config";

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

/**
 * Get a real access token using client credentials.
 *
 * The tokenUrl in test-config.json is the FULL URL to the OAuth endpoint
 * (including /oauth/token path), e.g.:
 *   https://app-api.dev20.pinkfish.dev/oauth/token
 *
 * This matches the curl pattern:
 *   curl -X POST "$TOKEN_URL" \
 *     -H "Content-Type: application/x-www-form-urlencoded" \
 *     -d "grant_type=client_credentials" \
 *     -d "client_id=$CLIENT_ID" \
 *     -d "client_secret=$CLIENT_SECRET" \
 *     -d "scope=org:$ORG_ID"
 */
export async function getAccessToken(): Promise<string> {
  const config = loadConfig();
  if (!config) {
    throw new Error("test-config.json not found");
  }
  return getAccessTokenWithConfig(config);
}

export async function getAccessTokenWithConfig(
  config: IntegrationTestConfig,
): Promise<string> {
  const params = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.credentials.clientId,
    client_secret: config.credentials.clientSecret,
    scope: `org:${config.orgId}`,
  });

  // Use tokenUrl directly — it already includes the /oauth/token path
  const response = await fetch(config.credentials.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Failed to get token: HTTP ${response.status} ${response.statusText}: ${errorBody}`,
    );
  }

  const data = (await response.json()) as TokenResponse;
  console.log(`✓ Got access token (expires in ${data.expires_in}s)`);
  return data.access_token;
}
