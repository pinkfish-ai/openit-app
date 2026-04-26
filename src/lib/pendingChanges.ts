// Local-only "is anything pending push?" probes. The Sync-tab Commit
// button and the Claude-triggered marker handler both run a per-entity
// pre-pull before pushing, even when the working tree is unchanged.
// On orgs with many collections (15 datastore collections in the
// tested account), the pre-pull dominates the pipeline cost — but the
// pre-pull's only job is to surface conflicts before clobbering, and
// when there's nothing to push there's nothing to clobber.
//
// These helpers answer "does this entity have any divergence between
// the manifest and the working tree?" without making API calls. If
// false, `pushAllEntities` short-circuits the entity entirely. If
// true, current behavior (pre-pull → push) is unchanged.
//
// Definition of "pending":
//   - any tracked entry has `conflict_remote_version` set (active
//     conflict mid-resolve), OR
//   - any local file has mtime > the manifest entry's
//     `pulled_at_mtime_ms` (user / Claude edited it since last pull),
//     OR
//   - any local file has no manifest entry (new file the user added).
//
// What it deliberately does NOT count:
//   - manifest entries with no matching local file (deletions). Push
//     doesn't reconcile deletions today — claiming "pending" here
//     would just trigger an unnecessary pre-pull. Server-side delete
//     reconciliation runs on the pull side, not push.
//   - `.server.<ext>` shadow files (filtered via classifyAsShadow).

import {
  datastoreListLocal,
  datastoreStateLoad,
  fsStoreListLocal,
  fsStoreStateLoad,
  kbListLocal,
  kbStateLoad,
  type KbLocalFile,
  type KbStatePersisted,
} from "./api";
import { classifyAsShadow } from "./syncEngine";

function manifestHasActiveConflict(manifest: KbStatePersisted): boolean {
  for (const entry of Object.values(manifest.files ?? {})) {
    if (entry.conflict_remote_version != null) return true;
  }
  return false;
}

/// Shared logic for entities whose `manifestKey` equals the on-disk
/// filename: KB and filestore. Datastore namespaces by collection, so
/// it has its own variant.
///
/// `nullMtimeIsPending` mirrors the entity's push semantics. KB push
/// treats `mtime_ms == null` as not pushable (returns false from its
/// toPush filter); filestore push treats it as pushable (`if
/// (f.mtime_ms == null) return true;`). Matching the helper to the
/// push decision avoids skipping a pre-pull when push WOULD have
/// uploaded the file, which would silently swallow the upload until
/// something else marked the entity dirty.
function flatEntityHasPending(
  manifest: KbStatePersisted,
  files: KbLocalFile[],
  nullMtimeIsPending: boolean,
): boolean {
  if (manifestHasActiveConflict(manifest)) return true;

  const siblings = new Set(files.map((f) => f.filename));
  for (const f of files) {
    if (classifyAsShadow(f.filename, siblings)) continue;
    const tracked = manifest.files[f.filename];
    if (!tracked) return true; // user added a file the engine hasn't seen
    if (f.mtime_ms == null) {
      if (nullMtimeIsPending) return true;
      continue;
    }
    if (f.mtime_ms > tracked.pulled_at_mtime_ms) {
      return true; // user / Claude edited since last pull
    }
  }
  return false;
}

export async function kbHasPendingChanges(repo: string): Promise<boolean> {
  const [manifest, files] = await Promise.all([
    kbStateLoad(repo),
    kbListLocal(repo),
  ]);
  // KB push: null mtime is NOT pushable.
  return flatEntityHasPending(manifest, files, false);
}

export async function filestoreHasPendingChanges(repo: string): Promise<boolean> {
  const [manifest, files] = await Promise.all([
    fsStoreStateLoad(repo),
    fsStoreListLocal(repo),
  ]);
  // Filestore push: null mtime IS pushable (defensive — stat blip
  // shouldn't strand a real local edit).
  return flatEntityHasPending(manifest, files, true);
}

/// Datastore is per-collection. Manifest keys are `<colName>/<key>`,
/// local files at `databases/<colName>/<key>.json`. We iterate the
/// collection names we already know about (from manifest keys), so a
/// brand-new collection added entirely outside the engine's awareness
/// won't trigger pending — but that's not how rows arrive in practice
/// (all rows come from server via bootstrap; the bootstrap step seeds
/// the manifest before the user can interact).
///
/// **Datastore push reconciles deletions** (`pushAllToDatastoresImpl`
/// iterates remote rows whose key isn't in the local set and DELETEs
/// them server-side). Skipping the entire entity when a tracked row
/// is no longer on disk would silently swallow the user's deletion
/// until some other change kicks the pre-pull. Different from KB /
/// filestore — those don't push deletions, so manifest-only entries
/// stay invisible to their pending check.
export async function datastoreHasPendingChanges(repo: string): Promise<boolean> {
  const manifest = await datastoreStateLoad(repo);
  if (manifestHasActiveConflict(manifest)) return true;

  const colNames = new Set<string>();
  for (const key of Object.keys(manifest.files ?? {})) {
    const slash = key.indexOf("/");
    if (slash > 0) colNames.add(key.slice(0, slash));
  }

  for (const colName of colNames) {
    let files: KbLocalFile[];
    try {
      files = await datastoreListLocal(repo, colName);
    } catch {
      // Collection dir missing — could be a fresh checkout or a user-
      // wiped folder. The latter is a wholesale deletion event datastore
      // push WILL act on, so flag pending. Distinguishing the two
      // would need filesystem stat we don't have here cheaply.
      return true;
    }
    const siblings = new Set(files.map((f) => f.filename));
    const localKeysInCol = new Set<string>();
    for (const f of files) {
      if (classifyAsShadow(f.filename, siblings)) continue;
      const rowKey = f.filename.replace(/\.json$/, "");
      localKeysInCol.add(rowKey);
      const key = `${colName}/${rowKey}`;
      const tracked = manifest.files[key];
      if (!tracked) return true; // new local row
      if (f.mtime_ms != null && f.mtime_ms > tracked.pulled_at_mtime_ms) {
        return true;
      }
    }

    // Deletion check: any manifest entry in this collection whose
    // local file is missing → pending (datastore push will DELETE
    // server-side). Iterate the manifest to avoid an O(N*M) scan.
    const colPrefix = `${colName}/`;
    for (const mKey of Object.keys(manifest.files)) {
      if (!mKey.startsWith(colPrefix)) continue;
      const rowKey = mKey.slice(colPrefix.length);
      if (!localKeysInCol.has(rowKey)) return true;
    }
  }
  return false;
}
