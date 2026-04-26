import { fetch } from "@tauri-apps/plugin-http";

export type AuthStyle = "auth-token" | "bearer";

/// Build an authenticated fetch helper. There is exactly ONE token in
/// OpenIT — the runtime token from OAuth client-credentials. It's
/// accepted by all three Pinkfish-side hosts:
///   - `skills*.pinkfish.ai` (resources)        → `Auth-Token: Bearer …`
///   - `app-api.<env>.pinkfish.<tld>/service/*` (agents, automations) → `Authorization: Bearer …`
///   - `proxy*.pinkfish.ai` (connections)       → `Auth-Token: Bearer …`
/// The two header names are a backend-historical wart; same token,
/// different headers per host. Org comes from the JWT claims so no
/// X-Selected-Org is needed for any of these hosts. (Web's `/api/*`
/// Cognito routes are different and not used by OpenIT.)
///
/// `auth-token` (default) for skills + proxy. `bearer` for platform
/// `/service/*`.
export function makeSkillsFetch(
  accessToken: string,
  authStyle: AuthStyle = "auth-token",
) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    if (authStyle === "auth-token") {
      headers.set("Auth-Token", `Bearer ${accessToken}`);
    } else {
      headers.set("Authorization", `Bearer ${accessToken}`);
    }
    headers.set("Accept", "application/json");
    return fetch(input, { ...init, headers });
  };
}
