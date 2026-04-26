// One implementation of the pull pipeline + per-repo serialization for every
// OpenIT entity (KB, filestore, datastore, agents, workflows). Each entity
// supplies an `EntityAdapter` describing how to load/save its manifest, list
// remote items, list local files, and write a fetched item or shadow. The
// engine owns: the lock, the manifest-load/diff/save sequence, the conflict
// shadow rule, the gitignore-safe `touched` array, and the auto-commit.
//
// Why this exists: see auto-dev/plans/2026-04-25-bidirectional-sync-plan.md
// "Architectural retrospective" — five BugBot iterations on PR #9 surfaced
// 16 findings, every one a duplicated-pipeline drift. Centralizing makes the
// next entity adapter ~50 lines instead of ~700.

import { gitCommitPaths, type KbStatePersisted } from "./api";

export type Manifest = KbStatePersisted;

// ---------------------------------------------------------------------------
// Shared shadow-filename helpers. Single source of truth for the
// `<base>.server.<ext>` convention used by every text/binary entity.
// Datastore uses a fixed `.json` extension so it doesn't call these
// directly — but it uses the same classifyAsShadow check.
//
// Centralised here because the entire premise of this refactor is
// eliminating duplicated logic that drifts independently. Three byte-
// for-byte copies of these helpers across the adapters would be exactly
// the class of bug the engine was designed to prevent.
// ---------------------------------------------------------------------------

const SHADOW_MARKER = ".server.";

/// `runbook.md` → `runbook.server.md`. Returned filename keeps the
/// extension so downstream tooling (mime detection, viewers, etc.) still
/// recognises the format.
export function shadowFilename(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0 || dot === filename.length - 1) return `${filename}.server`;
  return `${filename.slice(0, dot)}.server.${filename.slice(dot + 1)}`;
}

/// `runbook.server.md` → `runbook.md`. Inverse of shadowFilename.
export function canonicalFromShadow(filename: string): string {
  const i = filename.indexOf(SHADOW_MARKER);
  if (i < 0) return filename;
  return `${filename.slice(0, i)}.${filename.slice(i + SHADOW_MARKER.length)}`;
}

/// Necessary-but-not-sufficient: filename literally contains the shadow
/// marker. Use `classifyAsShadow` for the authoritative check that also
/// verifies a canonical sibling exists.
export function looksLikeShadow(filename: string): boolean {
  return filename.includes(SHADOW_MARKER);
}

/// Authoritative shadow classification. A file is a shadow IFF its
/// filename matches the `<base>.server.<ext>` pattern AND its canonical
/// sibling (`<base>.<ext>`) is also present in `siblingNames`.
///
/// Without the sibling check, a legitimate file like `nginx.server.conf`
/// (with no `nginx.conf` sibling) would be misclassified as a shadow —
/// the engine would skip tracking it as canonical and re-download a
/// fictional canonical sibling on every poll.
export function classifyAsShadow(
  filename: string,
  siblingNames: Set<string>,
): boolean {
  if (!looksLikeShadow(filename)) return false;
  return siblingNames.has(canonicalFromShadow(filename));
}


export type RemoteItem = {
  /// Key under `manifest.files` (often equals workingTreePath, but datastore
  /// uses `<collectionName>/<key>` so the mapping is adapter-specific).
  manifestKey: string;
  /// Repo-relative path used for the auto-commit's pathspec. Engine uses this
  /// as the `touched` entry; never the manifestKey.
  workingTreePath: string;
  /// Server's `updatedAt`. Empty string means "no version known" — engine
  /// will skip remote-version diff and treat the item as unchanged for
  /// version purposes. (Some servers return null/undefined; adapters
  /// normalize to "".)
  updatedAt: string;
  /// Download/write the canonical file. Engine calls this when it decides a
  /// pull is needed.
  fetchAndWrite(repo: string): Promise<void>;
  /// Write the conflict shadow file (e.g. `<base>.server.<ext>`). Engine
  /// calls this only on first conflict detection. Engine never adds shadow
  /// paths to `touched` — they're gitignored, and adding them would fail
  /// `git add` and silently drop legitimate items in the same batch.
  writeShadow(repo: string): Promise<void>;
};

export type LocalItem = {
  manifestKey: string;
  /// Repo-relative path. Used to determine `isShadow`.
  workingTreePath: string;
  mtime_ms: number | null;
  /// True if this is a `<base>.server.<ext>` conflict shadow. Engine
  /// excludes shadows from the diff (they're not real items).
  isShadow: boolean;
};

export type Conflict = {
  manifestKey: string;
  reason: "local-and-remote-changed";
};

export type PullResult = {
  pulled: number;
  /// Total number of items in the remote list (pre-diff). Wrappers expose
  /// this as their public `total` so callers see remote-side counts, not
  /// local-side counts.
  remoteCount: number;
  conflicts: Conflict[];
  /// True when listRemote bailed before exhausting pagination (e.g. safety
  /// cap on a runaway server). Engine skips the server-delete pass when
  /// this is true, since the truncated list isn't authoritative.
  paginationFailed: boolean;
};

export type EntityAdapter = {
  /// "kb" | "filestore" | "datastore" | "agent" | "workflow". Used in the
  /// per-repo lock key and in log messages.
  prefix: string;

  loadManifest(repo: string): Promise<Manifest>;
  saveManifest(repo: string, manifest: Manifest): Promise<void>;

  /// Fully paginate the remote list.
  ///
  /// `paginationFailed: true` means the entire listing is incomplete —
  /// engine skips server-delete detection across the board.
  ///
  /// `unreliableKeyPrefixes` is the per-scope variant: when only part of
  /// the listing is unreliable (e.g., datastore where one of N
  /// collections failed mid-paginate), the adapter returns the failed
  /// scopes' key prefixes here. Engine excludes only manifest keys whose
  /// `manifestKey` starts with one of these prefixes from the
  /// server-delete pass — collections that listed successfully still
  /// have their server-deleted rows reconciled.
  listRemote(repo: string): Promise<{
    items: RemoteItem[];
    paginationFailed: boolean;
    unreliableKeyPrefixes?: string[];
  }>;

  /// List items currently on disk for this entity's working-tree dirs.
  /// Include shadow files; engine filters via `isShadow`.
  listLocal(repo: string): Promise<LocalItem[]>;

  /// Optional: handle the case where a manifest entry has no corresponding
  /// remote item (= server deleted it). Returning `true` means the adapter
  /// took action (e.g. KB deletes the local file too); the engine skips
  /// its default behavior of just dropping the manifest entry.
  /// Adapters that opt in MUST push the local working-tree path to
  /// `touched` themselves so the deletion gets committed.
  ///
  /// `local` is the same list returned by `listLocal()` at the top of the
  /// pull pipeline, threaded through so adapters don't re-list the
  /// directory once per deleted key (N+1 IPC calls).
  onServerDelete?(args: {
    repo: string;
    manifestKey: string;
    manifest: Manifest;
    touched: string[];
    local: LocalItem[];
  }): Promise<boolean>;
};

// ---------------------------------------------------------------------------
// Per-repo+entity serializer. Pull, push, and bootstrap-write all serialize
// on this lock so manifest mutations can never race. KB historically used a
// module-level Promise queue; we mirror that semantics per (repo, prefix)
// since two different entities (e.g. KB pull + datastore pull) don't need
// to wait for each other, but two operations on the same entity must.
// ---------------------------------------------------------------------------

const repoLocks = new Map<string, Promise<unknown>>();

function lockKey(repo: string, prefix: string): string {
  return `${prefix}:${repo}`;
}

export function withRepoLock<T>(
  repo: string,
  prefix: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = lockKey(repo, prefix);
  const previous = repoLocks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(fn);
  repoLocks.set(key, next.catch(() => undefined));
  return next;
}

// ---------------------------------------------------------------------------
// Auto-commit helper. Centralises the gitignore-safe pathspec rule: the
// engine NEVER passes `*.server.*` paths to git_commit_paths because git
// rejects gitignored paths and would drop the whole batch. Adapters add
// only canonical paths to `touched`; engine just commits.
// ---------------------------------------------------------------------------

export async function commitTouched(
  repo: string,
  touched: string[],
  message: string,
): Promise<void> {
  if (touched.length === 0) return;
  try {
    await gitCommitPaths(repo, touched, message);
  } catch (e) {
    console.warn(`[syncEngine] commit failed (${message}):`, e);
  }
}

// ---------------------------------------------------------------------------
// The pull pipeline. Identical for every entity.
// ---------------------------------------------------------------------------

/// Engine pipeline phase signal. Fires inside the per-repo lock so wrapper
/// status updates serialize against any in-flight push on the same lock,
/// preventing the UI from flipping to "pulling" while a push is still
/// running. Exactly one terminal phase fires: "ready" on success, "error"
/// on a thrown pipeline error. Wrappers can react to each separately.
export type EnginePhase = "pulling" | "ready" | "error";

export type PullCallbacks = {
  onPhase?: (phase: EnginePhase) => void;
  /// Fires on successful pipeline completion. Invoked **inside** the
  /// per-repo lock so any wrapper-side status update from this callback
  /// serializes against the next operation queued on the lock.
  onResult?: (result: PullResult) => void;
  /// Fires on pipeline failure. Same lock-held semantics as onResult.
  onError?: (error: unknown) => void;
};

export function pullEntity(
  adapter: EntityAdapter,
  repo: string,
  opts: PullCallbacks = {},
): Promise<PullResult> {
  return withRepoLock(repo, adapter.prefix, async () => {
    opts.onPhase?.("pulling");
    try {
      const r = await pullEntityImpl(adapter, repo);
      opts.onPhase?.("ready");
      // Fire onResult **before** releasing the lock, so wrapper status
      // updates ("phase: ready", conflicts, lastPullAt, …) commit before
      // any push waiting on the lock can flip status to "pushing".
      // Without this, push status updates can land between the lock
      // release and the .then() callback. (BugBot iter 8.)
      opts.onResult?.(r);
      return r;
    } catch (e) {
      opts.onPhase?.("error");
      // Same lock-held rationale as onResult above.
      opts.onError?.(e);
      throw e;
    }
  });
}

async function pullEntityImpl(
  adapter: EntityAdapter,
  repo: string,
): Promise<PullResult> {
  const manifest = await adapter.loadManifest(repo);
  const {
    items: remote,
    paginationFailed,
    unreliableKeyPrefixes = [],
  } = await adapter.listRemote(repo);
  const local = await adapter.listLocal(repo);

  // Index local items so we can answer "is this manifestKey on disk?" and
  // "does this manifestKey have an existing shadow?" in O(1).
  const localCanonicalByKey = new Map<string, LocalItem>();
  const localShadowKeys = new Set<string>();
  for (const l of local) {
    if (l.isShadow) localShadowKeys.add(l.manifestKey);
    else localCanonicalByKey.set(l.manifestKey, l);
  }

  const touched: string[] = [];
  const conflicts: Conflict[] = [];
  let pulled = 0;

  for (const r of remote) {
    if (!r.manifestKey) continue;
    const tracked = manifest.files[r.manifestKey];
    const localFile = localCanonicalByKey.get(r.manifestKey);

    // 1. Brand new (not tracked, not on disk) → fetch + record + commit.
    if (!tracked && !localFile) {
      try {
        await r.fetchAndWrite(repo);
        manifest.files[r.manifestKey] = {
          remote_version: r.updatedAt,
          pulled_at_mtime_ms: Date.now(),
        };
        touched.push(r.workingTreePath);
        pulled += 1;
      } catch (e) {
        console.error(
          `[syncEngine:${adapter.prefix}] pull ${r.manifestKey} failed:`,
          e,
        );
      }
      continue;
    }

    // 2. Bootstrap-adoption: file already on disk but no manifest entry
    // (e.g. modal connect's `*ToDisk` seeded the working tree). Seed the
    // manifest using the file's current mtime as the baseline so future
    // polls can correctly detect localChanged. Don't rewrite the file
    // (would just churn). Don't add to touched (no commit needed).
    // Without this, every poll lands on this state and the row is
    // permanently undiffable — high-severity gap caught by BugBot iter 2.
    if (!tracked && localFile) {
      manifest.files[r.manifestKey] = {
        remote_version: r.updatedAt,
        pulled_at_mtime_ms: localFile.mtime_ms ?? Date.now(),
      };
      continue;
    }

    // 3. Tracked + on disk → diff.
    if (tracked && localFile) {
      const remoteChanged =
        r.updatedAt !== "" && r.updatedAt !== tracked.remote_version;
      const localChanged =
        localFile.mtime_ms != null &&
        localFile.mtime_ms > tracked.pulled_at_mtime_ms;

      if (remoteChanged && localChanged) {
        // Both moved → drop a shadow (only if no shadow already exists; a
        // pre-existing shadow means the conflict is unresolved from a prior
        // pass and re-writing it would re-touch on every poll). Engine never
        // adds the shadow path to `touched` — shadow files are gitignored.
        if (!localShadowKeys.has(r.manifestKey)) {
          try {
            await r.writeShadow(repo);
          } catch (e) {
            console.error(
              `[syncEngine:${adapter.prefix}] shadow ${r.manifestKey} failed:`,
              e,
            );
          }
        }
        conflicts.push({
          manifestKey: r.manifestKey,
          reason: "local-and-remote-changed",
        });
        continue;
      }

      if (remoteChanged && !localChanged) {
        // Pure fast-forward.
        try {
          await r.fetchAndWrite(repo);
          manifest.files[r.manifestKey] = {
            remote_version: r.updatedAt,
            pulled_at_mtime_ms: Date.now(),
          };
          touched.push(r.workingTreePath);
          pulled += 1;
        } catch (e) {
          console.error(
            `[syncEngine:${adapter.prefix}] pull ${r.manifestKey} failed:`,
            e,
          );
        }
      }
      // else: no remote change → nothing to do. (Local-only changes are a
      // push concern, not pull.)
      continue;
    }

    // 4. Tracked but missing locally → user/Claude deleted; leave alone.
    // Push will reconcile this.
  }

  // Server-side deletion: anything tracked that's NOT in `remote`.
  //   - paginationFailed=true: skip the entire pass (the listing is
  //     unreliable in aggregate).
  //   - unreliableKeyPrefixes: per-scope skip — keys with a prefix in
  //     this list are also skipped (e.g., datastore where one collection
  //     out of N failed mid-paginate; other collections still reconcile).
  if (!paginationFailed) {
    const remoteKeys = new Set(remote.map((r) => r.manifestKey));
    for (const mKey of Object.keys(manifest.files)) {
      if (remoteKeys.has(mKey)) continue;
      if (unreliableKeyPrefixes.some((p) => mKey.startsWith(p))) continue;
      const handled = await adapter.onServerDelete?.({
        repo,
        manifestKey: mKey,
        manifest,
        touched,
        local,
      });
      if (!handled) {
        // Default: just drop the manifest entry. Don't delete the file —
        // the user may have committed it locally and intend to push.
        delete manifest.files[mKey];
      }
    }
  }

  await adapter.saveManifest(repo, manifest);

  if (touched.length > 0) {
    const ts = new Date().toISOString();
    await commitTouched(repo, touched, `sync: pull @ ${ts}`);
  }

  return { pulled, remoteCount: remote.length, conflicts, paginationFailed };
}

// ---------------------------------------------------------------------------
// 60s background poll. Returns an `unsubscribe` function that clears the
// timer. Adapters use this for steady-state sync.
// ---------------------------------------------------------------------------

export const DEFAULT_POLL_INTERVAL_MS = 60_000;

export function startPolling(
  adapter: EntityAdapter,
  repo: string,
  opts: PullCallbacks & { pollMs?: number } = {},
): () => void {
  const interval = opts.pollMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timer = setInterval(() => {
    // Forward all callbacks to pullEntity so they fire inside the lock.
    // Default error logger applies only when caller didn't supply onError.
    pullEntity(adapter, repo, {
      onPhase: opts.onPhase,
      onResult: opts.onResult,
      onError:
        opts.onError ??
        ((e) =>
          console.error(`[syncEngine:${adapter.prefix}] poll failed:`, e)),
    }).catch(() => {
      // pullEntity rejects after onError fires; swallow to avoid an
      // unhandled-rejection log on top of whatever onError already did.
    });
  }, interval);
  return () => clearInterval(timer);
}
