import {
  kbListRemote,
  type KbStatePersisted,
  fsStoreDownloadToLocal,
  fsStoreUploadFile,
} from "./api";
import { type DataCollection } from "./skillsApi";
import { derivedUrls, getToken, type PinkfishCreds } from "./pinkfishAuth";
import { makeSkillsFetch } from "../api/fetchAdapter";
import { fsStoreStateLoad, fsStoreStateSave } from "./api";
import {
  fsStoreInit,
  fsStoreListLocal,
} from "./api";

export type FilestoreCollection = { id: string; name: string; description?: string };

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

const PREFIX = "openit-";

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
let resolvedRepos = new Set<string>(); // Track which repos have had collections resolved

// Org-scoped cache to prevent collections from one org leaking into another
let createdCollections = new Map<string, Map<string, FilestoreCollection>>();
let lastCreationAttemptTime = new Map<string, number>();

// Per-org in-flight resolve promise — concurrent callers share the same operation
// so we never race two list-then-create sequences against each other.
const inflightResolve = new Map<string, Promise<FilestoreCollection[]>>();

/**
 * Get or create org-specific cache for created collections.
 */
function getOrgCache(orgId: string): Map<string, FilestoreCollection> {
  if (!createdCollections.has(orgId)) {
    createdCollections.set(orgId, new Map());
  }
  return createdCollections.get(orgId)!;
}

/**
 * Get the last creation attempt time for an org (default 0 if never attempted).
 */
function getLastCreationTime(orgId: string): number {
  return lastCreationAttemptTime.get(orgId) ?? 0;
}

/**
 * Update the last creation attempt time for an org.
 */
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

let pollTimer: ReturnType<typeof setInterval> | null = null;
const POLL_INTERVAL_MS = 300_000; // 5 minutes — reduce duplicate creation attempts

// ---------------------------------------------------------------------------
// Resolve helpers — REST API via skillsApi
// ---------------------------------------------------------------------------

/**
 * Find or create openit-* Filestorage collections. Creates defaults if none
 * exist. Uses the skills REST API (GET /datacollection/all).
 */
const CREATION_COOLDOWN_MS = 10_000; // 10 seconds — allow time for API eventual consistency

/**
 * Find or create openit-* Filestorage collections. Creates defaults if none
 * exist. Uses the skills REST API (GET /datacollection/?type=filestorage).
 */
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

/**
 * Pick one collection per default name. If the API returned multiple
 * collections with the same name (legacy duplicates), keep the lexicographically
 * smallest id so every caller in the same session converges on the same one.
 */
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

  // If list returned matching collections, we're done — never create.
  if (matching.length > 0) {
    for (const m of matching) {
      orgCache.set(m.name, m);
      onLog?.(`  ✓ ${m.name}  (id: ${m.id})`);
    }
    return matching;
  }

  // List is empty - check if we recently created collections
  // Only return cache if we attempted creation recently (within cooldown)
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
  // API says nothing matches and we're past the eventual-consistency window —
  // any cached entries are stale (e.g. user deleted the collection on the
  // remote between sessions). Wipe before creating so we actually POST.
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
        // 409 means the list was stale and the collection actually exists.
        // Mark conflict so we force a refetch to grab the authoritative id.
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

  // Refetch authoritatively whenever we touched the create path — handles
  // eventual consistency, 409 conflicts (list was stale), and concurrent
  // creators converging on a single deduped set.
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

/**
 * List filestore collections via REST API (GET works, POST doesn't).
 */
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
// Sync loop — mirrors kbSync.ts
// ---------------------------------------------------------------------------

/**
 * Resolve filestore collections for this org and begin polling for changes.
 * Idempotent — safe to call again on org change.
 */
export async function startFilestoreSync(args: {
  creds: PinkfishCreds;
  repo: string;
}): Promise<void> {
  const { creds, repo } = args;
  console.log("[filestoreSync] start", { repo });

  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
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

  // Mark this repo as resolved to prevent duplicate creation attempts
  resolvedRepos.add(repo);

  // Persist collection info in local state.
  const persisted = await fsStoreStateLoad(repo);
  if (collections.length > 0 && persisted.collection_id !== collections[0].id) {
    await fsStoreStateSave(repo, {
      ...persisted,
      collection_id: collections[0].id,
      collection_name: collections[0].name,
    });
  }

  // Initial pull for the first (primary) collection.
  if (collections.length > 0) {
    await pullOnce({ creds, repo, collection: collections[0] });
    pollTimer = setInterval(() => {
      pullOnce({ creds, repo, collection: collections[0] }).catch((e) =>
        console.error("filestore pull failed:", e),
      );
    }, POLL_INTERVAL_MS);
  } else {
    update({ phase: "ready" });
  }
}

export function stopFilestoreSync() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  update({
    phase: "idle",
    collections: [],
    conflicts: [],
    lastError: null,
  });
  resolvedRepos.clear();
}

export async function pullOnce(args: {
  creds: PinkfishCreds;
  repo: string;
  collection: FilestoreCollection;
}): Promise<void> {
  const { creds, repo, collection } = args;
  update({ phase: "pulling" });

  const token = getToken();
  if (!token) {
    update({ phase: "error", lastError: "not authenticated" });
    return;
  }
  const urls = derivedUrls(creds.tokenUrl);

  let remote: Array<{
    filename: string;
    updatedAt: string;
    downloadUrl?: string;
  }>;
  try {
    const rows = await kbListRemote({
      collectionId: collection.id,
      skillsBaseUrl: urls.skillsBaseUrl,
      accessToken: token.accessToken,
    });
    remote = rows.map((r) => ({
      filename: r.filename,
      updatedAt: r.updated_at,
      downloadUrl: r.signed_url ?? undefined,
    }));
  } catch (e) {
    update({ phase: "error", lastError: String(e) });
    return;
  }

  const local = await fsStoreListLocal(repo);
  const localMap = new Map(local.map((f) => [f.filename, f]));
  const persisted: KbStatePersisted = await fsStoreStateLoad(repo);
  const conflicts: ConflictFile[] = [];

  for (const r of remote) {
    if (!r.filename || !r.downloadUrl) continue;
    const localFile = localMap.get(r.filename);
    const tracked = persisted.files[r.filename];

    if (!tracked && !localFile) {
      // New remote file -> pull
      try {
        await fsStoreDownloadToLocal(repo, r.filename, r.downloadUrl);
        persisted.files[r.filename] = {
          remote_version: r.updatedAt,
          pulled_at_mtime_ms: Date.now(),
        };
      } catch (e) {
        console.error(`filestore pull ${r.filename} failed:`, e);
      }
      continue;
    }

    if (tracked && localFile) {
      const remoteChanged =
        r.updatedAt && r.updatedAt !== tracked.remote_version;
      const localChanged =
        localFile.mtime_ms != null &&
        localFile.mtime_ms > tracked.pulled_at_mtime_ms;

      if (remoteChanged && localChanged) {
        conflicts.push({
          filename: r.filename,
          reason: "local-and-remote-changed",
        });
        continue;
      }
      if (remoteChanged && !localChanged) {
        try {
          await fsStoreDownloadToLocal(repo, r.filename, r.downloadUrl);
          persisted.files[r.filename] = {
            remote_version: r.updatedAt,
            pulled_at_mtime_ms: Date.now(),
          };
        } catch (e) {
          console.error(`filestore pull ${r.filename} failed:`, e);
        }
      }
      continue;
    }
    // tracked but missing locally -> user deleted, leave alone
  }

  await fsStoreStateSave(repo, persisted);
  update({
    phase: "ready",
    conflicts,
    lastPullAt: Date.now(),
    lastError: null,
  });
}

/**
 * Push all local filestore files to the remote collection. Called by Deploy.
 */
export async function pushAllToFilestore(args: {
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
  const persisted = await fsStoreStateLoad(repo);

  const toPush = local.filter((f) => {
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

  // Reconcile remote_version after push, same pattern as kbSync.
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
