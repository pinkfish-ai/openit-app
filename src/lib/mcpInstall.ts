/// Install MCP servers into the active OpenIT project by shelling out to
/// `claude mcp add --scope project`. Spike 2 confirmed this is the
/// supported programmatic interface — Claude Code owns the schema and the
/// project-scope approval-prompt registration.
///
/// Reading installed state goes through `fs_read` against `.mcp.json` at
/// the project root: tiny well-defined JSON that Claude Code maintains.

import { invoke } from "@tauri-apps/api/core";
import { CATALOG, type CatalogEntry } from "./mcpCatalog";

type McpAddRustArgs = {
  project_root: string;
  name: string;
  transport: "http";
  url: string | null;
  command: string | null;
  command_args: string[] | null;
  env: Array<[string, string]> | null;
};

/// Returns the set of catalog entry IDs already present in `.mcp.json` at
/// the project root. Anything in the file but not in our catalog is
/// ignored — power users may have hand-added servers and we don't want to
/// surface them as "installed via OpenIT" since we can't safely mutate
/// them through this UI.
export async function listInstalled(projectRoot: string): Promise<Set<string>> {
  const path = `${projectRoot.replace(/\/+$/, "")}/.mcp.json`;
  let raw: string;
  try {
    raw = await invoke<string>("fs_read", { path });
  } catch {
    return new Set(); // file missing = nothing installed
  }
  let parsed: { mcpServers?: Record<string, unknown> };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Set(); // malformed file — surface elsewhere if needed
  }
  const present = new Set(Object.keys(parsed.mcpServers ?? {}));
  const catalogIds = new Set(CATALOG.map((e) => e.id));
  return new Set([...present].filter((id) => catalogIds.has(id)));
}

/// Run `claude mcp add` for the given catalog entry. Resolves when the
/// CLI exits cleanly; rejects with the CLI's stderr otherwise.
export async function installServer(
  projectRoot: string,
  entry: CatalogEntry,
): Promise<void> {
  const args: McpAddRustArgs = {
    project_root: projectRoot,
    name: entry.id,
    transport: "http",
    url: entry.url,
    command: null,
    command_args: null,
    env: null,
  };
  await invoke("claude_mcp_add", { args });
}

/// Run `claude mcp remove --scope project <name>` for the given entry.
/// Mirrors `installServer` so the upstream CLI owns schema mutations.
export async function uninstallServer(
  projectRoot: string,
  entry: CatalogEntry,
): Promise<void> {
  await invoke("claude_mcp_remove", {
    args: { project_root: projectRoot, name: entry.id },
  });
}
