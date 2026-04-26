// Agent adapter for syncEngine. Lists `/user-agents` (REST) — replaces the
// pre-R4 MCP-based agent_list call which didn't expose `updatedAt`. Each
// openit-* agent becomes a JSON file at `agents/<name>.json`.
//
// Read-only: no apiUpsert / apiDelete (push isn't in scope for R4). The
// adapter writes content via entityWriteFile and identifies shadows by the
// engine's standard `<base>.server.<ext>` convention (KB/filestore-style).

import {
  entityDeleteFile,
  entityWriteFile,
  fsList,
  fsRead,
  type FileNode,
} from "../api";
import { invoke } from "@tauri-apps/api/core";
import { makeSkillsFetch } from "../../api/fetchAdapter";
import { derivedUrls, getToken, type PinkfishCreds } from "../pinkfishAuth";
import {
  canonicalFromShadow,
  classifyAsShadow,
  shadowFilename,
  type EntityAdapter,
  type LocalItem,
  type Manifest,
  type RemoteItem,
} from "../syncEngine";

const DIR = "agents";
const PREFIX = "openit-";

export type AgentRow = {
  id: string;
  name: string;
  description?: string;
  instructions?: string;
  selectedModel?: string;
  isShared?: boolean;
  updatedAt?: string;
  createdAt?: string;
};

/// Strip volatile API metadata before persisting so every pull doesn't
/// rewrite the file with a new timestamp (would look like a local edit).
/// The "real" updatedAt lives in the manifest, not on disk. Per the plan's
/// "Volatile API metadata in pulled content" edge case.
function canonicalizeForDisk(agent: AgentRow): string {
  const stripped: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(agent)) {
    if (k === "updatedAt" || k === "createdAt" || k === "lastUsedAt") continue;
    stripped[k] = v;
  }
  return JSON.stringify(stripped, null, 2);
}

function safeFilename(name: string): string {
  return `${name.replace(/[/\\:*?"<>|]/g, "_")}.json`;
}

async function listUserAgents(creds: PinkfishCreds): Promise<AgentRow[]> {
  const token = getToken();
  if (!token) throw new Error("not authenticated");
  const urls = derivedUrls(creds.tokenUrl);
  // Platform endpoints use Authorization: Bearer (vs Auth-Token for skills).
  const fetchFn = makeSkillsFetch(token.accessToken, "bearer");
  const url = new URL("/user-agents", urls.appBaseUrl);
  const resp = await fetchFn(url.toString());
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  }
  const raw = (await resp.json()) as Array<Record<string, unknown>> | null;
  const agents = Array.isArray(raw) ? raw : [];
  return agents.map((a) => ({
    id: String(a.id ?? ""),
    name: String(a.name ?? ""),
    description: typeof a.description === "string" ? a.description : undefined,
    instructions:
      typeof a.instructions === "string" ? a.instructions : undefined,
    selectedModel:
      typeof a.selectedModel === "string" ? a.selectedModel : undefined,
    isShared: typeof a.isShared === "boolean" ? a.isShared : undefined,
    updatedAt: typeof a.updatedAt === "string" ? a.updatedAt : undefined,
    createdAt: typeof a.createdAt === "string" ? a.createdAt : undefined,
  }));
}

export async function resolveProjectAgents(
  creds: PinkfishCreds,
): Promise<AgentRow[]> {
  const all = await listUserAgents(creds);
  return all.filter((a) => a.name.startsWith(PREFIX));
}

/// Walk `<repo>/agents/` once, return entries the engine's listLocal
/// contract expects. Tauri side already exposes a generic
/// `entity_list_local` (added in R2); reuse it.
async function listLocalAgents(repo: string): Promise<{ filename: string; mtime_ms: number | null }[]> {
  return invoke<{ filename: string; mtime_ms: number | null; size: number }[]>(
    "entity_list_local",
    { repo, subdir: DIR },
  );
}

export function agentAdapter(args: {
  creds: PinkfishCreds;
  /// Pre-resolved agent list. When provided, listRemote uses this on its
  /// FIRST call instead of issuing a REST request — avoids the double
  /// REST hit on the first sync tick (the wrapper already fetches for
  /// logging). Subsequent listRemote calls (poll ticks) re-fetch via
  /// REST so steady-state stays current.
  initialAgents?: AgentRow[];
}): EntityAdapter {
  const { creds } = args;
  let cachedFirst: AgentRow[] | undefined = args.initialAgents;
  return {
    prefix: "agent",

    loadManifest: (repo) =>
      invoke<Manifest>("entity_state_load", { repo, name: "agent" }),
    saveManifest: (repo, m) =>
      invoke<void>("entity_state_save", { repo, name: "agent", state: m }),

    async listRemote(_repo) {
      const agents = cachedFirst ?? (await resolveProjectAgents(creds));
      cachedFirst = undefined;
      const items: RemoteItem[] = [];
      for (const a of agents) {
        if (!a.name) continue;
        const filename = safeFilename(a.name);
        const content = canonicalizeForDisk(a);
        items.push({
          manifestKey: filename,
          workingTreePath: `${DIR}/${filename}`,
          updatedAt: a.updatedAt ?? "",
          fetchAndWrite: (repo) => entityWriteFile(repo, DIR, filename, content),
          writeShadow: (repo) =>
            entityWriteFile(repo, DIR, shadowFilename(filename), content),
        });
      }
      return { items, paginationFailed: false };
    },

    async listLocal(repo) {
      const files = await listLocalAgents(repo);
      const siblings = new Set(files.map((f) => f.filename));
      const out: LocalItem[] = files.map((f) => {
        const shadow = classifyAsShadow(f.filename, siblings);
        return {
          manifestKey: shadow ? canonicalFromShadow(f.filename) : f.filename,
          workingTreePath: `${DIR}/${f.filename}`,
          mtime_ms: f.mtime_ms,
          isShadow: shadow,
        };
      });
      return out;
    },

    /// Server-deleted agent → delete the local file (matches user
    /// expectation: "I removed it on Pinkfish, why is it still here").
    /// The engine only invokes this when pagination is fully consumed,
    /// so no false positives on a truncated remote list.
    async onServerDelete({ repo, manifestKey, manifest, touched, local }) {
      const stillOnDisk = local.some(
        (f) => !f.isShadow && f.manifestKey === manifestKey,
      );
      if (stillOnDisk) {
        try {
          await entityDeleteFile(repo, DIR, manifestKey);
          touched.push(`${DIR}/${manifestKey}`);
        } catch (e) {
          console.error(`[agent] failed to delete local ${manifestKey}:`, e);
        }
      }
      delete manifest.files[manifestKey];
      return true;
    },
  };
}

// fsRead/fsList re-exports kept here in case future push paths need them
// without re-importing across files.
export { fsRead, fsList, type FileNode };
