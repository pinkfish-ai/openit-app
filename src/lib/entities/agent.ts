// Agent adapter for syncEngine. Lists `/user-agents` (REST) — replaces the
// pre-R4 MCP-based agent_list call which didn't expose `updatedAt`. Each
// openit-* cloud agent becomes a JSON file at `agents/<localName>.json`,
// where `localName` is the cloud `name` with the `openit-` prefix
// stripped. Same convention as `databases/<name>` ↔ `openit-<name>` for
// datastores and `filestores/<name>` ↔ `openit-<name>` for filestores.
//
// V1 push surface: typed POST/PATCH/DELETE wrappers below. The on-disk
// shape is narrowed to exactly the fields V1 owns (`id`, `name`,
// `description`, `instructions`); fields like `selectedModel` /
// `isShared` deliberately don't round-trip until the future iteration
// that adds them to the disk schema, the PATCH body, and the UI.

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
  OutOfSync,
  shadowFilename,
  type EntityAdapter,
  type LocalItem,
  type Manifest,
  type RemoteItem,
} from "../syncEngine";

const DIR = "agents";
const PREFIX = "openit-";

/// Strip the `openit-` prefix for the local form. Cloud `openit-triage`
/// becomes local `triage`; the local file lives at `agents/triage.json`
/// with `name: "triage"`. Idempotent for unprefixed inputs.
export function localAgentName(cloudName: string): string {
  return cloudName.startsWith(PREFIX)
    ? cloudName.slice(PREFIX.length)
    : cloudName;
}

/// Add the `openit-` prefix for the cloud form. Local `triage` becomes
/// cloud `openit-triage` for POST/PATCH bodies. Idempotent if the local
/// name already carries the prefix (defensive — user-edited names that
/// somehow include the prefix still produce a single-prefix cloud name).
export function cloudAgentName(localName: string): string {
  return localName.startsWith(PREFIX) ? localName : `${PREFIX}${localName}`;
}

export type AgentRow = {
  id: string;
  name: string;
  description?: string;
  instructions?: string;
};

/// Server response shape for the user-agents endpoints. Includes fields
/// V1 reads off the response (id + version metadata for manifest
/// reconciliation) but doesn't carry to disk. Other server-managed
/// fields (acl, createdBy, etc.) exist on the wire — we just don't
/// declare or read them.
export type FullAgentResponse = {
  id: string;
  name: string;
  description?: string;
  instructions?: string;
  version?: number;
  versionDate?: string;
  updatedAt?: string;
};

/// Strip everything except the four V1 fields. Keeps the on-disk shape
/// stable across pulls (otherwise every pull rewrites the file with
/// fresh `updatedAt` and looks like a local edit) and forces edits to
/// fields V1 doesn't own (selectedModel, isShared, …) to be irrelevant
/// — they're not on disk, so they can't be silently dropped on push.
function canonicalizeForDisk(agent: AgentRow): string {
  return JSON.stringify(
    {
      id: agent.id,
      name: agent.name,
      description: agent.description ?? "",
      instructions: agent.instructions ?? "",
    },
    null,
    2,
  );
}

function safeFilename(name: string): string {
  return `${name.replace(/[/\\:*?"<>|]/g, "_")}.json`;
}

function agentsBaseUrl(creds: PinkfishCreds): URL {
  const urls = derivedUrls(creds.tokenUrl);
  return new URL("/service/useragents", urls.appBaseUrl);
}

function agentsItemUrl(creds: PinkfishCreds, id: string): URL {
  const urls = derivedUrls(creds.tokenUrl);
  return new URL(
    `/service/useragents/${encodeURIComponent(id)}`,
    urls.appBaseUrl,
  );
}

function authedFetch(): ReturnType<typeof makeSkillsFetch> {
  const token = getToken();
  if (!token) throw new Error("not authenticated");
  return makeSkillsFetch(token.accessToken, "bearer");
}

async function listUserAgents(creds: PinkfishCreds): Promise<AgentRow[]> {
  const fetchFn = authedFetch();
  const resp = await fetchFn(agentsBaseUrl(creds).toString());
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
  }));
}

/// Pulled list with the raw `updatedAt` retained — used by `listRemote`
/// to populate the engine's manifest version slot. The narrowed
/// `AgentRow` doesn't carry it, so we read it inline here.
async function listUserAgentsWithMeta(
  creds: PinkfishCreds,
): Promise<Array<AgentRow & { updatedAt?: string }>> {
  const fetchFn = authedFetch();
  const resp = await fetchFn(agentsBaseUrl(creds).toString());
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
    updatedAt: typeof a.updatedAt === "string" ? a.updatedAt : undefined,
  }));
}

export async function getUserAgent(
  creds: PinkfishCreds,
  id: string,
): Promise<FullAgentResponse> {
  const fetchFn = authedFetch();
  const resp = await fetchFn(agentsItemUrl(creds, id).toString());
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  }
  return (await resp.json()) as FullAgentResponse;
}

export async function postUserAgent(
  creds: PinkfishCreds,
  body: { name: string; description?: string; instructions?: string },
): Promise<FullAgentResponse> {
  const fetchFn = authedFetch();
  const resp = await fetchFn(agentsBaseUrl(creds).toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  }
  return (await resp.json()) as FullAgentResponse;
}

export async function patchUserAgent(
  creds: PinkfishCreds,
  id: string,
  body: { name: string; description?: string; instructions?: string },
): Promise<FullAgentResponse> {
  const fetchFn = authedFetch();
  const resp = await fetchFn(agentsItemUrl(creds, id).toString(), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (resp.status === 409) {
    // Body parse for context is optional; status is the signal. Platform
    // maps `errors.OutOfSync` to 409 in `servers/internal/helpers.go`.
    throw new OutOfSync();
  }
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  }
  return (await resp.json()) as FullAgentResponse;
}

export async function deleteUserAgent(
  creds: PinkfishCreds,
  id: string,
): Promise<void> {
  const fetchFn = authedFetch();
  const resp = await fetchFn(agentsItemUrl(creds, id).toString(), {
    method: "DELETE",
  });
  if (!resp.ok && resp.status !== 404) {
    throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  }
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
async function listLocalAgents(
  repo: string,
): Promise<{ filename: string; mtime_ms: number | null }[]> {
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
  initialAgents?: Array<AgentRow & { updatedAt?: string }>;
}): EntityAdapter {
  const { creds } = args;
  let cachedFirst: Array<AgentRow & { updatedAt?: string }> | undefined =
    args.initialAgents;
  return {
    prefix: "agent",

    loadManifest: (repo) =>
      invoke<Manifest>("entity_state_load", { repo, name: "agent" }),
    saveManifest: (repo, m) =>
      invoke<void>("entity_state_save", { repo, name: "agent", state: m }),

    async listRemote(_repo, _manifest) {
      const agents =
        cachedFirst ??
        (await listUserAgentsWithMeta(creds)).filter((a) =>
          a.name.startsWith(PREFIX),
        );
      cachedFirst = undefined;
      const items: RemoteItem[] = [];
      for (const a of agents) {
        if (!a.name) continue;
        // Strip the prefix at the sync boundary — disk uses the local
        // form (`triage`), cloud uses the prefixed form (`openit-triage`).
        // The boundary is symmetric with `pushAllToAgents`'s
        // `cloudAgentName(localName)` re-prefixing on POST/PATCH.
        const localName = localAgentName(a.name);
        const localRow: AgentRow & { updatedAt?: string } = {
          ...a,
          name: localName,
        };
        const filename = safeFilename(localName);
        const content = canonicalizeForDisk(localRow);
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

// Internal helper exported for the agentSync wrapper's pre-fetch path so
// it can cache the full row (with `updatedAt`) into the adapter.
export { listUserAgentsWithMeta };

// Constants exported for reuse by the migration shim and push wrapper.
export { DIR as AGENT_DIR, PREFIX as AGENT_PREFIX };
