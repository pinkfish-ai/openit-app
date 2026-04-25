import {
  kbDownloadToLocal,
  kbListRemote,
  kbUploadFile,
  type KbStatePersisted,
} from "./api";
import { createCollection, type DataCollection } from "./skillsApi";
import { derivedUrls, getToken, type PinkfishCreds } from "./pinkfishAuth";
import { pinkfishMcpCall } from "./api";

// These will be added to api.ts — importing ahead of time.
// They invoke fs_store_init, fs_store_list_local, fs_store_state_load,
// fs_store_state_save Rust commands (mirrors of the kb_* equivalents but
// operating on the filestore/ local directory).
import {
  fsStoreInit,
  fsStoreListLocal,
  fsStoreStateLoad,
  fsStoreStateSave,
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

const DEFAULT_FILESTORES = [
  {
    name: "openit-docs",
    description: "Shared document storage for OpenIT",
  },
];

let status: FilestoreSyncStatus = {
  phase: "idle",
  collections: [],
  conflicts: [],
  lastError: null,
  lastPullAt: null,
};

const listeners = new Set<(s: FilestoreSyncStatus) => void>();

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
const POLL_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// Resolve helpers — REST API via skillsApi
// ---------------------------------------------------------------------------

/**
 * Find or create openit-* Filestorage collections. Creates defaults if none
 * exist. Uses the skills REST API (GET /datacollection/?type=filestorage).
 */
export async function resolveProjectFilestores(
  creds: PinkfishCreds,
): Promise<FilestoreCollection[]> {
  const token = getToken();
  if (!token) throw new Error("not authenticated");

  const all = await listFilestoreCollections(creds);
  let matching = all
    .filter((c) => c.name.startsWith(PREFIX))
    .map((c) => ({ id: c.id, name: c.name, description: c.description }));

  if (matching.length === 0) {
    console.log("[filestore] no openit-* filestores found — attempting to create defaults");
    const urls = derivedUrls(creds.tokenUrl);
    for (const def of DEFAULT_FILESTORES) {
      try {
        const created = await createCollection(urls.skillsBaseUrl, token.accessToken, {
          name: def.name,
          type: "filestorage",
          description: def.description,
          createdBy: creds.orgId,
          createdByName: "OpenIT",
        });
        matching.push({ id: created.id, name: created.name, description: created.description });
      } catch (e) {
        console.warn(`[filestore] failed to create ${def.name}:`, e);
      }
    }
    // If creation failed, try to find existing collections by name
    if (matching.length === 0) {
      const all = await listFilestoreCollections(creds);
      matching = all
        .filter((c) => DEFAULT_FILESTORES.some((d) => d.name === c.name))
        .map((c) => ({ id: c.id, name: c.name, description: c.description }));
    }
  }

  return matching;
}

/**
 * List filestore collections via MCP (same pattern as KB).
 */
async function listFilestoreCollections(creds: PinkfishCreds): Promise<DataCollection[]> {
  const token = getToken();
  if (!token) throw new Error("not authenticated");
  const urls = derivedUrls(creds.tokenUrl);

  try {
    const result = (await pinkfishMcpCall({
      accessToken: token.accessToken,
      orgId: creds.orgId,
      server: "knowledge-base",
      tool: "knowledge-base_list_collections",
      arguments: {},
      baseUrl: urls.mcpBaseUrl,
    })) as { collections?: DataCollection[] } | null;

    return result?.collections ?? [];
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
