import { fetch } from "@tauri-apps/plugin-http";

export type AuthStyle = "auth-token" | "bearer";

export function makeSkillsFetch(accessToken: string, authStyle: AuthStyle = "auth-token") {
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
