import { keychainDelete, keychainGet, keychainSet, pinkfishOauthExchange } from "./api";

const SLOT_CLIENT_ID = "pinkfish.client_id";
const SLOT_CLIENT_SECRET = "pinkfish.client_secret";
const SLOT_ORG_ID = "pinkfish.org_id";
const SLOT_TOKEN_URL = "pinkfish.token_url";

export const DEFAULT_TOKEN_URL = "https://app-api.app.pinkfish.ai/oauth/token";
export const DEFAULT_TEST_URL = "https://mcp.app.pinkfish.ai/weather";
const REFRESH_BUFFER_SECONDS = 60;

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
  const [clientId, clientSecret, orgId, tokenUrl] = await Promise.all([
    keychainGet(SLOT_CLIENT_ID),
    keychainGet(SLOT_CLIENT_SECRET),
    keychainGet(SLOT_ORG_ID),
    keychainGet(SLOT_TOKEN_URL),
  ]);
  if (!clientId || !clientSecret || !orgId) return null;
  return { clientId, clientSecret, orgId, tokenUrl: tokenUrl ?? DEFAULT_TOKEN_URL };
}

export async function saveCreds(creds: PinkfishCreds): Promise<void> {
  await Promise.all([
    keychainSet(SLOT_CLIENT_ID, creds.clientId),
    keychainSet(SLOT_CLIENT_SECRET, creds.clientSecret),
    keychainSet(SLOT_ORG_ID, creds.orgId),
    keychainSet(SLOT_TOKEN_URL, creds.tokenUrl || DEFAULT_TOKEN_URL),
  ]);
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
