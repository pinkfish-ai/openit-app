// Pinkfish push pipeline shared by the Sync tab and the
// `.openit/push-request.json` trigger flow (the latter is what
// `scripts/openit-plugin/sync-push.mjs` drives).
//
// PIN-5865: each entity-class task runs in parallel via
// `Promise.allSettled` and short-circuits when its working-tree scope
// is clean. The 60s background poller still surfaces remote-side
// adds/deletes, so trusting `git status` here is safe for the no-op
// case. KB / filestore / datastore are all wrapped in their own
// per-class try/catch so a single class's failure doesn't take down
// the others. `commitTouched` is serialised through a `(repo, "git")`
// lock at the engine layer so concurrent pulls/pushes don't race
// `.git/index.lock`.
//
// KB and filestore use their existing push functions; datastores use
// pushAllToDatastores. We pre-pull each entity to surface conflicts
// before clobbering teammate edits, then push and stream results.

import {
  getSyncStatus,
  kbHasServerShadowFiles,
  pullAllKbNow,
  pushAllToKb,
  startKbSync,
} from "./kbSync";
import { displayKbName } from "./kb";
import {
  pushAllToFilestore,
  getFilestoreSyncStatus,
  pullOnce as filestorePullOnce,
  startFilestoreSync,
} from "./filestoreSync";
import { pushAllToDatastores, pullDatastoresOnce } from "./datastoreSync";
import { pullAgentsOnce, pushAllToAgents } from "./agentSync";
import { loadCreds, type PinkfishCreds } from "./pinkfishAuth";
import { invoke } from "@tauri-apps/api/core";
import { entityListLocal, gitStatusShort, type KbStatePersisted } from "./api";
import {
  classifyAsShadow,
  getConflictsForPrefix,
  hasConflictsForPrefix,
} from "./syncEngine";
import { loadCollectionManifest } from "./nestedManifest";

type LineFn = (line: string) => void;

/// True iff every canonical (non-shadow) file under `dir` already has
/// a matching manifest entry, every manifest entry still has a file on
/// disk, AND no on-disk file's mtime has advanced past its tracked
/// `pulled_at_mtime_ms`. Used by skip-clean to detect:
///   - new files added + committed (filename set mismatch)
///   - files deleted locally (filename set mismatch other direction)
///   - **modified** files committed (mtime advanced past tracked stamp)
///
/// Mirrors the predicate the push function uses in `toPush`: the same
/// three conditions that mean "needs push" in `pushAllToKbImpl` /
/// `pushAllToFilestoreImpl` are exactly the ones that should block
/// skip-clean here. Earlier version checked filenames only and missed
/// the modified-then-committed case (BugBot iter 5, High). PIN-5865.
async function manifestMatchesDisk(args: {
  repo: string;
  dir: string;
  manifest: KbStatePersisted;
}): Promise<boolean> {
  const { repo, dir, manifest } = args;
  const local = await entityListLocal(repo, dir).catch(() => []);
  const allNames = new Set(local.map((f) => f.filename));
  const localCanonical = local.filter(
    (f) => !classifyAsShadow(f.filename, allNames),
  );
  const tracked = manifest.files;
  if (localCanonical.length !== Object.keys(tracked).length) return false;
  for (const f of localCanonical) {
    const entry = tracked[f.filename];
    if (!entry) return false;
    // Filesystem couldn't report an mtime — typically a read error
    // or an exotic filesystem mode. The filestore push treats this
    // as "needs push" (filestoreSync.ts:204), so skip-clean must
    // also refuse to fire. KB push happens to take the opposite
    // stance for this same shape, but matching the looser one would
    // silently drop filestore work; better to over-pull on the rare
    // null-mtime case than mis-skip. (BugBot iter 7, Medium.)
    if (f.mtime_ms == null) return false;
    // Modified-then-committed case: file's mtime advanced past the
    // last-pulled stamp. Push would upload it; skip-clean must not
    // fire. (BugBot iter 5, High.)
    if (f.mtime_ms > entry.pulled_at_mtime_ms) return false;
  }
  return true;
}

export async function pushAllEntities(
  repo: string,
  onLine: LineFn,
): Promise<void> {
  const creds = await loadCreds().catch(() => null);
  if (!creds) {
    onLine("✗ sync: not authenticated");
    return;
  }

  onLine("▸ sync: starting push to Pinkfish");

  // Pre-flight: one `git status --short` per click, scoped per-class
  // by string-prefix filter below. Cheaper than the previous N calls
  // (one per adapter push) and lets us decide skip-or-run before any
  // remote round-trip.
  const gitFiles = await gitStatusShort(repo).catch(() => []);
  const dirtyPaths = new Set(gitFiles.map((g) => g.path));
  const dirtyUnderScope = (scopeDir: string): boolean => {
    const prefix = `${scopeDir}/`;
    for (const p of dirtyPaths) if (p.startsWith(prefix)) return true;
    return false;
  };

  // All three entity-class tasks run concurrently. Each one owns its
  // own try/catch + onLine output so a sub-task failure surfaces in
  // the sync pane without taking the other classes down.
  await Promise.allSettled([
    runKb({ creds, repo, onLine, dirtyUnderScope }),
    runFilestore({ creds, repo, onLine, dirtyUnderScope }),
    runDatastore({ creds, repo, onLine, dirtyUnderScope }),
    runAgent({ creds, repo, onLine, dirtyUnderScope }),
  ]);

  onLine("▸ sync: done");
}

// ---------------------------------------------------------------------------
// KB — class-level skip + class-level pre-push pull (`pullAllKbNow`).
// Per-collection push stays sequential; KB collections are usually a
// single one in practice and the multipart `/upload` endpoint is the
// bottleneck, not list-remote.
// ---------------------------------------------------------------------------

async function runKb(args: {
  creds: PinkfishCreds;
  repo: string;
  onLine: LineFn;
  dirtyUnderScope: (scopeDir: string) => boolean;
}): Promise<void> {
  const { creds, repo, onLine, dirtyUnderScope } = args;
  try {
    // KB requires a resolved collection list; if sync hasn't run yet
    // (e.g. user commits before the initial pull completes), kick it
    // off inline.
    let collections = getSyncStatus().collections;
    if (collections.length === 0) {
      onLine("▸ sync: resolving knowledge base");
      try {
        await startKbSync({ creds, repo });
        collections = getSyncStatus().collections;
      } catch (e) {
        onLine(`✗ sync: kb resolve failed: ${String(e)}`);
        return;
      }
    }
    if (collections.length === 0) {
      onLine("▸ sync: kb skipped (no collections)");
      return;
    }

    // Skip-clean: every collection has been pulled at least once
    // (`last_pull_at_ms` set, even an empty pull counts) AND has no
    // dirty paths under its dir AND no engine-level conflicts at its
    // adapter prefix. Trust the 60s poller for remote-side changes.
    // PIN-5865.
    //
    // Why `last_pull_at_ms` instead of `Object.keys(files).length > 0`:
    // a collection that's empty on both ends (no local files, no
    // remote rows) never populates `files`. With the file-count
    // precondition, skip-clean fails forever and we re-pull every
    // click for nothing — the openit-attachments case before any
    // ticket has had an attachment.
    //
    // The kb adapter's prefix IS the collection's working-tree dir
    // (`knowledge-bases/<displayName>`) — see `kbAdapter` in
    // `entities/kb.ts`. Passing the dir to `hasConflictsForPrefix`
    // here matches the slot the engine writes after each pull.
    const cleanByCol = await Promise.all(
      collections.map(async (c) => {
        const dir = `knowledge-bases/${displayKbName(c.name)}`;
        if (dirtyUnderScope(dir)) return false;
        if (hasConflictsForPrefix(dir)) return false;
        const m = await loadCollectionManifest(repo, "kb", c.id);
        if (m.last_pull_at_ms == null) return false;
        // Catches the committed-but-never-synced case: file lives on
        // disk + in git history but not yet in the manifest, so push
        // has work even though `git status` is clean.
        return await manifestMatchesDisk({ repo, dir, manifest: m });
      }),
    );
    if (cleanByCol.every(Boolean)) {
      onLine("▸ sync: kb skipped (clean)");
      return;
    }

    // Pre-pull every collection to detect remote/local conflicts before
    // we clobber anything. A conflict in any collection blocks the push
    // for ALL of them — half-applied state is worse than surfacing the
    // conflict and asking the user to resolve.
    const shadowBefore = await kbHasServerShadowFiles(repo);
    if (shadowBefore) {
      onLine(
        "✗ sync: kb has unresolved merge shadow (.server.) files — resolve and commit again",
      );
      return;
    }

    onLine(
      `▸ sync: kb pre-push pull (${collections.length} collection${collections.length === 1 ? "" : "s"})`,
    );
    try {
      await pullAllKbNow({ creds, repo });
    } catch (e) {
      onLine(`✗ sync: kb pull failed: ${String(e)}`);
      return;
    }
    const conflicts = getSyncStatus().conflicts;
    const hasShadow = await kbHasServerShadowFiles(repo);
    if (conflicts.length > 0 || hasShadow) {
      onLine(
        "✗ sync: kb pull surfaced conflicts — resolve in Claude, then commit again:",
      );
      for (const c of conflicts) onLine(`  • ${c.filename}: ${c.reason}`);
      if (hasShadow && conflicts.length === 0) {
        onLine(
          "  • server shadow files present under one or more knowledge-bases/<name>/ folders",
        );
      }
      return;
    }

    for (const collection of collections) {
      const displayName = displayKbName(collection.name);
      onLine(`▸ sync: kb (${displayName}) pushing`);
      try {
        const { pushed, failed } = await pushAllToKb({
          creds,
          repo,
          collection,
          onLine,
        });
        onLine(
          `▸ sync: kb push (${displayName}) — ${pushed} ok, ${failed} failed`,
        );
      } catch (e) {
        onLine(`✗ sync: kb push (${displayName}) failed: ${String(e)}`);
      }
    }
  } catch (e) {
    onLine(`✗ sync: kb failed: ${String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// Filestore — per-collection skip and per-collection pull/push, all
// running concurrently. The engine's per-(repo, prefix) lock already
// serialises pull-vs-push within a single collection; sibling
// collections never block each other.
// ---------------------------------------------------------------------------

async function runFilestore(args: {
  creds: PinkfishCreds;
  repo: string;
  onLine: LineFn;
  dirtyUnderScope: (scopeDir: string) => boolean;
}): Promise<void> {
  const { creds, repo, onLine, dirtyUnderScope } = args;
  try {
    let collections = getFilestoreSyncStatus().collections;
    if (collections.length === 0) {
      onLine("▸ sync: resolving filestore");
      try {
        await startFilestoreSync({ creds, repo });
        collections = getFilestoreSyncStatus().collections;
      } catch (e) {
        onLine(`✗ sync: filestore resolve failed: ${String(e)}`);
        return;
      }
    }
    if (collections.length === 0) {
      onLine("▸ sync: filestore skipped (no collections)");
      return;
    }

    await Promise.allSettled(
      collections.map((collection) =>
        runFilestoreCollection({
          creds,
          repo,
          collection,
          onLine,
          dirtyUnderScope,
        }),
      ),
    );
  } catch (e) {
    onLine(`✗ sync: filestore failed: ${String(e)}`);
  }
}

async function runFilestoreCollection(args: {
  creds: PinkfishCreds;
  repo: string;
  collection: { id: string; name: string };
  onLine: LineFn;
  dirtyUnderScope: (scopeDir: string) => boolean;
}): Promise<void> {
  const { creds, repo, collection, onLine, dirtyUnderScope } = args;
  try {
    // Mirror of `collectionLocalDir` in filestoreSync.ts and the
    // adapter prefix in `entities/filestore.ts` — all three must agree
    // on the path. The filestore adapter's prefix IS this dir, which
    // is also the slot used by `conflictsByPrefix`. Pre-pull skip
    // checks query that slot directly so a sibling collection's
    // conflict can't contaminate this one.
    const folder = collection.name.startsWith("openit-")
      ? collection.name.slice("openit-".length)
      : collection.name;
    const dir = `filestores/${folder}`;

    if (!dirtyUnderScope(dir) && !hasConflictsForPrefix(dir)) {
      const m = await loadCollectionManifest(repo, "fs", collection.id);
      // last_pull_at_ms is the bootstrap sentinel; manifestMatchesDisk
      // catches the committed-but-never-synced case (user dropped a
      // file in, committed, hit Sync — git is clean but manifest
      // doesn't know about it yet). See runKb for the longer
      // rationale on both.
      if (
        m.last_pull_at_ms != null &&
        (await manifestMatchesDisk({ repo, dir, manifest: m }))
      ) {
        onLine(`▸ sync: filestore (${collection.name}) skipped (clean)`);
        return;
      }
    }

    onLine(`▸ sync: filestore (${collection.name}) pre-push pull`);
    let safe = true;
    try {
      const { ok, error, downloaded } = await filestorePullOnce({
        creds,
        repo,
        collection,
      });
      // Per-collection conflict snapshot from the engine's prefix
      // store, not the cross-collection union in
      // `getFilestoreSyncStatus().conflicts`. Without this filter, a
      // sibling collection's conflicts that landed concurrently
      // during the same Promise.allSettled batch would block this
      // collection's push as a false positive. (BugBot finding,
      // PIN-5865.)
      const conflicts = getConflictsForPrefix(dir);
      if (!ok) {
        // pullOnce never throws; check ok explicitly. Without this a
        // network/auth failure would leave conflicts empty AND no catch
        // fires — push would silently proceed and clobber.
        safe = false;
        onLine(
          `✗ sync: filestore (${collection.name}) pre-push pull failed: ${error ?? "unknown"}`,
        );
      } else if (conflicts.length > 0) {
        safe = false;
        onLine(
          `✗ sync: filestore (${collection.name}) pull surfaced conflicts — resolve in Claude, then commit again:`,
        );
        for (const c of conflicts) {
          onLine(`  • ${c.workingTreePath}: ${c.reason}`);
        }
      } else if (downloaded > 0) {
        onLine(
          `▸ sync: filestore (${collection.name}) pulled ${downloaded} file(s) before push`,
        );
      }
    } catch (e) {
      safe = false;
      onLine(
        `✗ sync: filestore (${collection.name}) pre-push pull failed: ${String(e)}`,
      );
    }
    if (!safe) return;

    onLine(`▸ sync: filestore (${collection.name}) pushing`);
    try {
      const { pushed, failed } = await pushAllToFilestore({
        creds,
        repo,
        collection,
        onLine,
      });
      onLine(
        `▸ sync: filestore push (${collection.name}) — ${pushed} ok, ${failed} failed`,
      );
    } catch (e) {
      onLine(`✗ sync: filestore push (${collection.name}) failed: ${String(e)}`);
    }
  } catch (e) {
    onLine(`✗ sync: filestore (${collection.name}) failed: ${String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// Datastore — single class, single pre-push pull, single push call.
// ---------------------------------------------------------------------------

async function runDatastore(args: {
  creds: PinkfishCreds;
  repo: string;
  onLine: LineFn;
  dirtyUnderScope: (scopeDir: string) => boolean;
}): Promise<void> {
  const { creds, repo, onLine, dirtyUnderScope: _dirtyUnderScope } = args;
  void _dirtyUnderScope;
  try {
    // No skip-clean for datastore: its on-disk layout (per-collection
    // subdirs, nested conversations/<ticketId>/msg-*.json) doesn't
    // map cleanly to a single-call manifestMatchesDisk check, and the
    // performance cost of always running the pre-push pull is one
    // RTT — small relative to the user-facing risk of an
    // unsynced-row regression. PIN-5865.
    onLine("▸ sync: datastores pre-push pull");
    let safe = true;
    try {
      const { ok, error, pulled, conflicts } = await pullDatastoresOnce({
        creds,
        repo,
      });
      if (!ok) {
        safe = false;
        onLine(`✗ sync: datastores pre-push pull failed: ${error ?? "unknown"}`);
      } else if (conflicts.length > 0) {
        safe = false;
        onLine(
          "✗ sync: datastores pull surfaced conflicts — resolve in Claude, then commit again:",
        );
        for (const c of conflicts) {
          onLine(`  • ${c.collectionName}/${c.key}.json: ${c.reason}`);
        }
      } else if (pulled > 0) {
        onLine(`▸ sync: datastores pulled ${pulled} row(s) before push`);
      }
    } catch (e) {
      safe = false;
      onLine(`✗ sync: datastores pre-push pull failed: ${String(e)}`);
    }

    if (!safe) return;

    onLine("▸ sync: datastores pushing");
    try {
      const { pushed, failed } = await pushAllToDatastores({
        creds,
        repo,
        onLine,
      });
      onLine(`▸ sync: datastore push complete — ${pushed} ok, ${failed} failed`);
    } catch (e) {
      onLine(`✗ sync: datastore push failed: ${String(e)}`);
    }
  } catch (e) {
    onLine(`✗ sync: datastore failed: ${String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// Agent — single class, flat layout (`agents/<name>.json`). Mirrors
// runDatastore's shape but with skip-clean (the flat layout maps cleanly
// to manifestMatchesDisk, unlike datastore's nested per-collection
// conversations dir).
// ---------------------------------------------------------------------------

async function runAgent(args: {
  creds: PinkfishCreds;
  repo: string;
  onLine: LineFn;
  dirtyUnderScope: (scopeDir: string) => boolean;
}): Promise<void> {
  const { creds, repo, onLine, dirtyUnderScope } = args;
  try {
    // Skip-clean: the agent adapter's prefix is the class-level string
    // "agent" (not the dir). Pass that to `hasConflictsForPrefix`. The
    // dir for `manifestMatchesDisk` and `dirtyUnderScope` is "agents".
    if (!dirtyUnderScope("agents") && !hasConflictsForPrefix("agent")) {
      const m = await invoke<KbStatePersisted>("entity_state_load", {
        repo,
        name: "agent",
      });
      if (
        m.last_pull_at_ms != null &&
        (await manifestMatchesDisk({ repo, dir: "agents", manifest: m }))
      ) {
        onLine("▸ sync: agents skipped (clean)");
        return;
      }
    }

    onLine("▸ sync: agents pre-push pull");
    let safe = true;
    try {
      const { ok, error, pulled } = await pullAgentsOnce({ creds, repo });
      const conflicts = getConflictsForPrefix("agent");
      if (!ok) {
        safe = false;
        onLine(`✗ sync: agents pre-push pull failed: ${error ?? "unknown"}`);
      } else if (conflicts.length > 0) {
        safe = false;
        onLine(
          "✗ sync: agents pull surfaced conflicts — resolve in Claude, then commit again:",
        );
        for (const c of conflicts) {
          onLine(`  • ${c.workingTreePath}: ${c.reason}`);
        }
      } else if (pulled > 0) {
        onLine(`▸ sync: agents pulled ${pulled} agent(s) before push`);
      }
    } catch (e) {
      safe = false;
      onLine(`✗ sync: agents pre-push pull failed: ${String(e)}`);
    }

    if (!safe) return;

    onLine("▸ sync: agents pushing");
    try {
      const { pushed, failed } = await pushAllToAgents({ creds, repo, onLine });
      onLine(`▸ sync: agent push complete — ${pushed} ok, ${failed} failed`);
    } catch (e) {
      onLine(`✗ sync: agent push failed: ${String(e)}`);
    }
  } catch (e) {
    onLine(`✗ sync: agent failed: ${String(e)}`);
  }
}
