import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type FileNode = { name: string; path: string; is_dir: boolean };

export async function fsList(root: string): Promise<FileNode[]> {
  return invoke("fs_list", { root });
}

export async function fsRead(path: string): Promise<string> {
  return invoke("fs_read", { path });
}

export async function fsReadBytes(path: string): Promise<Uint8Array> {
  const arr = (await invoke<number[]>("fs_read_bytes", { path }));
  return new Uint8Array(arr);
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

export async function gitEnsureRepo(repo: string): Promise<void> {
  return invoke("git_ensure_repo", { repo });
}

export async function gitAddAndCommit(repo: string, message: string): Promise<boolean> {
  return invoke("git_add_and_commit", { repo, message });
}

/// Stage exactly the given paths (relative to repo root) and commit. Used by
/// the sync layer so auto-commits never sweep up unrelated user WIP.
export async function gitCommitPaths(
  repo: string,
  paths: string[],
  message: string,
): Promise<boolean> {
  return invoke("git_commit_paths", { repo, paths, message });
}

export type GitFileStatus = { path: string; status: string; staged: boolean };

export async function gitStatusShort(repo: string): Promise<GitFileStatus[]> {
  return invoke("git_status_short", { repo });
}

export async function gitStage(repo: string, paths: string[]): Promise<void> {
  return invoke("git_stage", { repo, paths });
}

export async function gitUnstage(repo: string, paths: string[]): Promise<void> {
  return invoke("git_unstage", { repo, paths });
}

export async function gitCommitStaged(repo: string, message: string): Promise<boolean> {
  return invoke("git_commit_staged", { repo, message });
}

export async function gitDiscard(repo: string, paths: string[]): Promise<void> {
  return invoke("git_discard", { repo, paths });
}

export async function gitFileDiff(repo: string, path: string): Promise<string> {
  return invoke("git_file_diff", { repo, path });
}

export async function gitHasConflictMarkers(repo: string): Promise<boolean> {
  return invoke("git_has_conflict_markers", { repo });
}

export async function gitDiffNameOnly(repo: string, baseSha: string): Promise<string[]> {
  return invoke("git_diff_name_only", { repo, baseSha });
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

export async function keychainProbe(): Promise<boolean> {
  return invoke("keychain_probe");
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

export type OrgRow = {
  id: string;
  name: string;
  can_read: boolean;
  can_write: boolean;
  administer: boolean;
  parent_id: string | null;
};

export async function claudeDetect(): Promise<string | null> {
  return invoke("claude_detect");
}

/// Ask the user's Claude CLI (`claude -p`) to summarize the staged diff into
/// a single commit subject line, matching the style of the recent log.
/// Returns the trimmed first line; throws on missing CLI or empty staging.
export async function claudeGenerateCommitMessage(repo: string): Promise<string> {
  return invoke("claude_generate_commit_message", { repo });
}

export type BootstrapResult = { path: string; created: boolean };

export async function projectBootstrap(args: {
  orgName: string;
  orgId: string;
}): Promise<BootstrapResult> {
  return invoke("project_bootstrap", { orgName: args.orgName, orgId: args.orgId });
}

export async function pinkfishListOrgs(args: {
  accessToken: string;
  orgId: string;
  accountUrl?: string | null;
}): Promise<OrgRow[]> {
  return invoke("pinkfish_list_orgs", {
    accessToken: args.accessToken,
    orgId: args.orgId,
    accountUrl: args.accountUrl ?? null,
  });
}

export type UserConnection = {
  id: string;
  name: string;
  service_key: string;
  status: string;
};

export async function pinkfishListConnections(args: {
  accessToken: string;
  connectionsUrl?: string | null;
}): Promise<UserConnection[]> {
  return invoke("pinkfish_list_connections", {
    accessToken: args.accessToken,
    connectionsUrl: args.connectionsUrl ?? null,
  });
}

export type KbLocalFile = { filename: string; mtime_ms: number | null; size: number };
export type KbFileState = { remote_version: string; pulled_at_mtime_ms: number };
export type KbStatePersisted = {
  collection_id: string | null;
  collection_name: string | null;
  files: Record<string, KbFileState>;
};

export async function kbInit(repo: string): Promise<string> {
  return invoke("kb_init", { repo });
}

export async function kbListLocal(repo: string): Promise<KbLocalFile[]> {
  return invoke("kb_list_local", { repo });
}

export async function kbDeleteFile(repo: string, filename: string): Promise<void> {
  return invoke("kb_delete_file", { repo, filename });
}

export async function kbReadFile(repo: string, filename: string): Promise<string> {
  return invoke("kb_read_file", { repo, filename });
}

export async function kbWriteFile(
  repo: string,
  filename: string,
  content: string,
): Promise<void> {
  return invoke("kb_write_file", { repo, filename, content });
}

export async function kbWriteFileBytes(
  repo: string,
  filename: string,
  bytes: ArrayBuffer | Uint8Array,
): Promise<void> {
  const arr = bytes instanceof Uint8Array ? Array.from(bytes) : Array.from(new Uint8Array(bytes));
  return invoke("kb_write_file_bytes", { repo, filename, bytes: arr });
}

export async function kbStateLoad(repo: string): Promise<KbStatePersisted> {
  return invoke("kb_state_load", { repo });
}

export async function kbStateSave(
  repo: string,
  state: KbStatePersisted,
): Promise<void> {
  return invoke("kb_state_save", { repo, state });
}

export async function kbDownloadToLocal(
  repo: string,
  filename: string,
  url: string,
): Promise<void> {
  return invoke("kb_download_to_local", { repo, filename, url });
}

export type KbUploadResult = {
  id: string;
  filename: string;
  file_url: string | null;
  file_size: number | null;
  mime_type: string | null;
};

export type KbRemoteFile = {
  id: string;
  filename: string;
  signed_url: string | null;
  file_size: number | null;
  mime_type: string | null;
  updated_at: string;
};

export async function kbListRemote(args: {
  collectionId: string;
  skillsBaseUrl: string;
  accessToken: string;
}): Promise<KbRemoteFile[]> {
  return invoke("kb_list_remote", {
    collectionId: args.collectionId,
    skillsBaseUrl: args.skillsBaseUrl,
    accessToken: args.accessToken,
  });
}

export async function kbUploadFile(args: {
  repo: string;
  filename: string;
  collectionId: string;
  skillsBaseUrl: string;
  accessToken: string;
}): Promise<KbUploadResult> {
  return invoke("kb_upload_file", {
    repo: args.repo,
    filename: args.filename,
    collectionId: args.collectionId,
    skillsBaseUrl: args.skillsBaseUrl,
    accessToken: args.accessToken,
  });
}

// ---------------------------------------------------------------------------
// Filestore local commands (mirrors kb_* but for filestore/ directory)
// ---------------------------------------------------------------------------

export async function fsStoreInit(repo: string): Promise<string> {
  return invoke("fs_store_init", { repo });
}

export async function fsStoreListLocal(repo: string): Promise<KbLocalFile[]> {
  return invoke("fs_store_list_local", { repo });
}

export async function fsStoreReadFile(repo: string, filename: string): Promise<string> {
  return invoke("fs_store_read_file", { repo, filename });
}

export async function fsStoreWriteFile(
  repo: string,
  filename: string,
  content: string,
): Promise<void> {
  return invoke("fs_store_write_file", { repo, filename, content });
}

export async function fsStoreWriteFileBytes(
  repo: string,
  filename: string,
  bytes: ArrayBuffer | Uint8Array,
): Promise<void> {
  const arr = bytes instanceof Uint8Array ? Array.from(bytes) : Array.from(new Uint8Array(bytes));
  return invoke("fs_store_write_file_bytes", { repo, filename, bytes: arr });
}

export async function fsStoreStateLoad(repo: string): Promise<KbStatePersisted> {
  return invoke("fs_store_state_load", { repo });
}

export async function fsStoreStateSave(
  repo: string,
  state: KbStatePersisted,
): Promise<void> {
  return invoke("fs_store_state_save", { repo, state });
}

export async function entityWriteFile(repo: string, subdir: string, filename: string, content: string): Promise<void> {
  return invoke("entity_write_file", { repo, subdir, filename, content });
}

export async function entityClearDir(repo: string, subdir: string): Promise<void> {
  return invoke("entity_clear_dir", { repo, subdir });
}

export async function kbSupportedExtensions(): Promise<string[]> {
  return invoke("kb_supported_extensions");
}

/// Generic JSON-RPC tools/call against any Pinkfish MCP server. Returns the
/// raw JSON-RPC envelope; callers pluck `.result.structuredContent` etc.
export async function pinkfishMcpCall(args: {
  accessToken: string;
  orgId: string;
  server: string;
  tool: string;
  arguments: unknown;
  baseUrl?: string | null;
}): Promise<{ result?: { structuredContent?: unknown; content?: unknown }; error?: unknown }> {
  return invoke("pinkfish_mcp_call", {
    accessToken: args.accessToken,
    orgId: args.orgId,
    server: args.server,
    tool: args.tool,
    arguments: args.arguments,
    baseUrl: args.baseUrl ?? null,
  });
}
