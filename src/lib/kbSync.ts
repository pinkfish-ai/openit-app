import {
  gitCommitPaths,
  gitEnsureRepo,
  gitStatusShort,
  kbDeleteFile,
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
let activeSyncArgs: { creds: PinkfishCreds; repo: string; collection: KbCollection } | null = null;

const POLL_INTERVAL_MS = 60_000;

/// Single in-flight serializer for pull / push so the 60s poller and a
/// user-triggered Push can't race and corrupt the manifest. All KB-mutating
/// work runs through this.
let syncQueue: Promise<unknown> = Promise.resolve();
function withSyncLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = syncQueue.catch(() => undefined).then(fn);
  syncQueue = next.catch(() => undefined);
  return next;
}

/// Server-side copy filename for merge conflicts, e.g. `runbook.md` → `runbook.server.md`.
export function kbServerShadowFilename(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0 || dot === filename.length - 1) return `${filename}.server`;
  return `${filename.slice(0, dot)}.server.${filename.slice(dot + 1)}`;
}

export function kbHasServerShadowFiles(repo: string): Promise<boolean> {
  return kbListLocal(repo).then((files) =>
    files.some((f) => f.filename.includes(".server.")),
  );
}

/// Reconstruct canonical filename from a shadow like `runbook.server.md` → `runbook.md`.
export function kbBaseFromShadowFilename(shadow: string): string {
  const marker = ".server.";
  const i = shadow.indexOf(marker);
  if (i < 0) return shadow;
  return `${shadow.slice(0, i)}.${shadow.slice(i + marker.length)}`;
}

/// Prompt text for Claude Code to resolve KB merge conflicts (pairs yours vs server shadow).
export async function buildKbConflictPrompt(repo: string): Promise<string> {
  const sync = getSyncStatus();
  const local = await kbListLocal(repo);
  const shadowNames = local.map((f) => f.filename).filter((n) => n.includes(".server."));
  const lines: string[] = [];
  for (const c of sync.conflicts) {
    const sh = kbServerShadowFilename(c.filename);
    lines.push(`- knowledge-base/${c.filename} (yours) vs knowledge-base/${sh} (server)`);
  }
  for (const sh of shadowNames) {
    if (sync.conflicts.some((c) => kbServerShadowFilename(c.filename) === sh)) continue;
    const base = kbBaseFromShadowFilename(sh);
    lines.push(`- knowledge-base/${base} (yours) vs knowledge-base/${sh} (server)`);
  }
  if (lines.length === 0) return "";
  return `There are merge conflicts in the knowledge base. For each pair below, read both files, merge them intelligently into the main file (the one without ".server." in the name), then delete the .server. shadow file(s).

${lines.join("\n")}

For binary files (e.g. PDF), pick the correct version or replace manually, then delete the shadow file.`;
}

/// Resolve (find or create) the OpenIT-managed KB for this org and run the
/// initial pull. Idempotent — safe to call again on org change.
export async function startKbSync(args: {
  creds: PinkfishCreds;
  repo: string;
  orgSlug: string;
  orgName: string;
  onLog?: (msg: string) => void;
}): Promise<{ pulled: number; total: number } | null> {
  const { creds, repo, orgSlug, orgName, onLog } = args;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  update({ phase: "resolving", lastError: null });
  try {
    await gitEnsureRepo(repo);
  } catch (e) {
    console.error("kb sync: gitEnsureRepo failed:", e);
    update({ phase: "error", lastError: String(e) });
    return null;
  }
  try {
    await kbInit(repo);
  } catch (e) {
    console.error("kb sync: kbInit failed:", e);
    update({ phase: "error", lastError: String(e) });
    return null;
  }
  let collection: KbCollection;
  try {
    collection = await resolveProjectKb(creds, orgSlug, orgName, onLog);
  } catch (e) {
    console.error("kb sync: resolveProjectKb failed:", e);
    update({ phase: "error", lastError: String(e) });
    return null;
  }
  update({ collection });
  activeSyncArgs = { creds, repo, collection };

  // Persist the collection id alongside the file manifest.
  const persisted = await kbStateLoad(repo);
  if (persisted.collection_id !== collection.id) {
    await kbStateSave(repo, {
      ...persisted,
      collection_id: collection.id,
      collection_name: collection.name,
    });
  }

  const result = await withSyncLock(() => pullOnce({ creds, repo, collection }));
  pollTimer = setInterval(() => {
    withSyncLock(() => pullOnce({ creds, repo, collection })).catch((e) =>
      console.error("kb pull failed:", e),
    );
  }, POLL_INTERVAL_MS);
  return result;
}

export function stopKbSync() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  activeSyncArgs = null;
  update({ phase: "idle", collection: null, conflicts: [], lastError: null });
}

/// Run a single pull (e.g. immediately before a push). Public wrapper.
/// Goes through the in-flight lock so it can't race the background poller.
export async function pullNow(args: {
  creds: PinkfishCreds;
  repo: string;
  collection: KbCollection;
}): Promise<void> {
  await withSyncLock(() => pullOnce(args));
}

/// Trigger a pull using the active sync credentials. Designed for the UI
/// refresh button — no args needed; returns false if sync isn't active.
export async function refreshFromServer(): Promise<boolean> {
  if (!activeSyncArgs) return false;
  await withSyncLock(() => pullOnce(activeSyncArgs!));
  return true;
}

/// Run one pull pass: list remote files, reconcile against local manifest,
/// pull new/updated files, surface conflicts.
async function pullOnce(args: {
  creds: PinkfishCreds;
  repo: string;
  collection: KbCollection;
}): Promise<{ pulled: number; total: number }> {
  const { creds, repo, collection } = args;
  update({ phase: "pulling" });

  const token = getToken();
  if (!token) {
    update({ phase: "error", lastError: "not authenticated" });
    return { pulled: 0, total: 0 };
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
    return { pulled: 0, total: 0 };
  }

  const local = await kbListLocal(repo);
  const localMap = new Map(local.map((f) => [f.filename, f]));
  const persisted: KbStatePersisted = await kbStateLoad(repo);
  const conflicts: ConflictFile[] = [];
  let pulled = 0;

  // Repo-relative paths the pull touched (downloaded, replaced, deleted).
  // Used to scope the auto-commit so we never sweep up unrelated user WIP.
  const touched = new Set<string>();
  const kbPath = (filename: string) => `knowledge-base/${filename}`;

  for (const r of remote) {
    if (!r.filename || !r.downloadUrl) continue;
    const localFile = localMap.get(r.filename);
    const tracked = persisted.files[r.filename];

    if (!tracked && !localFile) {
      try {
        await kbDownloadToLocal(repo, r.filename, r.downloadUrl);
        persisted.files[r.filename] = mkState(r);
        touched.add(kbPath(r.filename));
        pulled += 1;
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
        const shadowName = kbServerShadowFilename(r.filename);
        const hasShadow = local.some((f) => f.filename === shadowName);
        if (!hasShadow && r.downloadUrl) {
          try {
            await kbDownloadToLocal(repo, shadowName, r.downloadUrl);
            touched.add(kbPath(shadowName));
          } catch (e) {
            console.error(`pull conflict shadow ${shadowName} failed:`, e);
          }
        }
        conflicts.push({ filename: r.filename, reason: "local-and-remote-changed" });
        continue;
      }
      if (remoteChanged && !localChanged) {
        try {
          await kbDownloadToLocal(repo, r.filename, r.downloadUrl);
          persisted.files[r.filename] = mkState(r);
          touched.add(kbPath(r.filename));
          pulled += 1;
        } catch (e) {
          console.error(`pull ${r.filename} failed:`, e);
        }
      }
      // remote unchanged: nothing to do
      continue;
    }
    // tracked but missing locally → user deleted locally, leave alone
  }

  // Detect server-side deletions: files the manifest says we synced from the
  // server but that are no longer in the remote list → server deleted them.
  // We deliberately do NOT delete files that aren't in the manifest — those
  // are local-only files (e.g. just added, just committed, never pushed).
  const remoteNames = new Set(remote.map((r) => r.filename));
  for (const filename of Object.keys(persisted.files)) {
    if (filename.includes(".server.")) continue;
    if (remoteNames.has(filename)) continue;
    const localFile = localMap.get(filename);
    if (!localFile) {
      delete persisted.files[filename];
      continue;
    }
    try {
      await kbDeleteFile(repo, filename);
      delete persisted.files[filename];
      touched.add(kbPath(filename));
    } catch (e) {
      console.error(`failed to delete local ${filename}:`, e);
    }
  }

  await kbStateSave(repo, persisted);
  update({ phase: "ready", conflicts, lastPullAt: Date.now(), lastError: null });

  if (touched.size > 0) {
    try {
      const ts = new Date().toISOString();
      await gitCommitPaths(repo, Array.from(touched), `sync: pull @ ${ts}`);
    } catch (e) {
      console.warn("git commit after pull:", e);
    }
  }
  return { pulled, total: remote.length };
}

function mkState(r: { updatedAt: string }) {
  return {
    remote_version: r.updatedAt,
    pulled_at_mtime_ms: Date.now(),
  };
}

/// Push every local file to the KB. Updates manifest with the post-push
/// remote_version (which we approximate as "now" since the API doesn't
/// return one synchronously). Caller is the Deploy button.
/// Goes through the in-flight lock so it can't race the background poller.
export async function pushAllToKb(args: {
  creds: PinkfishCreds;
  repo: string;
  collection: KbCollection;
  onLine?: (msg: string) => void;
}): Promise<{ pushed: number; failed: number }> {
  return withSyncLock(() => pushAllToKbInner(args));
}

async function pushAllToKbInner(args: {
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

  // Use git status (content hash) instead of mtime to decide what to push.
  // Files that git reports as modified/untracked under knowledge-base/ are
  // the ones that actually changed since the last commit.
  const gitFiles = await gitStatusShort(repo).catch(() => []);
  const dirtyPaths = new Set(
    gitFiles
      .filter((g) => g.path.startsWith("knowledge-base/"))
      .map((g) => g.path.replace(/^knowledge-base\//, "")),
  );

  const toPush = local.filter((f) => {
    if (f.filename.includes(".server.")) return false;
    const tracked = persisted.files[f.filename];
    if (!tracked) return true;
    if (dirtyPaths.has(f.filename)) return true;
    // After a commit, the working tree is clean but mtime is newer than
    // what we recorded at last sync. That means the user committed edits
    // we haven't pushed yet.
    if (f.mtime_ms != null && f.mtime_ms > tracked.pulled_at_mtime_ms) return true;
    return false;
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

  if (pushedNames.size > 0) {
    try {
      const ts = new Date().toISOString();
      const paths = Array.from(pushedNames).map((n) => `knowledge-base/${n}`);
      await gitCommitPaths(repo, paths, `sync: deployed @ ${ts}`);
    } catch (e) {
      console.warn("git commit after push:", e);
    }
  }
  return { pushed, failed };
}
