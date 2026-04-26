import { fetch } from "@tauri-apps/plugin-http";

export type AuthStyle = "auth-token" | "bearer";

/// Build an authenticated fetch helper. `authStyle: "bearer"` uses the
/// platform-REST convention (`Authorization: Bearer …`); platform calls
/// also need `X-Selected-Org` set to the org id, otherwise they 401.
/// `authStyle: "auth-token"` (default) uses the skills-REST convention
/// (`Auth-Token: Bearer …`), which doesn't need an org header.
export function makeSkillsFetch(
  accessToken: string,
  authStyle: AuthStyle = "auth-token",
  orgId?: string,
) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    if (authStyle === "auth-token") {
      headers.set("Auth-Token", `Bearer ${accessToken}`);
    } else {
      headers.set("Authorization", `Bearer ${accessToken}`);
      if (orgId) headers.set("X-Selected-Org", orgId);
    }
    headers.set("Accept", "application/json");
    return fetch(input, { ...init, headers });
  };
}
