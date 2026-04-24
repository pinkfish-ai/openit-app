import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type FileNode = { name: string; path: string; is_dir: boolean };

export async function fsList(root: string): Promise<FileNode[]> {
  return invoke("fs_list", { root });
}

export async function fsRead(path: string): Promise<string> {
  return invoke("fs_read", { path });
}

export type GitCommit = {
  sha: string;
  short_sha: string;
  author: string;
  date: string;
  subject: string;
};

export async function gitLog(repo: string): Promise<GitCommit[]> {
  return invoke("git_log", { repo });
}

export async function gitDiff(repo: string, sha: string): Promise<string> {
  return invoke("git_diff", { repo, sha });
}

export async function pinkitDeploy(repo: string, env: string): Promise<void> {
  return invoke("pinkit_deploy", { args: { repo, env } });
}

export type DeployLine = { stream: "stdout" | "stderr"; line: string };
export type DeployExit = { code: number | null };

export async function onDeployLine(handler: (line: DeployLine) => void): Promise<UnlistenFn> {
  return listen<DeployLine>("cli://deploy-line", (e) => handler(e.payload));
}

export async function onDeployExit(handler: (exit: DeployExit) => void): Promise<UnlistenFn> {
  return listen<DeployExit>("cli://deploy-exit", (e) => handler(e.payload));
}

export type AppPersistedState = {
  last_repo: string | null;
  pane_sizes: number[] | null;
  pinned_bubbles: string[] | null;
  onboarding_complete: boolean;
};

export async function stateLoad(): Promise<AppPersistedState> {
  return invoke("state_load");
}

export async function stateSave(state: AppPersistedState): Promise<void> {
  return invoke("state_save", { state });
}

export async function keychainSet(slot: string, value: string): Promise<void> {
  return invoke("keychain_set", { slot, value });
}

export async function keychainGet(slot: string): Promise<string | null> {
  return invoke("keychain_get", { slot });
}

export async function keychainDelete(slot: string): Promise<void> {
  return invoke("keychain_delete", { slot });
}

export type OauthResult = {
  access_token: string;
  expires_in: number | null;
  token_type: string | null;
  scope: string | null;
};

export async function pinkfishOauthExchange(args: {
  clientId: string;
  clientSecret: string;
  scope: string;
  tokenUrl?: string | null;
}): Promise<OauthResult> {
  return invoke("pinkfish_oauth_exchange", {
    clientId: args.clientId,
    clientSecret: args.clientSecret,
    scope: args.scope,
    tokenUrl: args.tokenUrl ?? null,
  });
}

export async function pinkfishTestCall(args: {
  accessToken: string;
  orgId: string;
  testUrl?: string | null;
}): Promise<unknown> {
  return invoke("pinkfish_test_call", {
    accessToken: args.accessToken,
    orgId: args.orgId,
    testUrl: args.testUrl ?? null,
  });
}
