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

/// V2 ships with a single triage agent in a folder layout
/// (`agents/triage/`). Multi-agent / rename support is V3+; the
/// adapter hard-codes this folder for now.
const TRIAGE_SUBDIR = "agents/triage";
const TRIAGE_LOCAL_NAME = "triage";

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

/// Resource reference shape on disk. Wire shape adds `id`,
/// `proxyEndpointId`, optional `description` and `isStructured` —
/// resolved at push time and dropped on pull.
export type AgentResourceRef = {
  name: string;
  canRead?: boolean;
  canWrite?: boolean;
  canDelete?: boolean;
};

export type AgentResources = {
  knowledgeBases?: AgentResourceRef[];
  datastores?: AgentResourceRef[];
  filestores?: AgentResourceRef[];
};

export type AgentTools = {
  servers?: Array<{
    name: string;
    allTools?: boolean;
    /// Pass-through bag for any cloud-side fields the form doesn't
    /// render (V4 will add per-tool config). Preserved on save so
    /// edits don't silently drop unknown rows.
    [k: string]: unknown;
  }>;
};

export type AgentRow = {
  id: string;
  name: string;
  description?: string;
  /// V2: instructions live in three sibling .md files
  /// (`common.md`/`cloud.md`/`local.md`), not on this struct. The .md
  /// files are read separately at push and intake time.
  selectedModel?: string;
  isShared?: boolean;
  promptExamples?: string[];
  introMessage?: string;
  resources?: AgentResources;
  tools?: AgentTools;
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
  selectedModel?: string;
  isShared?: boolean;
  promptExamples?: string[];
  introMessage?: string;
  knowledgeBases?: WireResource[];
  datastores?: WireResource[];
  filestores?: WireResource[];
  servers?: Array<Record<string, unknown>>;
};

export type WireResource = {
  id: string;
  name: string;
  description?: string;
  canRead: boolean;
  canWrite: boolean;
  canDelete: boolean;
  proxyEndpointId: string;
  isStructured?: boolean;
};

/// Strip everything except the V2 disk-owned structured fields. The
/// three .md instruction blocks live as sibling files and are written
/// separately. Keeps the on-disk shape stable across pulls (otherwise
/// every pull would rewrite the file with fresh server-side metadata
/// and look like a local edit).
function canonicalizeForDisk(agent: AgentRow): string {
  const out: Record<string, unknown> = {
    id: agent.id,
    name: agent.name,
    description: agent.description ?? "",
  };
  if (agent.selectedModel !== undefined) out.selectedModel = agent.selectedModel;
  if (agent.isShared !== undefined) out.isShared = agent.isShared;
  if (agent.promptExamples !== undefined) out.promptExamples = agent.promptExamples;
  if (agent.introMessage !== undefined) out.introMessage = agent.introMessage;
  if (agent.resources !== undefined) out.resources = agent.resources;
  if (agent.tools !== undefined) out.tools = agent.tools;
  return JSON.stringify(out, null, 2);
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

/// Project the cloud agent's wire shape down to disk-side. Drops
/// server-managed columns and projects resource refs to the local form
/// (`{name, canRead, canWrite, canDelete}` — no `id`, no
/// `proxyEndpointId`, no `description`, no `isStructured`).
///
/// `instructionsRaw` is captured separately because the disk file
/// doesn't carry `instructions` (the three .md blocks own that), but
/// the pull pipeline needs it for divergence detection.
type ProjectedAgent = AgentRow & {
  updatedAt?: string;
  versionDate?: string;
  instructionsRaw?: string;
};

function projectWireResources(items: unknown): AgentResourceRef[] {
  if (!Array.isArray(items)) return [];
  return items
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((r) => ({
      // Cloud names carry the `openit-` prefix; strip at the boundary
      // so disk uses local short names.
      name: localAgentName(typeof r.name === "string" ? r.name : ""),
      canRead: typeof r.canRead === "boolean" ? r.canRead : undefined,
      canWrite: typeof r.canWrite === "boolean" ? r.canWrite : undefined,
      canDelete: typeof r.canDelete === "boolean" ? r.canDelete : undefined,
    }))
    .filter((r) => r.name.length > 0);
}

function projectWireServers(items: unknown): AgentTools["servers"] {
  if (!Array.isArray(items)) return undefined;
  return items
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((s) => {
      const server: Record<string, unknown> = {
        name: typeof s.name === "string" ? s.name : "",
      };
      if (typeof s.allTools === "boolean") server.allTools = s.allTools;
      // Carry through any other fields verbatim — V4 adds per-tool
      // config, V2's form just renders the toggles. Save-side
      // round-trip relies on this preservation.
      for (const [k, v] of Object.entries(s)) {
        if (k === "name" || k === "allTools") continue;
        server[k] = v;
      }
      return server as { name: string; allTools?: boolean };
    })
    .filter((s) => s.name.length > 0);
}

function projectAgent(a: Record<string, unknown>): ProjectedAgent {
  const row: ProjectedAgent = {
    id: String(a.id ?? ""),
    name: String(a.name ?? ""),
    description: typeof a.description === "string" ? a.description : undefined,
    selectedModel:
      typeof a.selectedModel === "string" ? a.selectedModel : undefined,
    isShared: typeof a.isShared === "boolean" ? a.isShared : undefined,
    promptExamples: Array.isArray(a.promptExamples)
      ? (a.promptExamples as unknown[]).filter((x): x is string => typeof x === "string")
      : undefined,
    introMessage:
      typeof a.introMessage === "string" ? a.introMessage : undefined,
    updatedAt: typeof a.updatedAt === "string" ? a.updatedAt : undefined,
    versionDate: typeof a.versionDate === "string" ? a.versionDate : undefined,
    instructionsRaw:
      typeof a.instructions === "string" ? a.instructions : undefined,
  };
  const kbs = projectWireResources(a.knowledgeBases);
  const dss = projectWireResources(a.datastores);
  const fss = projectWireResources(a.filestores);
  if (kbs.length > 0 || dss.length > 0 || fss.length > 0) {
    row.resources = {};
    if (kbs.length > 0) row.resources.knowledgeBases = kbs;
    if (dss.length > 0) row.resources.datastores = dss;
    if (fss.length > 0) row.resources.filestores = fss;
  }
  const servers = projectWireServers(a.servers);
  if (servers && servers.length > 0) {
    row.tools = { servers };
  }
  return row;
}

async function listUserAgents(creds: PinkfishCreds): Promise<AgentRow[]> {
  const all = await listUserAgentsWithMeta(creds);
  return all.map(({ updatedAt: _u, versionDate: _v, instructionsRaw: _i, ...rest }) => rest);
}

/// Pulled list with the raw `updatedAt` retained — used by `listRemote`
/// to populate the engine's manifest version slot. The disk-shaped
/// `AgentRow` doesn't carry it, so we keep it inline here.
async function listUserAgentsWithMeta(
  creds: PinkfishCreds,
): Promise<ProjectedAgent[]> {
  const fetchFn = authedFetch();
  const resp = await fetchFn(agentsBaseUrl(creds).toString());
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  }
  const raw = (await resp.json()) as Array<Record<string, unknown>> | null;
  const agents = Array.isArray(raw) ? raw : [];
  return agents.map(projectAgent);
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

/// V2 PATCH/POST body — V1's three required fields plus the optional
/// V2 fields that follow the omit-when-absent rule. Caller decides what
/// to include based on what's present on disk.
export type AgentUpsertBody = {
  name: string;
  description: string;
  instructions: string;
  selectedModel?: string;
  isShared?: boolean;
  promptExamples?: string[];
  introMessage?: string;
  knowledgeBases?: WireResource[];
  datastores?: WireResource[];
  filestores?: WireResource[];
  servers?: Array<{ name: string; allTools?: boolean; [k: string]: unknown }>;
};

export async function postUserAgent(
  creds: PinkfishCreds,
  body: AgentUpsertBody,
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
  body: AgentUpsertBody,
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

/// Trigger a release of the agent. The platform takes a snapshot of the
/// current settings and exposes it via the released-agents API. No body.
/// 2xx is success on either the "201 Created" or the "202 Accepted /
/// nothing to release" branch — the latter happens when the latest
/// release is already current.
///
/// Endpoint path is `/service/useragents/by-id/{id}/releases` (the
/// `by-id/` segment disambiguates against `/full/{id}` per Go 1.22
/// ServeMux rules — see platform routes.go:507-508).
export async function releaseUserAgent(
  creds: PinkfishCreds,
  id: string,
): Promise<void> {
  const fetchFn = authedFetch();
  const urls = derivedUrls(creds.tokenUrl);
  const url = new URL(
    `/service/useragents/by-id/${encodeURIComponent(id)}/releases`,
    urls.appBaseUrl,
  );
  const resp = await fetchFn(url.toString(), { method: "POST" });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  }
}

/// Join two instruction blocks with a single blank line between. Both
/// inputs are trimmed first so trailing/leading whitespace doesn't
/// produce double-blank-lines; empty blocks drop out of the join so we
/// never emit a leading or trailing `\n\n` artifact. Used by both
/// push-to-cloud (common + cloud) and local intake (common + local).
export function assembleInstructions(a: string, b: string): string {
  return [a.trim(), b.trim()].filter((s) => s.length > 0).join("\n\n");
}

/// SHA-256 of a string using the Web Crypto API. Used to record what we
/// last sent to the platform's `instructions` field; compared on pull
/// to detect cloud-side edits without storing the full string.
export async function instructionsHash(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const buf = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/// Wire-shape resolved resources for the upsert body. Each list comes
/// back with `id` and `proxyEndpointId` populated. Local refs that
/// can't be resolved (typo, deleted collection, missing proxy) are
/// dropped with a warning callback — the platform's `validateResources`
/// rejects empty `id` / `proxyEndpointId` and that kills the entire
/// PATCH (BadRequest), not skip-with-warning per row. Better to send
/// a partial set than to fail the whole upsert.
export type ResolvedResources = {
  knowledgeBases?: WireResource[];
  datastores?: WireResource[];
  filestores?: WireResource[];
};

type ResourceFetchResult = {
  byName: Map<string, { id: string; description?: string; isStructured?: boolean }>;
};

async function fetchCollectionsByType(
  creds: PinkfishCreds,
  type: "knowledge_base" | "datastore" | "filestore",
): Promise<ResourceFetchResult> {
  const token = getToken();
  if (!token) throw new Error("not authenticated");
  const fetchFn = makeSkillsFetch(token.accessToken);
  const urls = derivedUrls(creds.tokenUrl);
  const url = new URL("/datacollection/", urls.skillsBaseUrl);
  url.searchParams.set("type", type);
  const resp = await fetchFn(url.toString());
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  }
  const raw = (await resp.json()) as Array<Record<string, unknown>> | null;
  const list = Array.isArray(raw) ? raw : [];
  const byName = new Map<
    string,
    { id: string; description?: string; isStructured?: boolean }
  >();
  for (const c of list) {
    const name = typeof c.name === "string" ? c.name : "";
    const id = typeof c.id === "string" || typeof c.id === "number"
      ? String(c.id)
      : "";
    if (!name || !id) continue;
    const entry: { id: string; description?: string; isStructured?: boolean } = { id };
    if (typeof c.description === "string") entry.description = c.description;
    if (typeof c.isStructured === "boolean") entry.isStructured = c.isStructured;
    byName.set(name, entry);
  }
  return { byName };
}

async function fetchProxyEndpoints(
  creds: PinkfishCreds,
): Promise<Map<string, string>> {
  const token = getToken();
  if (!token) throw new Error("not authenticated");
  const fetchFn = makeSkillsFetch(token.accessToken, "bearer");
  const urls = derivedUrls(creds.tokenUrl);
  const url = new URL("/api/proxy-endpoints", urls.appBaseUrl);
  const resp = await fetchFn(url.toString());
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  }
  const raw = (await resp.json()) as Array<Record<string, unknown>> | null;
  const list = Array.isArray(raw) ? raw : [];
  // resourceId → proxy id. One proxy per (resourceId, resourceType)
  // tuple in practice; collisions are vanishingly rare.
  const byResource = new Map<string, string>();
  for (const p of list) {
    const id = typeof p.id === "string" ? p.id : "";
    const resourceId = typeof p.resourceId === "string" ? p.resourceId : "";
    if (id && resourceId) byResource.set(resourceId, id);
  }
  return byResource;
}

/// Resolve disk-side resource refs to wire shape. Three parallel
/// `/datacollection/?type=...` fetches (KB / fs / ds) plus one
/// `/api/proxy-endpoints` fetch in parallel, joined on
/// `proxyEndpoint.resourceId === collection.id`.
///
/// Returns null entries dropped — caller decides whether to treat
/// any drop as fatal. `onWarn` is called per-skipped row so the push
/// log can surface "skipping <type> <name> (not found)".
export async function resolveResourceRefs(
  creds: PinkfishCreds,
  local: AgentResources | undefined,
  onWarn?: (line: string) => void,
  cloudCurrent?: {
    knowledgeBases?: WireResource[];
    datastores?: WireResource[];
    filestores?: WireResource[];
  },
): Promise<ResolvedResources> {
  if (
    !local ||
    (!local.knowledgeBases && !local.datastores && !local.filestores)
  ) {
    return {};
  }

  // First, build a name → wire-ref lookup from the agent's CURRENT
  // cloud resources (passed in from a fresh GET in `buildUpsertBody`).
  // These wire refs already carry valid `id` + `proxyEndpointId`, so
  // any disk ref that matches by name resolves without needing
  // `/api/proxy-endpoints`. This is what makes V2 work end-to-end:
  // the admin attaches resources via web ONCE; subsequent OpenIT
  // pushes round-trip the wire shape from the existing cloud agent.
  const cloudByKey = new Map<string, WireResource>();
  if (cloudCurrent) {
    for (const r of cloudCurrent.knowledgeBases ?? [])
      cloudByKey.set(`kb:${r.name}`, r);
    for (const r of cloudCurrent.datastores ?? [])
      cloudByKey.set(`ds:${r.name}`, r);
    for (const r of cloudCurrent.filestores ?? [])
      cloudByKey.set(`fs:${r.name}`, r);
  }

  // For NEW resources not yet on the cloud agent, fall back to the
  // /api/proxy-endpoints + /datacollection lookup. /api/proxy-endpoints
  // requires Cognito auth (browser-only — see platform routes.go
  // comment about RuntimeTokenFromContext). OpenIT's runtime token
  // 401s here. There's no /service/ equivalent today; tracked as a
  // platform-side V3 followup. When this fetch fails, refs not in
  // `cloudByKey` are dropped with a warning.
  let proxyByResource: Map<string, string> | null = null;
  try {
    proxyByResource = await fetchProxyEndpoints(creds);
  } catch (e) {
    if (cloudByKey.size === 0) {
      // No cloud-current resources to fall back on — can't resolve
      // anything at all.
      onWarn?.(
        `  ⚠ resources skipped — proxy endpoint lookup unavailable and no cloud-attached resources to copy from (${String(e).split("\n")[0]})`,
      );
      return {};
    }
    onWarn?.(
      `  ⚠ proxy lookup unavailable — only cloud-attached resources will resolve`,
    );
  }

  const [kbList, dsList, fsList] = await Promise.all([
    fetchCollectionsByType(creds, "knowledge_base"),
    fetchCollectionsByType(creds, "datastore"),
    fetchCollectionsByType(creds, "filestore"),
  ]);

  const resolveOne = (
    list: ResourceFetchResult,
    typeKey: "kb" | "ds" | "fs",
    typeLabel: string,
    ref: AgentResourceRef,
  ): WireResource | null => {
    const cloudName = cloudAgentName(ref.name);

    // Cloud-cached path: if this resource is already attached to the
    // agent on cloud, reuse its wire shape (id + proxyEndpointId).
    // Disk-side permission flags override the cloud's; everything
    // else (id/proxy/description/isStructured) carries through.
    const cached = cloudByKey.get(`${typeKey}:${cloudName}`);
    if (cached) {
      const wire: WireResource = {
        ...cached,
        canRead: ref.canRead ?? cached.canRead,
        canWrite: ref.canWrite ?? cached.canWrite,
        canDelete: ref.canDelete ?? cached.canDelete,
      };
      if (!wire.canRead && !wire.canWrite && !wire.canDelete) {
        onWarn?.(
          `  ⚠ skipping ${typeLabel} "${ref.name}" (no permission flags set)`,
        );
        return null;
      }
      return wire;
    }

    // Fallback path: /api/proxy-endpoints + /datacollection lookup.
    // Only reachable when proxyByResource is non-null (else we'd
    // have returned early above). For a brand-new resource not yet
    // attached to the cloud agent, this is the only way to land
    // valid `id` + `proxyEndpointId`.
    if (!proxyByResource) {
      onWarn?.(
        `  ⚠ skipping ${typeLabel} "${ref.name}" (not on cloud agent and proxy lookup unavailable — attach via web first, then sync)`,
      );
      return null;
    }
    const meta = list.byName.get(cloudName);
    if (!meta) {
      onWarn?.(`  ⚠ skipping ${typeLabel} "${ref.name}" (not found)`);
      return null;
    }
    const proxyId = proxyByResource.get(meta.id) ?? "";
    if (!proxyId) {
      onWarn?.(
        `  ⚠ skipping ${typeLabel} "${ref.name}" (no proxy endpoint registered)`,
      );
      return null;
    }
    const wire: WireResource = {
      id: meta.id,
      name: cloudName,
      canRead: ref.canRead ?? false,
      canWrite: ref.canWrite ?? false,
      canDelete: ref.canDelete ?? false,
      proxyEndpointId: proxyId,
    };
    if (meta.description !== undefined) wire.description = meta.description;
    if (meta.isStructured !== undefined) wire.isStructured = meta.isStructured;
    if (!wire.canRead && !wire.canWrite && !wire.canDelete) {
      onWarn?.(
        `  ⚠ skipping ${typeLabel} "${ref.name}" (no permission flags set)`,
      );
      return null;
    }
    return wire;
  };

  const out: ResolvedResources = {};
  if (local.knowledgeBases) {
    out.knowledgeBases = local.knowledgeBases
      .map((r) => resolveOne(kbList, "kb", "knowledge base", r))
      .filter((x): x is WireResource => x !== null);
  }
  if (local.datastores) {
    out.datastores = local.datastores
      .map((r) => resolveOne(dsList, "ds", "datastore", r))
      .filter((x): x is WireResource => x !== null);
  }
  if (local.filestores) {
    out.filestores = local.filestores
      .map((r) => resolveOne(fsList, "fs", "filestore", r))
      .filter((x): x is WireResource => x !== null);
  }
  return out;
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

/// Walk `<repo>/agents/triage/` once, return entries the engine's
/// listLocal contract expects. V2 only knows about the triage folder;
/// multi-agent support is V3+.
async function listLocalAgents(
  repo: string,
): Promise<{ filename: string; mtime_ms: number | null }[]> {
  return invoke<{ filename: string; mtime_ms: number | null; size: number }[]>(
    "entity_list_local",
    { repo, subdir: TRIAGE_SUBDIR },
  );
}

export function agentAdapter(args: {
  creds: PinkfishCreds;
  /// Pre-resolved agent list. When provided, listRemote uses this on its
  /// FIRST call instead of issuing a REST request — avoids the double
  /// REST hit on the first sync tick (the wrapper already fetches for
  /// logging). Subsequent listRemote calls (poll ticks) re-fetch via
  /// REST so steady-state stays current.
  initialAgents?: ProjectedAgent[];
}): EntityAdapter {
  const { creds } = args;
  let cachedFirst: ProjectedAgent[] | undefined = args.initialAgents;
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
        const localName = localAgentName(a.name);
        // V2 hard-codes the triage folder; non-triage `openit-*` agents
        // would need their own folder layout, which V3+ unlocks.
        if (localName !== TRIAGE_LOCAL_NAME) continue;
        const localRow: AgentRow = {
          id: a.id,
          name: localName,
          description: a.description,
          selectedModel: a.selectedModel,
          isShared: a.isShared,
          promptExamples: a.promptExamples,
          introMessage: a.introMessage,
          resources: a.resources,
          tools: a.tools,
        };
        const filename = safeFilename(localName);
        const content = canonicalizeForDisk(localRow);
        items.push({
          manifestKey: filename,
          workingTreePath: `${TRIAGE_SUBDIR}/${filename}`,
          updatedAt: a.updatedAt ?? "",
          fetchAndWrite: (repo) =>
            entityWriteFile(repo, TRIAGE_SUBDIR, filename, content),
          writeShadow: (repo) =>
            entityWriteFile(
              repo,
              TRIAGE_SUBDIR,
              shadowFilename(filename),
              content,
            ),
        });
      }
      return { items, paginationFailed: false };
    },

    async listLocal(repo) {
      const files = await listLocalAgents(repo);
      // The engine's manifest only tracks the structured `*.json` row;
      // `common.md` / `cloud.md` / `local.md` are owned by the user
      // (write-once on the bundled side, free-form afterwards) and
      // should not enter the diff/conflict pipeline. Filter to .json
      // only so they don't surface as "extra local files" the engine
      // would try to delete.
      const json = files.filter((f) => f.filename.endsWith(".json"));
      const siblings = new Set(json.map((f) => f.filename));
      const out: LocalItem[] = json.map((f) => {
        const shadow = classifyAsShadow(f.filename, siblings);
        return {
          manifestKey: shadow ? canonicalFromShadow(f.filename) : f.filename,
          workingTreePath: `${TRIAGE_SUBDIR}/${f.filename}`,
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
          await entityDeleteFile(repo, TRIAGE_SUBDIR, manifestKey);
          touched.push(`${TRIAGE_SUBDIR}/${manifestKey}`);
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
export {
  DIR as AGENT_DIR,
  PREFIX as AGENT_PREFIX,
  TRIAGE_SUBDIR,
  TRIAGE_LOCAL_NAME,
};
