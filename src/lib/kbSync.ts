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
import { KB_SYNC_PREFIX, kbAdapter, kbServerShadowFilename } from "./entities/kb";
import {
  canonicalFromShadow,
  classifyAsShadow,
  clearConflictsForPrefix,
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

/// Compute the sibling set used by `classifyAsShadow`. Returns ALL
/// local filenames — including shadow-shaped names — because a legit
/// `a.server.conf` should still appear so a follow-on double-shadow
/// `a.server.server.conf` correctly maps back via canonicalFromShadow.
function canonicalSiblingSet(files: { filename: string }[]): Set<string> {
  return new Set(files.map((f) => f.filename));
}

export function kbHasServerShadowFiles(repo: string): Promise<boolean> {
  return kbListLocal(repo).then((files) => {
    const siblings = canonicalSiblingSet(files);
    return files.some((f) => classifyAsShadow(f.filename, siblings));
  });
}

/// Prompt text for Claude Code to resolve KB merge conflicts (pairs yours vs server shadow).
export async function buildKbConflictPrompt(repo: string): Promise<string> {
  const sync = getSyncStatus();
  const local = await kbListLocal(repo);
  const siblings = canonicalSiblingSet(local);
  const shadowNames = local
    .map((f) => f.filename)
    .filter((n) => classifyAsShadow(n, siblings));
  const lines: string[] = [];
  // 2026-04-27 plural rename: paths now sit under
  // `knowledge-bases/default/`. Same conflict-resolve copy works,
  // just refers to the new location so the agent's Read/Write/Edit
  // ops land in the right place.
  for (const c of sync.conflicts) {
    const sh = kbServerShadowFilename(c.filename);
    lines.push(`- knowledge-bases/default/${c.filename} (yours) vs knowledge-bases/default/${sh} (server)`);
  }
  for (const sh of shadowNames) {
    if (sync.conflicts.some((c) => kbServerShadowFilename(c.filename) === sh)) continue;
    const base = kbBaseFromShadowFilename(sh);
    lines.push(`- knowledge-bases/default/${base} (yours) vs knowledge-bases/default/${sh} (server)`);
  }
  if (lines.length === 0) return "";
  return `There are merge conflicts in the knowledge base. For each pair below, read both files, merge them intelligently into the main file (the one without ".server." in the name), then delete the .server. shadow file(s).

${lines.join("\n")}

For binary files (e.g. PDF), pick the correct version or replace manually, then delete the shadow file.`;
}

async function runPull(args: {
  repo: string;
  adapter: ReturnType<typeof kbAdapter>;
}): Promise<{ pulled: number; total: number }> {
  // ALL status updates fire inside the engine's per-repo lock via the
  // onPhase / onResult / onError callbacks. Doing them post-await would
  // race against a queued push grabbing the lock and updating status
  // first. Lock-held callbacks make the order deterministic.
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
  return { pulled: result.pulled, total: result.remoteCount };
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

  // Build the adapter once and share it for the initial pull and the
  // 60s poll — saves the redundant construction and makes it obvious
  // both paths run on the same configuration.
  const adapter = kbAdapter({ creds, collection });
  // Catch initial-pull failures (e.g. transient network blip) so we still
  // start the poller — otherwise the user sits in `phase: "error"` with
  // no automatic recovery path. runPull already updates status on failure.
  // Also preserves the public `Promise<… | null>` contract.
  let result: { pulled: number; total: number } | null = null;
  try {
    result = await runPull({ repo, adapter });
  } catch (e) {
    console.error("kb sync: initial pull failed (poll will still start):", e);
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
      // onPhase("pulling") fired before the failure, so without an error
      // status update here the UI stays stuck at phase: "pulling" until
      // a subsequent poll succeeds. Recover by surfacing the error.
      console.error("kb pull failed:", e);
      update({ phase: "error", lastError: String(e) });
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
  // Must use the same prefix the adapter registers conflicts under
  // (`knowledge-bases/default` post-2026-04-27 rename) — otherwise
  // stale KB conflicts would persist in the aggregated banner.
  clearConflictsForPrefix(KB_SYNC_PREFIX);
}

/// Run a single pull (e.g. immediately before a push). Public wrapper.
/// Goes through the engine's per-repo lock so it can't race the poller.
///
/// Always resolves — never rejects — to match the pre-engine contract
/// callers (Shell.tsx ↻ button, SourceControl pre-push pull) depend on.
/// The pull's success/failure is conveyed through the SyncStatus
/// (`getSyncStatus().phase` becomes "error" on failure); callers that
/// need to gate behavior on outcome should read the status rather than
/// catch a rejection.
export async function pullNow(args: {
  creds: PinkfishCreds;
  repo: string;
  collection: KbCollection;
}): Promise<void> {
  const adapter = kbAdapter({ creds: args.creds, collection: args.collection });
  try {
    await runPull({ repo: args.repo, adapter });
  } catch (e) {
    // runPull's onError already set status to phase: "error"; swallowing
    // the rejection here just preserves the void/no-reject contract.
    console.error("kb pullNow failed:", e);
  }
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
  // Must match the kbAdapter's prefix so push and pull share the
  // same `${prefix}:${repo}` lock. With drift, the 60s pull poller
  // could race the push and corrupt the manifest / fetch order.
  return withRepoLock(args.repo, KB_SYNC_PREFIX, () => pushAllToKbInner(args));
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
  // Files that git reports as modified/untracked under
  // `knowledge-bases/default/` are the ones that actually changed since
  // the last commit. (Custom KBs aren't part of cloud sync in V1.)
  const gitFiles = await gitStatusShort(repo).catch(() => []);
  const dirtyPaths = new Set(
    gitFiles
      .filter((g) => g.path.startsWith("knowledge-bases/default/"))
      .map((g) => g.path.replace(/^knowledge-bases\/default\//, "")),
  );

  // Sibling-aware shadow exclusion — a legitimate `nginx.server.conf`
  // (no `nginx.conf` sibling) should still push.
  const siblings = canonicalSiblingSet(local);
  const toPush = local.filter((f) => {
    if (classifyAsShadow(f.filename, siblings)) return false;
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
    const paths = Array.from(pushedNames).map((n) => `knowledge-bases/default/${n}`);
    await commitTouched(repo, paths, `sync: deployed @ ${ts}`);
  }
  return { pushed, failed };
}
