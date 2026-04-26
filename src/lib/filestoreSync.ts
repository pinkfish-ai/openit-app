// Filestore sync wrapper. Pull pipeline + auto-commit + conflict shadow live
// in `syncEngine.ts` driven by `filestoreAdapter`. This file owns:
//   - The status object the FileExplorer subscribes to.
//   - Filestore-specific resolve (find or create the openit-* collection,
//     with 409-conflict + eventual-consistency handling — REST surface
//     hasn't moved).
//   - The push path (filestore upload semantics differ from the engine's
//     diff model; engine still gives us the lock + auto-commit helper).
//
// Behavior changes vs the pre-engine version (R1 refactor):
//   - Poll interval drops from 5 min to 60 s, matching every other entity.
//   - Conflict shadows now drop on both-changed, mirroring KB.
//   - Server-side deletion now drops the manifest entry (didn't before).
// All three are improvements per the plan; flagged here for review.

import { kbListRemote, type KbStatePersisted, fsStoreUploadFile } from "./api";
import { type DataCollection } from "./skillsApi";
import { derivedUrls, getToken, type PinkfishCreds } from "./pinkfishAuth";
import { makeSkillsFetch } from "../api/fetchAdapter";
import { fsStoreStateLoad, fsStoreStateSave } from "./api";
import { fsStoreInit, fsStoreListLocal } from "./api";
import { filestoreAdapter, type FilestoreCollection } from "./entities/filestore";
import {
  classifyAsShadow,
  clearConflictsForPrefix,
  pullEntity,
  startPolling,
  withRepoLock,
} from "./syncEngine";

export type { FilestoreCollection };

export type ConflictFile = {
  filename: string;
  reason: "local-and-remote-changed";
};

export type FilestoreSyncStatus = {
  phase: "idle" | "resolving" | "pulling" | "ready" | "pushing" | "error";
  collections: FilestoreCollection[];
  conflicts: ConflictFile[];
  lastError: string | null;
  lastPullAt: number | null;
};

function getDefaultFilestores(orgId: string) {
  return [
    {
      name: `openit-docs-${orgId}`,
      description: "Shared document storage for OpenIT",
    },
  ];
}

let status: FilestoreSyncStatus = {
  phase: "idle",
  collections: [],
  conflicts: [],
  lastError: null,
  lastPullAt: null,
};

const listeners = new Set<(s: FilestoreSyncStatus) => void>();
let resolvedRepos = new Set<string>();

// Org-scoped cache to prevent collections from one org leaking into another.
let createdCollections = new Map<string, Map<string, FilestoreCollection>>();
let lastCreationAttemptTime = new Map<string, number>();

// Per-org in-flight resolve promise — concurrent callers share the same
// operation so we never race two list-then-create sequences.
const inflightResolve = new Map<string, Promise<FilestoreCollection[]>>();

function getOrgCache(orgId: string): Map<string, FilestoreCollection> {
  if (!createdCollections.has(orgId)) {
    createdCollections.set(orgId, new Map());
  }
  return createdCollections.get(orgId)!;
}

function getLastCreationTime(orgId: string): number {
  return lastCreationAttemptTime.get(orgId) ?? 0;
}

function setLastCreationTime(orgId: string, time: number): void {
  lastCreationAttemptTime.set(orgId, time);
}

export function subscribeFilestoreSync(
  fn: (s: FilestoreSyncStatus) => void,
): () => void {
  listeners.add(fn);
  fn(status);
  return () => listeners.delete(fn);
}

export function getFilestoreSyncStatus(): FilestoreSyncStatus {
  return status;
}

function update(patch: Partial<FilestoreSyncStatus>) {
  status = { ...status, ...patch };
  for (const l of listeners) l(status);
}

let stopPoll: (() => void) | null = null;

// ---------------------------------------------------------------------------
// Resolve helpers — REST API via skillsApi. Unchanged from pre-engine; the
// resolve flow is filestore-specific and doesn't fit the engine.
// ---------------------------------------------------------------------------

const CREATION_COOLDOWN_MS = 10_000;

export async function resolveProjectFilestores(
  creds: PinkfishCreds,
  onLog?: (msg: string) => void,
): Promise<FilestoreCollection[]> {
  const existing = inflightResolve.get(creds.orgId);
  if (existing) {
    console.log("[filestore] joining in-flight resolve for org:", creds.orgId);
    return existing;
  }
  const promise = resolveProjectFilestoresImpl(creds, onLog);
  inflightResolve.set(creds.orgId, promise);
  try {
    return await promise;
  } finally {
    inflightResolve.delete(creds.orgId);
  }
}

/// Pick one collection per default name. If the API returned multiple
/// collections with the same name (legacy duplicates), keep the
/// lexicographically smallest id so every caller in the same session
/// converges on the same one.
function dedupeByName(
  all: DataCollection[],
  defaults: ReturnType<typeof getDefaultFilestores>,
): FilestoreCollection[] {
  const byName = new Map<string, FilestoreCollection>();
  for (const c of all) {
    if (!defaults.some((d) => d.name === c.name)) continue;
    const existing = byName.get(c.name);
    if (!existing || String(c.id) < existing.id) {
      byName.set(c.name, { id: String(c.id), name: c.name, description: c.description });
    }
  }
  return Array.from(byName.values());
}

async function resolveProjectFilestoresImpl(
  creds: PinkfishCreds,
  onLog?: (msg: string) => void,
): Promise<FilestoreCollection[]> {
  console.log("[filestore] resolveProjectFilestores called for org:", creds.orgId);
  const token = getToken();
  if (!token) throw new Error("not authenticated");
  const urls = derivedUrls(creds.tokenUrl);

  const all = await listFilestoreCollections(creds);
  const defaults = getDefaultFilestores(creds.orgId);
  const matching = dedupeByName(all, defaults);

  const rawMatchCount = all.filter((c) => defaults.some((d) => d.name === c.name)).length;
  console.log(
    `[filestore] ✓ Found ${all.length} filestore collections, ${rawMatchCount} matching defaults` +
      (rawMatchCount > matching.length ? ` (deduped to ${matching.length})` : ""),
  );
  if (rawMatchCount > matching.length) {
    console.warn(
      `[filestore] WARNING: ${rawMatchCount - matching.length} duplicate default filestore(s) detected on remote. Using id ${matching.map((m) => m.id).join(", ")}.`,
    );
  }

  const orgCache = getOrgCache(creds.orgId);

  if (matching.length > 0) {
    for (const m of matching) {
      orgCache.set(m.name, m);
      onLog?.(`  ✓ ${m.name}  (id: ${m.id})`);
    }
    return matching;
  }

  const now = Date.now();
  const lastCreationTime = getLastCreationTime(creds.orgId);
  if (orgCache.size > 0 && now - lastCreationTime < CREATION_COOLDOWN_MS) {
    console.log("[filestore] collections not yet visible in API list, returning cached collections");
    return Array.from(orgCache.values());
  }
  if (now - lastCreationTime < CREATION_COOLDOWN_MS) {
    console.log("[filestore] skipping creation (cooldown active)");
    return Array.from(orgCache.values());
  }

  console.log("[filestore] no openit-* filestores found — creating defaults");
  // Past the eventual-consistency window — any cached entries are stale.
  // Wipe before creating so we actually POST.
  orgCache.clear();
  setLastCreationTime(creds.orgId, now);
  const created: FilestoreCollection[] = [];
  let conflictHit = false;
  for (const def of defaults) {
    try {
      const fetchFn = makeSkillsFetch(token.accessToken);
      const url = new URL("/datacollection/", urls.skillsBaseUrl);
      const response = await fetchFn(url.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: def.name,
          type: "filestorage",
          description: def.description,
          createdBy: creds.orgId,
          createdByName: "OpenIT",
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error("[filestore] response error:", errText);
        if (response.status === 409) {
          console.log(`[filestore] collection ${def.name} already exists (409) — will refetch`);
          conflictHit = true;
          continue;
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = (await response.json()) as { id?: string | number } | null;
      if (result?.id) {
        const col = { id: String(result.id), name: def.name, description: def.description };
        created.push(col);
        orgCache.set(def.name, col);
        console.log(`[filestore] created ${def.name} with id: ${result.id}`);
        onLog?.(`  + ${def.name}  (id: ${result.id})  [created]`);
      } else {
        console.warn(`[filestore] no id found in response for ${def.name}. Response keys:`, Object.keys(result || {}));
      }
    } catch (e) {
      console.warn(`[filestore] failed to create ${def.name}:`, e);
    }
  }

  if (created.length > 0 || conflictHit) {
    try {
      await new Promise((r) => setTimeout(r, 3000));
      const refetched = await listFilestoreCollections(creds);
      const verified = dedupeByName(refetched, defaults);
      if (verified.length > 0) {
        for (const m of verified) orgCache.set(m.name, m);
        return verified;
      }
      if (conflictHit && created.length === 0) {
        console.warn("[filestore] 409 conflict but refetch still returned no matches — API may be lagging");
      }
    } catch (e) {
      console.warn("[filestore] post-create refetch failed:", e);
    }
  }

  return created;
}

async function listFilestoreCollections(creds: PinkfishCreds): Promise<DataCollection[]> {
  const token = getToken();
  if (!token) throw new Error("not authenticated");
  const urls = derivedUrls(creds.tokenUrl);

  try {
    const fetchFn = makeSkillsFetch(token.accessToken);
    const url = new URL("/datacollection/", urls.skillsBaseUrl);
    url.searchParams.set("type", "filestorage");
    console.log("[filestore] Fetching from:", url.toString());
    const response = await fetchFn(url.toString());

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    let result: DataCollection[] | null;
    try {
      result = (await response.json()) as DataCollection[] | null;
    } catch (e) {
      console.error("[filestore] failed to parse list response JSON:", e);
      throw new Error(`Failed to parse collection list: ${e}`);
    }

    const collections = Array.isArray(result) ? result : [];
    console.log(`[filestore] list_collections returned ${collections.length} filestorage collections`);
    collections.forEach((c) => console.log(`  • ${c.name} (id: ${c.id})`));
    return collections;
  } catch (error) {
    console.error("[filestore] Failed to list collections:", error);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Sync loop — engine-driven.
// ---------------------------------------------------------------------------

async function runPull(args: {
  repo: string;
  adapter: ReturnType<typeof filestoreAdapter>;
}): Promise<{ downloaded: number; total: number }> {
  // All status updates fire inside the engine's per-repo lock — see the
  // matching comment in kbSync.runPull for rationale.
  const result = await pullEntity(args.adapter, args.repo, {
    onPhase: (phase) => {
      if (phase === "pulling") update({ phase: "pulling" });
    },
    onResult: (r) => {
      const conflicts: ConflictFile[] = r.conflicts.map((c) => ({
        filename: c.manifestKey,
        reason: "local-and-remote-changed",
      }));
      update({
        phase: "ready",
        conflicts,
        lastPullAt: Date.now(),
        lastError: null,
      });
    },
    onError: (e) => {
      update({ phase: "error", lastError: String(e) });
    },
  });
  return { downloaded: result.pulled, total: result.remoteCount };
}

/// Resolve filestore collections for this org and begin polling for changes.
/// Idempotent — safe to call again on org change.
export async function startFilestoreSync(args: {
  creds: PinkfishCreds;
  repo: string;
}): Promise<void> {
  const { creds, repo } = args;
  console.log("[filestoreSync] start", { repo });

  if (stopPoll) {
    stopPoll();
    stopPoll = null;
  }

  update({ phase: "resolving", lastError: null });

  try {
    await fsStoreInit(repo);
  } catch (e) {
    console.error("[filestoreSync] fsStoreInit failed:", e);
    update({ phase: "error", lastError: String(e) });
    return;
  }

  let collections: FilestoreCollection[];
  try {
    collections = await resolveProjectFilestores(creds);
    console.log("[filestoreSync] resolved collections", collections);
  } catch (e) {
    console.error("[filestoreSync] resolveProjectFilestores failed:", e);
    update({ phase: "error", lastError: String(e) });
    return;
  }
  update({ collections });

  resolvedRepos.add(repo);

  const persisted = await fsStoreStateLoad(repo);
  if (collections.length > 0 && persisted.collection_id !== collections[0].id) {
    await fsStoreStateSave(repo, {
      ...persisted,
      collection_id: collections[0].id,
      collection_name: collections[0].name,
    });
  }

  if (collections.length > 0) {
    const collection = collections[0];
    // Build the adapter once and share for initial pull + 60s poll —
    // saves the redundant construction and makes it obvious both paths
    // run on the same configuration.
    const adapter = filestoreAdapter({ creds, collection });
    // Catch initial-pull failures so we still start the poller. runPull
    // already updates status on failure; without this catch a transient
    // network blip on connect would leave the user without auto-recovery.
    try {
      await runPull({ repo, adapter });
    } catch (e) {
      console.error("[filestoreSync] initial pull failed (poll will still start):", e);
    }
    stopPoll = startPolling(adapter, repo, {
      onPhase: (phase) => {
        if (phase === "pulling") update({ phase: "pulling" });
      },
      onResult: (r) => {
        const conflicts: ConflictFile[] = r.conflicts.map((c) => ({
          filename: c.manifestKey,
          reason: "local-and-remote-changed",
        }));
        update({
          phase: "ready",
          conflicts,
          lastPullAt: Date.now(),
          lastError: null,
        });
      },
      onError: (e) => {
        // Same reason as KB: onPhase("pulling") fired before the failure,
        // so we have to surface the error here or the UI stays stuck.
        console.error("filestore pull failed:", e);
        update({ phase: "error", lastError: String(e) });
      },
    });
  } else {
    update({ phase: "ready" });
  }
}

export function stopFilestoreSync() {
  if (stopPoll) {
    stopPoll();
    stopPoll = null;
  }
  update({
    phase: "idle",
    collections: [],
    conflicts: [],
    lastError: null,
  });
  resolvedRepos.clear();
  clearConflictsForPrefix("filestore");
}

/// Manual single-shot pull. Used by Shell.tsx's ↻ button and the modal
/// connect flow. Goes through the engine's per-repo lock.
///
/// Always resolves — never rejects — to match the pre-engine contract.
/// Failures are conveyed via getFilestoreSyncStatus() (phase becomes
/// "error"); callers gating on outcome should read that, not catch.
export async function pullOnce(args: {
  creds: PinkfishCreds;
  repo: string;
  collection: FilestoreCollection;
}): Promise<{ downloaded: number; total: number }> {
  const adapter = filestoreAdapter({ creds: args.creds, collection: args.collection });
  try {
    return await runPull({ repo: args.repo, adapter });
  } catch (e) {
    console.error("[filestoreSync] pullOnce failed:", e);
    return { downloaded: 0, total: 0 };
  }
}

/// Push all local filestore files to the remote collection. Called by the
/// Sync tab's commit handler. Serializes against pull on the engine lock.
export async function pushAllToFilestore(args: {
  creds: PinkfishCreds;
  repo: string;
  collection: FilestoreCollection;
  onLine?: (msg: string) => void;
}): Promise<{ pushed: number; failed: number }> {
  return withRepoLock(args.repo, "filestore", () =>
    pushAllToFilestoreInner(args),
  );
}

async function pushAllToFilestoreInner(args: {
  creds: PinkfishCreds;
  repo: string;
  collection: FilestoreCollection;
  onLine?: (msg: string) => void;
}): Promise<{ pushed: number; failed: number }> {
  const { creds, repo, collection, onLine } = args;
  update({ phase: "pushing" });

  const token = getToken();
  if (!token) {
    onLine?.("x filestore push: not authenticated");
    update({ phase: "ready" });
    return { pushed: 0, failed: 0 };
  }
  const urls = derivedUrls(creds.tokenUrl);

  const local = await fsStoreListLocal(repo);
  const persisted: KbStatePersisted = await fsStoreStateLoad(repo);

  // Sibling-aware shadow exclusion. Pass the full filename set; see
  // classifyAsShadow doc for why pre-filtering is wrong.
  const siblings = new Set(local.map((f) => f.filename));
  const toPush = local.filter((f) => {
    if (classifyAsShadow(f.filename, siblings)) return false;
    const tracked = persisted.files[f.filename];
    if (!tracked) return true;
    if (f.mtime_ms == null) return true;
    return f.mtime_ms > tracked.pulled_at_mtime_ms;
  });

  if (toPush.length === 0) {
    onLine?.("filestore push: nothing new to upload");
    update({ phase: "ready" });
    return { pushed: 0, failed: 0 };
  }

  let pushed = 0;
  let failed = 0;
  const pushedNames = new Set<string>();

  for (const f of toPush) {
    try {
      onLine?.(`uploading ${f.filename}`);
      await fsStoreUploadFile({
        repo,
        filename: f.filename,
        collectionId: collection.id,
        skillsBaseUrl: urls.skillsBaseUrl,
        accessToken: token.accessToken,
      });
      persisted.files[f.filename] = {
        remote_version: new Date().toISOString(),
        pulled_at_mtime_ms: f.mtime_ms ?? Date.now(),
      };
      pushedNames.add(f.filename);
      pushed += 1;
    } catch (e) {
      failed += 1;
      onLine?.(`x ${f.filename}: ${String(e)}`);
    }
  }

  // Reconcile remote_version after push, same pattern as KB.
  if (pushedNames.size > 0) {
    try {
      const remote = await kbListRemote({
        collectionId: collection.id,
        skillsBaseUrl: urls.skillsBaseUrl,
        accessToken: token.accessToken,
      });
      for (const r of remote) {
        if (pushedNames.has(r.filename) && r.updated_at) {
          const tracked = persisted.files[r.filename];
          if (tracked) tracked.remote_version = r.updated_at;
        }
      }
    } catch (e) {
      console.warn("filestore post-push remote-version sync failed:", e);
    }
  }

  await fsStoreStateSave(repo, persisted);
  update({ phase: "ready" });
  return { pushed, failed };
}
