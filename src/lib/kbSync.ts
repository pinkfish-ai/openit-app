import {
  kbDownloadToLocal,
  kbInit,
  kbListLocal,
  kbListRemote,
  kbStateLoad,
  kbStateSave,
  kbUploadFile,
  type KbStatePersisted,
} from "./api";
import { resolveProjectKb, type KbCollection } from "./kb";
import { derivedUrls, getToken, type PinkfishCreds } from "./pinkfishAuth";

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

export function getSyncStatus(): SyncStatus {
  return status;
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
  console.log("[kbsync] start", { repo, orgSlug, orgName });
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  update({ phase: "resolving", lastError: null });
  try {
    const dir = await kbInit(repo);
    console.log("[kbsync] kbInit ok →", dir);
  } catch (e) {
    console.error("[kbsync] kbInit failed:", e);
    update({ phase: "error", lastError: String(e) });
    return;
  }
  let collection: KbCollection;
  try {
    collection = await resolveProjectKb(creds, orgSlug, orgName);
    console.log("[kbsync] resolved collection", collection);
  } catch (e) {
    console.error("[kbsync] resolveProjectKb failed:", e);
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

/// Run a single pull (e.g. immediately before a push). Public wrapper.
export async function pullNow(args: {
  creds: PinkfishCreds;
  repo: string;
  collection: KbCollection;
}): Promise<void> {
  return pullOnce(args);
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

  const token = getToken();
  if (!token) {
    update({ phase: "error", lastError: "not authenticated" });
    return;
  }
  const urls = derivedUrls(creds.tokenUrl);

  let remote: Array<{ filename: string; updatedAt: string; downloadUrl?: string }>;
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

function mkState(r: { updatedAt: string }, _repo: string) {
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

  const token = getToken();
  if (!token) {
    onLine?.("✗ kb push: not authenticated");
    update({ phase: "ready" });
    return { pushed: 0, failed: 0 };
  }
  const urls = derivedUrls(creds.tokenUrl);

  const local = await kbListLocal(repo);
  const persisted = await kbStateLoad(repo);

  // Only push files that are new (not in manifest) or changed (local mtime
  // is newer than the last sync). Untouched files are skipped.
  const toPush = local.filter((f) => {
    const tracked = persisted.files[f.filename];
    if (!tracked) return true;
    if (f.mtime_ms == null) return true;
    return f.mtime_ms > tracked.pulled_at_mtime_ms;
  });

  if (toPush.length === 0) {
    onLine?.("▸ kb push: nothing new to upload");
    update({ phase: "ready" });
    return { pushed: 0, failed: 0 };
  }

  let pushed = 0;
  let failed = 0;
  const pushedNames = new Set<string>();

  for (const f of toPush) {
    try {
      onLine?.(`▸ uploading ${f.filename}`);
      await kbUploadFile({
        repo,
        filename: f.filename,
        collectionId: collection.id,
        skillsBaseUrl: urls.skillsBaseUrl,
        accessToken: token.accessToken,
      });
      // Provisionally mark with current local mtime; we'll align remote_version
      // with the server's authoritative updatedAt below.
      persisted.files[f.filename] = {
        remote_version: new Date().toISOString(),
        pulled_at_mtime_ms: f.mtime_ms ?? Date.now(),
      };
      pushedNames.add(f.filename);
      pushed += 1;
    } catch (e) {
      failed += 1;
      onLine?.(`✗ ${f.filename}: ${String(e)}`);
    }
  }

  // After pushing, fetch the server's authoritative updatedAt for each file
  // we just uploaded and store that as remote_version. Without this, the very
  // next pull thinks "remote_version != server.updatedAt" and false-flags a
  // conflict.
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
      console.warn("kb post-push remote-version sync failed:", e);
    }
  }

  await kbStateSave(repo, persisted);
  update({ phase: "ready" });
  return { pushed, failed };
}
