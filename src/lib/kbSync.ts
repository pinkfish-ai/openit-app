import {
  kbDownloadToLocal,
  kbInit,
  kbListLocal,
  kbStateLoad,
  kbStateSave,
  type KbStatePersisted,
} from "./api";
import { listFiles, resolveProjectKb, uploadFile, type KbCollection, type KbFile } from "./kb";
import type { PinkfishCreds } from "./pinkfishAuth";

export type ConflictFile = {
  filename: string;
  reason: "local-and-remote-changed";
};

export type SyncStatus = {
  phase: "idle" | "resolving" | "pulling" | "ready" | "pushing" | "error";
  collection: KbCollection | null;
  conflicts: ConflictFile[];
  lastError: string | null;
  lastPullAt: number | null;
};

let status: SyncStatus = {
  phase: "idle",
  collection: null,
  conflicts: [],
  lastError: null,
  lastPullAt: null,
};

const listeners = new Set<(s: SyncStatus) => void>();

export function subscribeSync(fn: (s: SyncStatus) => void): () => void {
  listeners.add(fn);
  fn(status);
  return () => listeners.delete(fn);
}

function update(patch: Partial<SyncStatus>) {
  status = { ...status, ...patch };
  for (const l of listeners) l(status);
}

let pollTimer: ReturnType<typeof setInterval> | null = null;

const POLL_INTERVAL_MS = 60_000;

/// Resolve (find or create) the OpenIT-managed KB for this org and run the
/// initial pull. Idempotent — safe to call again on org change.
export async function startKbSync(args: {
  creds: PinkfishCreds;
  repo: string;
  orgSlug: string;
  orgName: string;
}): Promise<void> {
  const { creds, repo, orgSlug, orgName } = args;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  update({ phase: "resolving", lastError: null });
  await kbInit(repo);
  let collection: KbCollection;
  try {
    collection = await resolveProjectKb(creds, orgSlug, orgName);
  } catch (e) {
    update({ phase: "error", lastError: String(e) });
    return;
  }
  update({ collection });

  // Persist the collection id alongside the file manifest.
  const persisted = await kbStateLoad(repo);
  if (persisted.collection_id !== collection.id) {
    await kbStateSave(repo, {
      ...persisted,
      collection_id: collection.id,
      collection_name: collection.name,
    });
  }

  await pullOnce({ creds, repo, collection });
  pollTimer = setInterval(() => {
    pullOnce({ creds, repo, collection }).catch((e) =>
      console.error("kb pull failed:", e),
    );
  }, POLL_INTERVAL_MS);
}

export function stopKbSync() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  update({ phase: "idle", collection: null, conflicts: [], lastError: null });
}

/// Run one pull pass: list remote files, reconcile against local manifest,
/// pull new/updated files, surface conflicts.
async function pullOnce(args: {
  creds: PinkfishCreds;
  repo: string;
  collection: KbCollection;
}): Promise<void> {
  const { creds, repo, collection } = args;
  update({ phase: "pulling" });

  let remote: KbFile[];
  try {
    remote = await listFiles(creds, collection.id);
  } catch (e) {
    update({ phase: "error", lastError: String(e) });
    return;
  }

  const local = await kbListLocal(repo);
  const localMap = new Map(local.map((f) => [f.filename, f]));
  const persisted: KbStatePersisted = await kbStateLoad(repo);
  const conflicts: ConflictFile[] = [];

  for (const r of remote) {
    if (!r.filename || !r.downloadUrl) continue;
    const localFile = localMap.get(r.filename);
    const tracked = persisted.files[r.filename];

    if (!tracked && !localFile) {
      // New remote file → pull
      try {
        await kbDownloadToLocal(repo, r.filename, r.downloadUrl);
        persisted.files[r.filename] = mkState(r, repo);
      } catch (e) {
        console.error(`pull ${r.filename} failed:`, e);
      }
      continue;
    }

    if (tracked && localFile) {
      const remoteChanged = r.updatedAt && r.updatedAt !== tracked.remote_version;
      const localChanged =
        localFile.mtime_ms != null && localFile.mtime_ms > tracked.pulled_at_mtime_ms;

      if (remoteChanged && localChanged) {
        conflicts.push({ filename: r.filename, reason: "local-and-remote-changed" });
        continue;
      }
      if (remoteChanged && !localChanged) {
        try {
          await kbDownloadToLocal(repo, r.filename, r.downloadUrl);
          persisted.files[r.filename] = mkState(r, repo);
        } catch (e) {
          console.error(`pull ${r.filename} failed:`, e);
        }
      }
      // remote unchanged: nothing to do
      continue;
    }
    // tracked but missing locally → user deleted, leave alone
  }

  await kbStateSave(repo, persisted);
  update({ phase: "ready", conflicts, lastPullAt: Date.now(), lastError: null });
}

function mkState(r: KbFile, _repo: string) {
  return {
    remote_version: r.updatedAt,
    pulled_at_mtime_ms: Date.now(),
  };
}

/// Push every local file to the KB. Updates manifest with the post-push
/// remote_version (which we approximate as "now" since the API doesn't
/// return one synchronously). Caller is the Deploy button.
export async function pushAllToKb(args: {
  creds: PinkfishCreds;
  repo: string;
  collection: KbCollection;
  onLine?: (msg: string) => void;
}): Promise<{ pushed: number; failed: number }> {
  const { creds, repo, collection, onLine } = args;
  update({ phase: "pushing" });

  const local = await kbListLocal(repo);
  const persisted = await kbStateLoad(repo);
  let pushed = 0;
  let failed = 0;

  for (const f of local) {
    try {
      // Read each file as text. Binary files would need base64 + a different
      // upload tool — out of scope for V1.
      const { kbReadFile } = await import("./api");
      const content = await kbReadFile(repo, f.filename);
      onLine?.(`▸ uploading ${f.filename}`);
      await uploadFile(creds, collection.id, f.filename, content);
      persisted.files[f.filename] = {
        remote_version: new Date().toISOString(),
        pulled_at_mtime_ms: f.mtime_ms ?? Date.now(),
      };
      pushed += 1;
    } catch (e) {
      failed += 1;
      onLine?.(`✗ ${f.filename}: ${String(e)}`);
    }
  }

  await kbStateSave(repo, persisted);
  update({ phase: "ready" });
  return { pushed, failed };
}
