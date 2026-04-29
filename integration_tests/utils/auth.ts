import { loadConfig, type IntegrationTestConfig } from "./config";

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

/**
 * Get a real access token using client credentials
 */
export async function getAccessToken(): Promise<string> {
  const config = loadConfig();
  if (!config) {
    throw new Error("test-config.json not found");
  }

  return getAccessTokenWithConfig(config);
}

export async function getAccessTokenWithConfig(config: IntegrationTestConfig): Promise<string> {
  const params = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.credentials.clientId,
    client_secret: config.credentials.clientSecret,
    scope: `org:${config.orgId}`,
  });

  const response = await fetch(`${config.credentials.tokenUrl}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(
      `Failed to get token: HTTP ${response.status}: ${error}`
    );
  }

  const data = (await response.json()) as TokenResponse;
  console.log(`✓ Got access token (expires in ${data.expires_in}s)`);
  return data.access_token;
}

// Store token in environment so getToken() can find it
export async function setupAuthInEnvironment(): Promise<void> {
  const token = await getAccessToken();
  // Set in environment for pinkfishAuth to pick up
  process.env.PINKFISH_DEV_TOKEN = token;
}
