// Filestore sync wrapper. Phase 2 of V2 sync (PIN-5775) collapsed the
// orchestrator-level machinery (status, listeners, conflict tracking,
// in-flight resolve dedup, auto-create defaults, polling loop, lastSyncAt
// stamping, hasServerShadowFiles walker, etc.) into the shared
// `createCollectionEntitySync` helper in `syncEngine.ts`. This file is
// now ~150 LOC of filestore-specific glue:
//
//   - The CollectionSyncConfig (REST type, default names, adapter factory).
//   - The push impl (filestore-specific upload, sanitised-filename
//     reconciliation, post-push remote_version refresh).
//   - Re-exports under the names call sites already use.
//
// Sibling: kbSync.ts uses the same helper with KB config.

import { makeSkillsFetch } from "../api/fetchAdapter";
import {
  entityListLocal,
  entityRenameFile,
  fsStoreInit,
  fsStoreUploadFileSigned,
  kbListRemote,
} from "./api";
import { type DataCollection } from "./skillsApi";
import { derivedUrls, getToken, type PinkfishCreds } from "./pinkfishAuth";
import {
  filestoreAdapter,
  type FilestoreCollection,
} from "./entities/filestore";
import {
  loadCollectionManifest,
  saveCollectionManifest,
} from "./nestedManifest";
import {
  classifyAsShadow,
  commitTouched,
  createCollectionEntitySync,
  type CollectionSyncStatus,
} from "./syncEngine";

export type { FilestoreCollection };

/// Phase 1 of V2 sync (PIN-5775): all filestore collections we manage
/// carry the `openit-` prefix on the cloud. The remote listing is
/// filtered to this prefix before any sync logic runs so users with
/// unrelated filestores on their Pinkfish account aren't touched.
export const OPENIT_FILESTORE_PREFIX = "openit-";

/// Strip the `openit-` prefix for display in the UI / log lines. Returns
/// the input unchanged when the prefix is absent.
export function displayFilestoreName(name: string): string {
  return name.startsWith(OPENIT_FILESTORE_PREFIX)
    ? name.slice(OPENIT_FILESTORE_PREFIX.length)
    : name;
}

/// Single source of truth for the OpenIT-managed filestore collections.
/// Both `getDefaultFilestores` (caller-facing) and the engine handle's
/// `defaultNames` below are derived from this list — they used to drift
/// independently, which silently broke auto-create on the cloud for any
/// new entries. Keep this list and only this list authoritative.
///
///   - `openit-library`     — shared admin docs (admin-curated).
///   - `openit-attachments` — intake-server uploads (per-ticket).
///   - `openit-skills`      — admin-side skill markdown (PIN-5829).
///   - `openit-scripts`     — admin-side runnable scripts (PIN-5829).
const DEFAULT_FILESTORES: ReadonlyArray<{ name: string; description: string }> = [
  { name: "openit-library", description: "Shared document storage for OpenIT" },
  { name: "openit-attachments", description: "OpenIT filestore: attachments" },
  { name: "openit-skills", description: "OpenIT filestore: admin skills" },
  { name: "openit-scripts", description: "OpenIT filestore: admin scripts" },
];

export function getDefaultFilestores(_orgId: string) {
  return DEFAULT_FILESTORES.map((d) => ({ ...d }));
}

/// Dedupe helper retained as an export so existing tests pin the
/// behaviour. Same logic now lives inside the orchestrator's
/// `dedupeOpenit` and runs from there at runtime; this is the test
/// surface.
export function dedupeOpenitByName(
  all: DataCollection[],
): FilestoreCollection[] {
  const byName = new Map<string, FilestoreCollection>();
  for (const c of all) {
    if (!c.name.startsWith(OPENIT_FILESTORE_PREFIX)) continue;
    const candidate = {
      id: String(c.id),
      name: c.name,
      description: c.description,
    };
    const existing = byName.get(c.name);
    if (!existing || candidate.id < existing.id) {
      byName.set(c.name, candidate);
    }
  }
  return Array.from(byName.values());
}

export type ConflictFile = {
  filename: string;
  reason: "local-and-remote-changed";
};

export type FilestoreSyncStatus = CollectionSyncStatus<FilestoreCollection>;

// Map a collection name to its local subdirectory. Mirror of the same
// logic in `entities/filestore.ts` — push and pull need to agree.
function collectionLocalDir(collectionName: string): string {
  const folder = collectionName.startsWith(OPENIT_FILESTORE_PREFIX)
    ? collectionName.slice(OPENIT_FILESTORE_PREFIX.length)
    : collectionName;
  return `filestores/${folder}`;
}

// ---------------------------------------------------------------------------
// Engine handle — created once at module init. Status / lifecycle / pull /
// shadow walker / discovery all delegate into this.
// ---------------------------------------------------------------------------

const handle = createCollectionEntitySync<FilestoreCollection>({
  entityName: "fs",
  displayName: "filestore",
  collectionType: "filestorage",
  defaultNames: DEFAULT_FILESTORES.map((d) => d.name),
  describeDefault: (name) => {
    // Look up from the shared list so the description the engine
    // POSTs at create-time matches what `getDefaultFilestores`
    // returns. Fallback covers any future name added to
    // `defaultNames` without an explicit description entry.
    const entry = DEFAULT_FILESTORES.find((d) => d.name === name);
    return entry?.description ?? `OpenIT filestore: ${displayFilestoreName(name)}`;
  },
  localFolderRoot: "filestores",
  buildAdapter: ({ creds, collection }) => filestoreAdapter({ creds, collection }),
  fromDataCollection: (c) => ({
    id: String(c.id),
    name: c.name,
    description: c.description,
  }),
  initLocalRoot: fsStoreInit,
  pushOne: pushAllToFilestoreImpl,
});

export const subscribeFilestoreSync = handle.subscribe;
export const getFilestoreSyncStatus = handle.getStatus;
export const startFilestoreSync = handle.start;
export const stopFilestoreSync = handle.stop;

/// Manual single-shot pull for one collection. Used by Shell.tsx's ↻
/// button and the modal connect flow. Always resolves — never rejects —
/// to match the pre-engine contract.
export const pullOnce = handle.pullOne;

/// Resolve every openit-* filestore collection for this org. Exposed for
/// tests and pushAll.ts pre-push paths.
export function resolveProjectFilestores(
  creds: PinkfishCreds,
  onLog?: (msg: string) => void,
): Promise<FilestoreCollection[]> {
  return handle.resolveCollections(creds, onLog);
}

/// Push all local files in one collection to the remote. Goes through the
/// orchestrator's per-collection lock so it can't race a poll. The
/// engine-specific upload semantics live in `pushAllToFilestoreImpl`.
export const pushAllToFilestore = handle.pushOne;

// ---------------------------------------------------------------------------
// Push implementation — signed-URL upload (PIN-5847). The pre-PIN-5847
// multipart `/upload` endpoint added a UUID prefix on every call and
// created a fresh Firestore doc each time, so this file used to carry a
// `cloud_filename` indirection (PIN-5827) plus a post-push
// `kbListRemote` reconcile to bridge local→remote name mismatch.
// `/upload-request` returns the verbatim sanitized filename and dedupes
// the row by filename, so all of that machinery is gone — manifest keys
// by exact filename, both directions.
// ---------------------------------------------------------------------------

async function pushAllToFilestoreImpl(args: {
  creds: PinkfishCreds;
  repo: string;
  collection: FilestoreCollection;
  onLine?: (msg: string) => void;
}): Promise<{ pushed: number; failed: number }> {
  const { creds, repo, collection, onLine } = args;

  const token = getToken();
  if (!token) {
    onLine?.("✗ filestore push: not authenticated");
    return { pushed: 0, failed: 0 };
  }
  const urls = derivedUrls(creds.tokenUrl);

  const dir = collectionLocalDir(collection.name);
  const local = await entityListLocal(repo, dir);
  const persisted = await loadCollectionManifest(repo, "fs", collection.id);

  const siblings = new Set(local.map((f) => f.filename));
  const localCanonicalNames = new Set(
    local.filter((f) => !classifyAsShadow(f.filename, siblings)).map((f) => f.filename),
  );
  const toPush = local.filter((f) => {
    if (classifyAsShadow(f.filename, siblings)) return false;
    const tracked = persisted.files[f.filename];
    if (!tracked) return true;
    if (f.mtime_ms == null) return true;
    return f.mtime_ms > tracked.pulled_at_mtime_ms;
  });

  // Files in the manifest but no longer on disk → user-deleted; push must
  // issue a remote DELETE. Without this pass, local deletes never reach the
  // cloud (the engine's pull leaves the manifest entry alone for push to
  // reconcile, per syncEngine.ts case 4 / sync-engine.md §"server-delete").
  //
  // Safety guard: if local listing is empty but the manifest has entries,
  // refuse to delete. This is the "wiped working tree / transient read
  // failure" scenario datastore guards against — without the check, a
  // single bad listLocal would nuke every remote item. Datastore uses
  // `localDirExists && !innerWalkFailed`; we use the simpler shape because
  // filestore is one flat dir per collection. A truly empty filestore
  // collection is recovered on the *next* push after the user re-deletes
  // each file — annoying but not destructive.
  const manifestKeys = Object.keys(persisted.files);
  let toDelete: string[] = [];
  if (localCanonicalNames.size === 0 && manifestKeys.length > 0) {
    onLine?.(
      `▸ filestore push (${collection.name}): local listing empty but manifest has ${manifestKeys.length} entr${manifestKeys.length === 1 ? "y" : "ies"} — skipping deletion phase to avoid nuking remote`,
    );
  } else {
    toDelete = manifestKeys.filter((k) => !localCanonicalNames.has(k));
  }

  // [sync-debug]
  console.log(`[sync-debug:fs:${collection.name}] push inputs:`, {
    localFiles: local.map((l) => ({ filename: l.filename, mtime_ms: l.mtime_ms })),
    localCanonicalNames: Array.from(localCanonicalNames),
    manifestKeys,
    toPush: toPush.map((f) => f.filename),
    toDelete,
  });

  if (toPush.length === 0 && toDelete.length === 0) {
    onLine?.(`▸ filestore push (${collection.name}): nothing new to upload`);
    return { pushed: 0, failed: 0 };
  }

  let pushed = 0;
  let failed = 0;
  const pushedNames = new Set<string>();

  for (const f of toPush) {
    try {
      onLine?.(`▸ uploading ${dir}/${f.filename}`);
      const result = await fsStoreUploadFileSigned({
        repo,
        filename: f.filename,
        collectionId: collection.id,
        skillsBaseUrl: urls.skillsBaseUrl,
        accessToken: token.accessToken,
        subdir: dir,
      });
      // Server's `formatFileName` may sanitize the filename (spaces →
      // hyphens, special chars dropped). Most local filenames pass
      // through unchanged, but if the server returned something
      // different, rename local to match — that's the only way to
      // preserve the post-PIN-5847 invariant that
      // `manifestKey === local filename === remote filename`. Without
      // this, `pushedNames.has(r.filename)` in the reconcile below
      // misses (we'd have added the local name, server reports the
      // sanitized one), the manifest never gets the server's
      // `updatedAt`, and the sanitized-name file looks brand-new on
      // the next pull → duplicate.
      const cloudName =
        result.filename &&
        result.filename !== f.filename &&
        !result.filename.includes("/") &&
        !result.filename.includes("\\")
          ? result.filename
          : f.filename;
      if (cloudName !== f.filename) {
        try {
          await entityRenameFile(repo, dir, f.filename, cloudName);
          onLine?.(
            `  ↳ server sanitized name: ${f.filename} → ${cloudName} (renamed local)`,
          );
        } catch (e) {
          // If the rename fails (e.g. cloud-name collision with an
          // existing local file — kb.rs::entity_rename_file refuses
          // to overwrite to avoid silent data loss), skip the manifest
          // update for this row. Pull will surface the sanitized name
          // on the next poll for the user to resolve manually.
          onLine?.(`✗ ${dir}/${f.filename}: rename to ${cloudName} failed: ${String(e)}`);
          failed += 1;
          continue;
        }
        // Drop the stale manifest entry under the old (local) name.
        // Without this, the next pull sees a tracked entry with no
        // remote counterpart and fires `onServerDelete` for the
        // pre-rename key — self-heals but adds churn and noise, and
        // means the manifest briefly disagrees with disk.
        delete persisted.files[f.filename];
      }
      persisted.files[cloudName] = {
        remote_version: new Date().toISOString(),
        pulled_at_mtime_ms: f.mtime_ms ?? Date.now(),
      };
      pushedNames.add(cloudName);
      pushed += 1;
    } catch (e) {
      failed += 1;
      onLine?.(`✗ ${dir}/${f.filename}: ${String(e)}`);
    }
  }

  // Lazy single remote-list shared by both the deletion phase (needs
  // `id` to address each row in the DELETE URL) and the post-push
  // remote_version reconcile below. Most pushes are pure uploads with no
  // deletes, so `kbListRemote` only fires when something downstream
  // actually needs it.
  let remoteCache: Awaited<ReturnType<typeof kbListRemote>> | null = null;
  let remoteCacheError: unknown = null;
  async function getRemote() {
    if (remoteCache != null) return remoteCache;
    if (remoteCacheError != null) throw remoteCacheError;
    try {
      remoteCache = await kbListRemote({
        collectionId: collection.id,
        skillsBaseUrl: urls.skillsBaseUrl,
        accessToken: token!.accessToken,
      });
      return remoteCache;
    } catch (e) {
      remoteCacheError = e;
      throw e;
    }
  }

  // Deletion phase: DELETE /filestorage/items/<id> for each manifest
  // entry the user removed locally. Mirrors the datastore push's
  // "remote composites not in localComposites → DELETE" pass. Failure
  // to find the row on remote (already gone) is treated as success —
  // we just drop the manifest entry.
  if (toDelete.length > 0) {
    let remote: Awaited<ReturnType<typeof kbListRemote>> = [];
    try {
      remote = await getRemote();
    } catch (e) {
      onLine?.(
        `✗ filestore push (${collection.name}): failed to list remote for deletion phase: ${String(e)}`,
      );
      // Without the listing we can't address rows by id — fail closed
      // so we don't drop manifest entries that are still on remote.
      toDelete = [];
    }
    if (toDelete.length > 0) {
      const remoteByName = new Map(remote.map((r) => [r.filename, r]));
      const fetchFn = makeSkillsFetch(token.accessToken);
      for (const name of toDelete) {
        const r = remoteByName.get(name);
        if (!r || !r.id) {
          // Already gone from remote (or never had an id) — drop the
          // manifest entry and move on. No error, no count.
          delete persisted.files[name];
          continue;
        }
        try {
          const url = new URL(
            `/filestorage/items/${encodeURIComponent(r.id)}`,
            urls.skillsBaseUrl,
          );
          const resp = await fetchFn(url.toString(), { method: "DELETE" });
          if (!resp.ok && resp.status !== 404) {
            throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
          }
          delete persisted.files[name];
          onLine?.(`  − ${dir}/${name} (deleted on remote)`);
          pushed += 1;
        } catch (e) {
          onLine?.(`✗ ${dir}/${name}: delete failed: ${String(e)}`);
          failed += 1;
        }
      }
    }
  }

  // Reconcile remote_version against the server's authoritative
  // `updatedAt` after push. Without this, manifest holds the client
  // clock (`new Date().toISOString()` above), the engine compares
  // `r.updatedAt !== tracked.remote_version` on the next pull, the
  // strings never match, and every poll false-flags a fast-forward
  // (or — within a 60s window of a local edit — a phantom conflict
  // with a shadow file). PIN-5847 collapsed the cloud_filename
  // bridge but kept the version-sync need; this is the same reconcile
  // KB push has carried since Phase 2.
  if (pushedNames.size > 0) {
    try {
      const remote = await getRemote();
      for (const r of remote) {
        if (pushedNames.has(r.filename) && r.updated_at) {
          const tracked = persisted.files[r.filename];
          if (tracked) tracked.remote_version = r.updated_at;
        }
      }
    } catch (e) {
      console.warn(`[filestore:${collection.id}] post-push remote-version sync failed:`, e);
    }
  }

  await saveCollectionManifest(
    repo,
    "fs",
    collection.id,
    collection.name,
    persisted,
  );

  // Commit just-pushed files so they don't show as untracked on the next
  // Sync's `git status` check, which would mark them dirty and re-push
  // (creating duplicates on every Sync click pre-PIN-5847). Mirrors the
  // post-push commit kbSync.ts has had since Phase 2.
  if (pushedNames.size > 0) {
    const ts = new Date().toISOString();
    const paths = Array.from(pushedNames).map((n) => `${dir}/${n}`);
    await commitTouched(repo, paths, `sync: deployed @ ${ts}`);
  }

  return { pushed, failed };
}
