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

import { fsRead, gitCommitPaths, type KbStatePersisted } from "./api";

export type Manifest = KbStatePersisted;

/// Sentinel `pulled_at_mtime_ms` value the resolve script writes when
/// flipping a row into "force-push" state after a user-resolved
/// conflict. Any real local mtime exceeds it, so the engine's
/// `localChanged = mtime > pulled_at_mtime_ms` test is guaranteed to
/// fire. Mirrored in `scripts/openit-plugin/sync-resolve-conflict.mjs`
/// — keep the two values in sync.
export const FORCE_PUSH_MTIME_SENTINEL = 1;

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
/// `siblingNames` should contain the FULL set of local filenames in the
/// scope being checked — do NOT pre-filter shadow-shaped names out.
/// A legitimate `a.server.conf` (no `a.conf` sibling) returns false; a
/// `b.server.conf` with a `b.conf` sibling returns true. Pre-filtering
/// would cause a follow-on conflict shadow `a.server.server.conf` to
/// go undetected because its canonical-form (`a.server.conf`) was
/// excluded from the sibling set.
export function classifyAsShadow(
  filename: string,
  siblingNames: Set<string>,
): boolean {
  if (!looksLikeShadow(filename)) return false;
  return siblingNames.has(canonicalFromShadow(filename));
}

/// Sort-key recursive serializer. Two semantically-equal JSON values
/// produce the same string regardless of key order in the source.
/// Falls through arrays/primitives unchanged; only object key ordering
/// is normalized.
function canonicalJsonString(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonString).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map((k) => {
    const v = (value as Record<string, unknown>)[k];
    return `${JSON.stringify(k)}:${canonicalJsonString(v)}`;
  });
  return `{${parts.join(",")}}`;
}

/// Equivalence check for the bootstrap-adoption content compare.
/// A naive byte compare false-positives on harmless drift: trailing
/// newline from an editor save, CRLF vs LF on Windows, key order
/// differences from a different stringify path. We try a JSON-aware
/// canonical compare first (handles all three for datastore rows,
/// which are the only adapters using inlineContent today). If either
/// side isn't valid JSON, we fall back to a whitespace-trimmed string
/// compare, which still neutralises the trailing-newline + CRLF cases.
export function contentsEquivalent(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    const aJ = JSON.parse(a);
    const bJ = JSON.parse(b);
    return canonicalJsonString(aJ) === canonicalJsonString(bJ);
  } catch {
    return a.replace(/\r\n/g, "\n").trimEnd() === b.replace(/\r\n/g, "\n").trimEnd();
  }
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
  /// Optional cheap content access — returns the remote payload as it
  /// would be written to disk, without an extra HTTP round-trip. Used by
  /// the engine's content-equality check in the bootstrap-adoption
  /// branch: if local content differs from remote content, treat as a
  /// conflict instead of silently adopting (which would leave local edits
  /// unpushed indefinitely). Adapters whose remote payloads are inline
  /// in the list response (datastore via /memory/bquery) populate this.
  /// KB/filestore where content is a signed-URL download leave it
  /// undefined — the engine skips the check for them.
  inlineContent?(): Promise<string>;
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
  /// Repo-relative path the user can open. Filled in by the engine
  /// from the matching RemoteItem.workingTreePath.
  workingTreePath: string;
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
// Conflict aggregate. Every successful pullEntity call replaces this
// adapter's contribution to the aggregate; subscribers see the union
// across all five entities. R5 — drives the unified ConflictBanner that
// replaces per-entity ad-hoc surfacing.
// ---------------------------------------------------------------------------

export type AggregatedConflict = {
  prefix: string; // "kb" | "filestore" | "datastore" | "agent" | "workflow"
  manifestKey: string;
  workingTreePath: string;
  reason: "local-and-remote-changed";
};

const conflictsByPrefix = new Map<string, AggregatedConflict[]>();
const conflictSubscribers = new Set<(c: AggregatedConflict[]) => void>();

function snapshotConflicts(): AggregatedConflict[] {
  const out: AggregatedConflict[] = [];
  for (const list of conflictsByPrefix.values()) out.push(...list);
  return out;
}

function emitConflicts() {
  const snapshot = snapshotConflicts();
  for (const fn of conflictSubscribers) {
    try {
      fn(snapshot);
    } catch (e) {
      console.error("[syncEngine] conflict subscriber threw:", e);
    }
  }
}

export function subscribeConflicts(
  fn: (c: AggregatedConflict[]) => void,
): () => void {
  conflictSubscribers.add(fn);
  // Emit current state immediately so the UI doesn't have to wait for
  // the next pull tick to render the existing banner.
  fn(snapshotConflicts());
  return () => {
    conflictSubscribers.delete(fn);
  };
}

/// Drop a single entity's conflict contribution. Wrappers call this from
/// their stop functions so a stale entry can't outlive its sync.
export function clearConflictsForPrefix(prefix: string): void {
  if (conflictsByPrefix.delete(prefix)) emitConflicts();
}

/// Compute the on-disk shadow path for a conflict's canonical
/// workingTreePath. e.g. `databases/openit-people-XXX/p123.json`
/// → `databases/openit-people-XXX/p123.server.json`. Used by the
/// "Resolve in Claude" prompt builder so it can point Claude at both
/// sides of every conflict.
export function shadowPath(workingTreePath: string): string {
  const slash = workingTreePath.lastIndexOf("/");
  const dir = slash >= 0 ? workingTreePath.slice(0, slash + 1) : "";
  const filename = slash >= 0 ? workingTreePath.slice(slash + 1) : workingTreePath;
  return `${dir}${shadowFilename(filename)}`;
}

/// Compose a Claude-ready prompt that walks an LLM through every active
/// conflict and instructs it to merge each, delete shadows, and (for
/// pushable entities) push back. Generic across all five entities —
/// per-entity hints embedded in the prompt body so Claude knows to
/// preserve schema for datastore rows, leave workflow `releaseVersion`
/// alone, etc.
///
/// Returns null when there are no conflicts (caller should hide the
/// "Resolve in Claude" button).
export function buildConflictPrompt(
  conflicts: AggregatedConflict[],
): string | null {
  if (conflicts.length === 0) return null;

  const lines: string[] = [];
  lines.push(
    `There ${conflicts.length === 1 ? "is" : "are"} ${conflicts.length} sync conflict${conflicts.length === 1 ? "" : "s"} between my local edits and the Pinkfish remote. For each, both sides changed since the last sync, so the engine wrote a \`.server.\` shadow file (containing the remote's version) next to my local canonical.`,
  );
  lines.push("");
  lines.push(
    "**For each conflict below, perform ALL FOUR actions as one atomic unit.** Skipping the final script call leaves the banner stuck — the engine doesn't know the merge happened until the script runs. Do not stop after deleting the shadow.",
  );
  lines.push("");
  lines.push("### Conflicts to resolve");

  for (const c of conflicts) {
    const sh = shadowPath(c.workingTreePath);
    lines.push("");
    lines.push(`#### \`${c.workingTreePath}\``);
    lines.push("");
    lines.push(
      `1. Read \`${c.workingTreePath}\` (mine) and \`${sh}\` (the remote's) and merge them. Preserve both sides' changes wherever they touch different keys/lines.`,
    );
    lines.push(
      `2. Write the merged result to \`${c.workingTreePath}\`.`,
    );
    lines.push(
      `3. Delete \`${sh}\` (e.g. \`rm "${sh}"\`).`,
    );
    lines.push(
      "4. **Run the resolve-script — REQUIRED, banner won't clear without it:**",
    );
    lines.push("");
    lines.push("   ```bash");
    lines.push(
      `   node .claude/scripts/sync-resolve-conflict.mjs --prefix ${c.prefix} --key '${c.manifestKey}'`,
    );
    lines.push("   ```");
  }

  lines.push("");
  lines.push("### Merge guidance");
  lines.push(
    "**Default to auto-merging — do not interrogate me field-by-field.** Make the smart call yourself and proceed. The bar for stopping to ask is high (see below).",
  );
  lines.push("");
  lines.push(
    "- **JSON (datastore rows, agents, workflows):** walk the keys and decide silently.",
  );
  lines.push(
    "  - Key only on one side, or both sides match → trivial, take the value.",
  );
  lines.push(
    "  - Both sides changed the same key to different values → infer intent from context: edits I just made in this session win on those keys; the other side wins on keys it touched. Recency cues and obvious-correction heuristics (typo fix, more-complete data) are fair game.",
  );
  lines.push(
    "  - Only stop and ask if a specific key is genuinely ambiguous (no contextual cue, both values equally plausible). Even then, ask about *that one key*, not the whole row.",
  );
  lines.push(
    "- **Text/markdown (KB):** keep meaningful additions from both sides.",
  );
  lines.push(
    "- **Binary (PDFs/images in filestore):** can't merge bytes — ask me which version to keep before doing anything.",
  );
  lines.push(
    "- **Datastore `_schema.json` is read-only** — never touch it.",
  );
  lines.push(
    "- **Workflows:** only merge draft fields. Never modify `releaseVersion` or anything release-related.",
  );
  lines.push("");
  lines.push("### What to say back to me");
  lines.push(
    "**Do not surface raw field values** in your reply — they may be sensitive (PII, emails, phone numbers, secrets). After merging, summarise at the row/file level only:",
  );
  lines.push(
    "- ✅ Good: \"Merged `databases/openit-people-.../row-123.json` — kept your local change to one field, took the remote change to two others.\"",
  );
  lines.push(
    "- ❌ Avoid: tables or sentences that quote the actual before/after values.",
  );
  lines.push(
    "If a field is truly ambiguous and you must ask, refer to the **field name only** (e.g. \"`f_2` differs on both sides — which should win?\") — never paste the values.",
  );
  lines.push("");
  lines.push("### After all conflicts are resolved — confirm and sync");
  lines.push(
    "Once the merge + shadow delete + resolve-script have run for every conflict above, ask me one question:",
  );
  lines.push("");
  lines.push("> Sync these changes to Pinkfish now? (yes/no)");
  lines.push("");
  lines.push(
    "If I say yes, run the push script. The banner clears the moment the script writes its request marker, and OpenIT runs the actual push:",
  );
  lines.push("");
  lines.push("```bash");
  lines.push("node .claude/scripts/sync-push.mjs");
  lines.push("```");
  lines.push("");
  lines.push(
    "If I say no, leave it for me to push manually via the Sync tab.",
  );

  return lines.join("\n");
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

    // 1b. Tracked but missing from disk → re-fetch.
    // Manifest claims the file was synced, but it's not on disk anymore.
    // This can happen if a previous sync recorded the manifest entry but
    // the actual file write failed (e.g., directory creation issues), or
    // if the user deleted the file locally without a manifest update.
    // Without this branch, the engine would silently skip and the file
    // would never reappear.
    if (tracked && !localFile) {
      console.log(
        `[syncEngine:${adapter.prefix}] re-fetching ${r.manifestKey} (tracked but missing from disk)`,
      );
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
          `[syncEngine:${adapter.prefix}] re-fetch ${r.manifestKey} failed:`,
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
      // Content-equality check (when the adapter exposes it cheaply).
      // Without this, the bootstrap-adoption branch would silently
      // accept any on-disk content as the new baseline — including
      // post-merge content from a resolve flow where local has the
      // user's merged changes and remote still has the pre-merge
      // version. Treating that as "synced" hides the divergence.
      // Instead: if content differs, write the shadow + record a
      // conflict, just like the both-changed case below. Manifest
      // does NOT advance — engine will keep flagging until the user
      // pushes (which makes remote=local, content matches, conflict
      // clears).
      if (r.inlineContent) {
        let remoteContent: string | null = null;
        let localContent: string | null = null;
        try {
          remoteContent = await r.inlineContent();
        } catch (e) {
          console.warn(
            `[syncEngine:${adapter.prefix}] inlineContent fetch failed:`,
            e,
          );
        }
        if (remoteContent != null) {
          try {
            localContent = await fsRead(`${repo}/${localFile.workingTreePath}`);
          } catch (e) {
            console.warn(
              `[syncEngine:${adapter.prefix}] local read failed:`,
              e,
            );
          }
        }
        if (
          remoteContent != null &&
          localContent != null &&
          !contentsEquivalent(localContent, remoteContent)
        ) {
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
            workingTreePath: r.workingTreePath,
            reason: "local-and-remote-changed",
          });
          // Seed the manifest entry with `conflict_remote_version` set
          // to the current remote.updatedAt. The resolve script reads
          // this back to encode "user has reconciled against this
          // remote version, push local now". Without this, deleting
          // the manifest on resolve would re-fire bootstrap-adopt's
          // content-equality check on the next pull and re-create the
          // shadow when the user picked LOCAL (their merged content
          // diverges from the still-stale remote). remote_version=""
          // and pulled_at_mtime_ms=0 keep the entry visibly "unpulled"
          // so engine logic on next pull won't accidentally treat it
          // as a sync'd row.
          manifest.files[r.manifestKey] = {
            remote_version: "",
            pulled_at_mtime_ms: 0,
            conflict_remote_version: r.updatedAt,
          };
          continue;
        }
      }
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
        // Both moved → drop a shadow with the current remote content.
        //
        // Re-write the shadow whenever remote has advanced since the
        // last shadow we wrote, even if a shadow file already exists.
        // The recorded `tracked.conflict_remote_version` is what the
        // existing shadow was sourced from; if r.updatedAt now differs,
        // the shadow on disk is stale and the user would merge against
        // out-of-date content. The resolve-script then writes that
        // current `r.updatedAt` as the new manifest remote_version, the
        // pre-push pull sees remoteChanged=false, and we silently
        // overwrite the newer remote changes the user never saw.
        // (Skipping when shadow exists AND remote hasn't moved since
        // we wrote it preserves the original mtime-thrash protection.)
        const shadowIsStale =
          tracked.conflict_remote_version != null &&
          tracked.conflict_remote_version !== r.updatedAt;
        const needShadowWrite =
          !localShadowKeys.has(r.manifestKey) || shadowIsStale;
        if (needShadowWrite) {
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
          workingTreePath: r.workingTreePath,
          reason: "local-and-remote-changed",
        });
        // Record the current remote_version on the manifest entry so
        // the resolve script can encode "I've reconciled against this
        // remote version" on the user's behalf. remote_version /
        // pulled_at_mtime_ms stay at their pre-conflict values so the
        // pre-push pull on a subsequent (still-unresolved) cycle still
        // sees both sides changed. See the bootstrap-adopt branch
        // above for the parallel case.
        manifest.files[r.manifestKey] = {
          ...tracked,
          conflict_remote_version: r.updatedAt,
        };
        continue;
      }

      // Falling out of the conflict branch — clear any stale
      // conflict_remote_version on this entry. Without this, a row
      // that was conflicted, then pushed (by another path), then
      // pulled again would carry a stale conflict marker.
      if (tracked.conflict_remote_version != null) {
        manifest.files[r.manifestKey] = {
          remote_version: tracked.remote_version,
          pulled_at_mtime_ms: tracked.pulled_at_mtime_ms,
        };
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

  // Replace this entity's contribution to the global conflict aggregate
  // and notify subscribers (banner UI). Done inside the per-repo lock
  // so the snapshot is consistent with the manifest+commit it just
  // wrote — no chance of a stale "conflict" line hanging around for an
  // item that's already been resolved.
  conflictsByPrefix.set(
    adapter.prefix,
    conflicts.map((c) => ({
      prefix: adapter.prefix,
      manifestKey: c.manifestKey,
      workingTreePath: c.workingTreePath,
      reason: c.reason,
    })),
  );
  emitConflicts();

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

// ---------------------------------------------------------------------------
// startReadOnlyEntitySync — the connect-time + poll bootstrap for entities
// where the adapter is built from cached resolve data and the wrapper just
// needs to log + run pull + start poll. agents and workflows use this; KB,
// filestore, and datastore have entity-specific bootstrap (collection
// resolve + initial item write) that doesn't fit this template.
// ---------------------------------------------------------------------------

export type ReadOnlySyncHandle = {
  stop: () => void;
  /// Resolves once the FIRST resolve+pull attempt completes. Rejects
  /// with the first-attempt error so callers can mark it as a sync
  /// failure (modal's syncErrors flag, etc.). The poller runs
  /// regardless — the handle is always returned synchronously, so
  /// even if `firstAttempt` rejects, the caller still has `stop()` to
  /// clean up the timer.
  firstAttempt: Promise<void>;
};

export function startReadOnlyEntitySync(args: {
  /// Build the adapter from a freshly-resolved item list. Called on every
  /// poll tick — the adapter is rebuilt each time so server-side
  /// add/delete is reflected. The factory is responsible for running the
  /// REST resolve and using the returned items as the adapter's source.
  buildAdapter: () => Promise<EntityAdapter>;
  repo: string;
  pollMs?: number;
  /// Receives a single summary line on the FIRST attempt only — silent
  /// on subsequent poll ticks to avoid spamming the modal log. Per-
  /// item log lines (the `✓ <name>` rows) are the wrapper's job inside
  /// buildAdapter.
  onLog?: (msg: string) => void;
  /// Format function for the summary log line.
  itemLabel?: (count: number, pulled: number) => string;
}): ReadOnlySyncHandle {
  const { buildAdapter, repo, onLog, itemLabel } = args;
  let adapter: EntityAdapter | null = null;
  let firstAttemptDone = false;

  const tryResolveAndPull = async () => {
    const isFirst = !firstAttemptDone;
    firstAttemptDone = true;
    if (!adapter) {
      try {
        adapter = await buildAdapter();
      } catch (e) {
        if (isFirst) throw e;
        // Non-first poll-tick failures still log to console — silent
        // swallow would hide REST/auth/manifest errors from production
        // debugging (R4 iter 3 finding).
        console.error("[syncEngine] read-only build failed:", e);
        return;
      }
    }
    try {
      const r = await pullEntity(adapter, repo);
      if (isFirst && onLog && itemLabel) {
        onLog(itemLabel(r.remoteCount, r.pulled));
      }
    } catch (e) {
      if (isFirst) throw e;
      console.error("[syncEngine] read-only pull failed:", e);
    }
  };

  const interval = args.pollMs ?? DEFAULT_POLL_INTERVAL_MS;
  // Install the timer first so the handle is always returnable even
  // if the first attempt rejects (iter 2 of R4 BugBot — without this
  // the timer leaked and couldn't be stopped). Function is no longer
  // async so handle returns synchronously; the first-attempt result is
  // exposed via the `firstAttempt` promise.
  const timer = setInterval(tryResolveAndPull, interval);
  const firstAttempt = tryResolveAndPull();
  return {
    stop: () => clearInterval(timer),
    firstAttempt,
  };
}
