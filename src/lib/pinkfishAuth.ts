import { keychainDelete, keychainGet, keychainSet, pinkfishOauthExchange } from "./api";

const SLOT_CLIENT_ID = "pinkfish.client_id";
const SLOT_CLIENT_SECRET = "pinkfish.client_secret";
const SLOT_ORG_ID = "pinkfish.org_id";
const SLOT_TOKEN_URL = "pinkfish.token_url";

export const DEFAULT_TOKEN_URL = "https://app-api.app.pinkfish.ai/oauth/token";
const REFRESH_BUFFER_SECONDS = 60;

export type PinkfishUrls = {
  tokenUrl: string;
  accountUrl: string; // mcp.<env>.pinkfish.<tld>/pf-account
  mcpBaseUrl: string; // https://mcp.<env>.pinkfish.<tld>
  connectionsUrl: string; // proxy(-stage).pinkfish.ai/manage/user-connections?format=light
  skillsBaseUrl: string; // skills(-stage).pinkfish.ai — direct REST API for file storage
  appBaseUrl: string;     // app-api.<env>.pinkfish.<tld> — platform REST (/user-agents, /automations)
};

/// Derive related Pinkfish URLs from the user-configured token URL. All
/// dev environments live on `*.pinkfish.dev` and use the stage proxy;
/// prod is `*.pinkfish.ai` on the production proxy.
export function derivedUrls(tokenUrl: string): PinkfishUrls {
  let host: string;
  let protocol = "https:";
  try {
    const parsed = new URL(tokenUrl);
    host = parsed.host;
    protocol = parsed.protocol;
  } catch {
    // Fall back to prod if the token URL is malformed.
    host = "app-api.app.pinkfish.ai";
  }
  const mcpHost = host.replace(/^app-api\./, "mcp.");
  const isDev = host.endsWith(".pinkfish.dev") || /\.dev\d/i.test(host);
  const proxyHost = isDev ? "proxy-stage.pinkfish.ai" : "proxy.pinkfish.ai";
  const skillsHost = isDev ? "skills-stage.pinkfish.ai" : "skills.pinkfish.ai";
  return {
    tokenUrl,
    accountUrl: `${protocol}//${mcpHost}/pf-account`,
    mcpBaseUrl: `${protocol}//${mcpHost}`,
    connectionsUrl: `https://${proxyHost}/manage/user-connections?format=light`,
    skillsBaseUrl: `${protocol}//${skillsHost}`,
    appBaseUrl: `${protocol}//${host}`,
  };
}

export type PinkfishCreds = {
  clientId: string;
  clientSecret: string;
  orgId: string;
  tokenUrl: string;
};

export type PinkfishTokenState = {
  accessToken: string;
  expiresAt: number; // ms epoch
  orgId: string;
};

function scopeFor(orgId: string): string {
  return `org:${orgId}`;
}

let current: PinkfishTokenState | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<(s: PinkfishTokenState | null) => void>();

export function subscribeToken(fn: (s: PinkfishTokenState | null) => void): () => void {
  listeners.add(fn);
  fn(current);
  return () => listeners.delete(fn);
}

function notify() {
  for (const l of listeners) l(current);
}

export function getToken(): PinkfishTokenState | null {
  return current;
}

export async function loadCreds(): Promise<PinkfishCreds | null> {
  // In dev mode, check for env-provided creds first to avoid keychain prompts
  const envClientId = import.meta.env.VITE_DEV_CLIENT_ID;
  const envClientSecret = import.meta.env.VITE_DEV_CLIENT_SECRET;
  const envOrgId = import.meta.env.VITE_DEV_ORG_ID;
  if (envClientId && envClientSecret && envOrgId) {
    console.log("[auth] using dev env creds (skipping keychain)");
    return {
      clientId: envClientId,
      clientSecret: envClientSecret,
      orgId: envOrgId,
      tokenUrl: import.meta.env.VITE_DEV_TOKEN_URL || DEFAULT_TOKEN_URL,
    };
  }

  const [clientId, clientSecret, orgId, tokenUrl] = await Promise.all([
    keychainGet(SLOT_CLIENT_ID),
    keychainGet(SLOT_CLIENT_SECRET),
    keychainGet(SLOT_ORG_ID),
    keychainGet(SLOT_TOKEN_URL),
  ]);
  console.log("[auth] loadCreds slots:", {
    client_id: !!clientId,
    client_secret: !!clientSecret,
    org_id: !!orgId,
    token_url: !!tokenUrl,
  });
  if (!clientId || !clientSecret || !orgId) return null;
  return { clientId, clientSecret, orgId, tokenUrl: tokenUrl ?? DEFAULT_TOKEN_URL };
}

export async function saveCreds(creds: PinkfishCreds): Promise<void> {
  // Skip keychain writes when using dev env creds
  if (import.meta.env.VITE_DEV_CLIENT_ID) {
    console.log("[auth] dev mode — skipping keychain write");
    return;
  }

  console.log("[auth] saveCreds called with", {
    client_id_len: creds.clientId.length,
    client_secret_len: creds.clientSecret.length,
    org_id_len: creds.orgId.length,
    token_url_len: creds.tokenUrl.length,
  });
  try {
    await Promise.all([
      keychainSet(SLOT_CLIENT_ID, creds.clientId),
      keychainSet(SLOT_CLIENT_SECRET, creds.clientSecret),
      keychainSet(SLOT_ORG_ID, creds.orgId),
      keychainSet(SLOT_TOKEN_URL, creds.tokenUrl || DEFAULT_TOKEN_URL),
    ]);
    console.log("[auth] saveCreds wrote all 4 slots");
  } catch (e) {
    console.error("[auth] saveCreds threw:", e);
    throw e;
  }
}

export async function clearCreds(): Promise<void> {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  current = null;
  notify();
  await Promise.all([
    keychainDelete(SLOT_CLIENT_ID),
    keychainDelete(SLOT_CLIENT_SECRET),
    keychainDelete(SLOT_ORG_ID),
    keychainDelete(SLOT_TOKEN_URL),
  ]);
}

/// Exchange creds for an access token, store in memory, schedule refresh.
export async function refresh(creds: PinkfishCreds): Promise<PinkfishTokenState> {
  const result = await pinkfishOauthExchange({
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    scope: scopeFor(creds.orgId),
    tokenUrl: creds.tokenUrl,
  });
  const expiresInSeconds = result.expires_in ?? 3600;
  const expiresAt = Date.now() + expiresInSeconds * 1000;
  current = {
    accessToken: result.access_token,
    expiresAt,
    orgId: creds.orgId,
  };
  notify();

  if (refreshTimer) clearTimeout(refreshTimer);
  const refreshInMs = Math.max(10_000, (expiresInSeconds - REFRESH_BUFFER_SECONDS) * 1000);
  refreshTimer = setTimeout(() => {
    refresh(creds).catch((e) => {
      console.error("pinkfish token refresh failed:", e);
      current = null;
      notify();
    });
  }, refreshInMs);

  return current;
}

/// On app launch: load creds from keychain and kick off the first refresh.
export async function startAuth(): Promise<PinkfishTokenState | null> {
  const creds = await loadCreds();
  if (!creds) return null;
  try {
    return await refresh(creds);
  } catch (e) {
    console.error("pinkfish initial token refresh failed:", e);
    return null;
  }
}
