import {
  kbDownloadToLocal,
  kbListRemote,
  kbUploadFile,
  type KbStatePersisted,
} from "./api";
import { type DataCollection } from "./skillsApi";
import { derivedUrls, getToken, type PinkfishCreds } from "./pinkfishAuth";
import { makeSkillsFetch } from "../api/fetchAdapter";
import { fsStoreStateLoad, fsStoreStateSave } from "./api";

// These will be added to api.ts — importing ahead of time.
// They invoke fs_store_init, fs_store_list_local, fs_store_state_load,
// fs_store_state_save Rust commands (mirrors of the kb_* equivalents but
// operating on the filestore/ local directory).
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

let createdCollections = new Map<string, FilestoreCollection>();

/**
 * Find or create openit-* Filestorage collections. Creates defaults if none
 * exist. Uses the skills REST API (GET /datacollection/all).
 */
let lastCreationAttemptTime = 0;
const CREATION_COOLDOWN_MS = 10_000; // 10 seconds — allow time for API eventual consistency

/**
 * Find or create openit-* Filestorage collections. Creates defaults if none
 * exist. Uses the skills REST API (GET /datacollection/?type=all).
 */
export async function resolveProjectFilestores(
  creds: PinkfishCreds,
): Promise<FilestoreCollection[]> {
  const token = getToken();
  if (!token) throw new Error("not authenticated");
  const urls = derivedUrls(creds.tokenUrl);

  const all = await listFilestoreCollections(creds);
  const defaults = getDefaultFilestores(creds.orgId);
  let matching = all
    .filter((c) => defaults.some((d) => d.name === c.name))
    .map((c) => ({ id: c.id, name: c.name, description: c.description }));

  // If list returned nothing, check our in-memory cache of recently created collections
  if (matching.length === 0 && createdCollections.size > 0) {
    console.log(`[filestore] using ${createdCollections.size} recently created collections`);
    matching = Array.from(createdCollections.values());
  }

  if (matching.length === 0) {
    const now = Date.now();
    // Skip creation if we tried recently (eventual consistency delay)
    if (now - lastCreationAttemptTime < CREATION_COOLDOWN_MS) {
      console.log("[filestore] skipping creation (cooldown active), using cached collections");
      return Array.from(createdCollections.values());
    }
    
    console.log("[filestore] no openit-* filestores found — creating defaults");
    lastCreationAttemptTime = now;
    for (const def of defaults) {
      // Check if we recently created this collection to avoid duplicates
      if (createdCollections.has(def.name)) {
        const col = createdCollections.get(def.name)!;
        matching.push(col);
        continue;
      }

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
          // 409 means collection already exists, skip it
          if (response.status === 409) {
            console.log(`[filestore] collection ${def.name} already exists`);
            continue;
          }
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const result = (await response.json()) as { id?: string | number } | null;
        if (result?.id) {
          const col = { id: String(result.id), name: def.name, description: def.description };
          matching.push(col);
          createdCollections.set(def.name, col);
          console.log(`[filestore] created ${def.name}`);
        }
      } catch (e) {
        console.warn(`[filestore] failed to create ${def.name}:`, e);
      }
    }
    
    // After creation, re-fetch to ensure we have the authoritative list
    if (matching.length > 0) {
      try {
        // Wait for API eventual consistency (collections take ~5 seconds to appear)
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        const updated = await listFilestoreCollections(creds);
        const updatedMatching = updated.filter((c) => defaults.some((d) => d.name === c.name));
        if (updatedMatching.length > matching.length) {
          console.log("[filestore] re-fetched collections after creation");
          return updatedMatching.map((c) => ({ id: c.id, name: c.name, description: c.description }));
        }
      } catch (e) {
        console.warn("[filestore] failed to re-fetch after creation:", e);
      }
    }
  }

  return matching;
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
    console.log("[filestore] Fetching from:", url.toString(), "base:", urls.skillsBaseUrl);
    const response = await fetchFn(url.toString());
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = (await response.json()) as DataCollection[] | null;
    const collections = Array.isArray(result) ? result : [];
    console.log(`[filestore] list_collections returned ${collections.length} filestorage collections`);
    collections.forEach((c) => console.log(`  - ${c.name} (id: ${c.id})`));
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

async function pullOnce(args: {
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
        await kbDownloadToLocal(repo, r.filename, r.downloadUrl);
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
          await kbDownloadToLocal(repo, r.filename, r.downloadUrl);
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
      await kbUploadFile({
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
