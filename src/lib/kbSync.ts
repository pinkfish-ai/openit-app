// KB sync wrapper. Pull, conflict shadow, manifest, auto-commit all live in
// `syncEngine.ts` driven by `kbAdapter`. This file owns:
//   - The KB-specific status object that the UI subscribes to.
//   - Conflict-prompt assembly (KB-only — drives the "Resolve in Claude"
//     bubble in Shell.tsx).
//   - The push path (KB has its own per-file upload semantics that don't
//     fit the generic engine; engine still owns the lock + auto-commit).
//   - The lifecycle: resolve KB → seed manifest with collection id → run
//     the engine pull → start the 60s poll.
//
// Public API is unchanged from before the engine refactor; call sites
// (App, Shell, SourceControl, FileExplorer, Onboarding, PinkfishOauthModal)
// don't need to know the engine exists.

import {
  gitEnsureRepo,
  gitStatusShort,
  kbInit,
  kbListLocal,
  kbListRemote,
  kbStateLoad,
  kbStateSave,
  kbUploadFile,
} from "./api";
import { resolveProjectKb, type KbCollection } from "./kb";
import { derivedUrls, getToken, type PinkfishCreds } from "./pinkfishAuth";
import { kbAdapter, kbServerShadowFilename } from "./entities/kb";
import {
  canonicalFromShadow,
  commitTouched,
  pullEntity,
  startPolling,
  withRepoLock,
} from "./syncEngine";

export { kbServerShadowFilename };
/// Backward-compat alias for kbBaseFromShadowFilename. Internally now uses
/// the engine's canonicalFromShadow — single source of truth.
export const kbBaseFromShadowFilename = canonicalFromShadow;

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

let stopPoll: (() => void) | null = null;

export function kbHasServerShadowFiles(repo: string): Promise<boolean> {
  return kbListLocal(repo).then((files) =>
    files.some((f) => f.filename.includes(".server.")),
  );
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

async function runPull(args: {
  creds: PinkfishCreds;
  repo: string;
  collection: KbCollection;
}): Promise<{ pulled: number; total: number }> {
  // Status flips ("pulling" → "ready") fire via onPhase, which the engine
  // emits *inside* the per-repo lock. Without that, a manual pull queued
  // behind a running push would prematurely set phase: "pulling" while
  // the push was still executing — corrupting the user-visible state.
  try {
    const adapter = kbAdapter({ creds: args.creds, collection: args.collection });
    const result = await pullEntity(adapter, args.repo, {
      onPhase: (phase) => {
        if (phase === "pulling") update({ phase: "pulling" });
      },
    });
    const conflicts: ConflictFile[] = result.conflicts.map((c) => ({
      filename: c.manifestKey,
      reason: "local-and-remote-changed",
    }));
    update({
      phase: "ready",
      conflicts,
      lastPullAt: Date.now(),
      lastError: null,
    });
    return { pulled: result.pulled, total: result.remoteCount };
  } catch (e) {
    update({ phase: "error", lastError: String(e) });
    throw e;
  }
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
  if (stopPoll) {
    stopPoll();
    stopPoll = null;
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

  // Persist the collection id alongside the file manifest. Done outside the
  // engine because only the wrapper knows the collection — engine treats
  // manifests as opaque.
  const persisted = await kbStateLoad(repo);
  if (persisted.collection_id !== collection.id) {
    await kbStateSave(repo, {
      ...persisted,
      collection_id: collection.id,
      collection_name: collection.name,
    });
  }

  const result = await runPull({ creds, repo, collection });
  const adapter = kbAdapter({ creds, collection });
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
      console.error("kb pull failed:", e);
    },
  });
  return result;
}

export function stopKbSync() {
  if (stopPoll) {
    stopPoll();
    stopPoll = null;
  }
  update({ phase: "idle", collection: null, conflicts: [], lastError: null });
}

/// Run a single pull (e.g. immediately before a push). Public wrapper.
/// Goes through the engine's per-repo lock so it can't race the poller.
export async function pullNow(args: {
  creds: PinkfishCreds;
  repo: string;
  collection: KbCollection;
}): Promise<void> {
  await runPull(args);
}

/// Push every local file to the KB. Updates manifest with the post-push
/// remote_version (which the API doesn't return synchronously, so we
/// re-list and reconcile). Caller is the Sync tab's commit handler.
/// Serializes against pull on the engine's per-repo lock.
export async function pushAllToKb(args: {
  creds: PinkfishCreds;
  repo: string;
  collection: KbCollection;
  onLine?: (msg: string) => void;
}): Promise<{ pushed: number; failed: number }> {
  return withRepoLock(args.repo, "kb", () => pushAllToKbInner(args));
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
    const ts = new Date().toISOString();
    const paths = Array.from(pushedNames).map((n) => `knowledge-base/${n}`);
    await commitTouched(repo, paths, `sync: deployed @ ${ts}`);
  }
  return { pushed, failed };
}
