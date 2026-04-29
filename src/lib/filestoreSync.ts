// Filestore sync wrapper. Pull pipeline + auto-commit + conflict shadow live
// in `syncEngine.ts` driven by `filestoreAdapter`. This file owns:
//   - The status object the FileExplorer subscribes to.
//   - Filestore-specific resolve (find or create the openit-* collection,
//     with 409-conflict + eventual-consistency handling — REST surface
//     hasn't moved).
//   - The push path (filestore upload semantics differ from the engine's
//     diff model; engine still gives us the lock + auto-commit helper).
//
// Behavior changes vs the pre-engine version (R1 refactor):
//   - Poll interval drops from 5 min to 60 s, matching every other entity.
//   - Conflict shadows now drop on both-changed, mirroring KB.
//   - Server-side deletion now drops the manifest entry (didn't before).
// All three are improvements per the plan; flagged here for review.

import { kbListRemote, fsStoreUploadFile, entityListLocal } from "./api";
import { type DataCollection } from "./skillsApi";
import { derivedUrls, getToken, type PinkfishCreds } from "./pinkfishAuth";
import { makeSkillsFetch } from "../api/fetchAdapter";
import { fsStoreInit } from "./api";
import { filestoreAdapter, type FilestoreCollection } from "./entities/filestore";
import {
  loadCollectionManifest,
  saveCollectionManifest,
} from "./nestedManifest";
import {
  classifyAsShadow,
  clearConflictsForPrefix,
  pullEntity,
  startPolling,
  withRepoLock,
} from "./syncEngine";

const OPENIT_PREFIX = "openit-";

/// Map a collection name to its local filestore subdirectory.
/// `openit-library` → `filestores/library`
/// `openit-docs-123` → `filestores/docs-123`
/// Mirror of the same logic in entities/filestore.ts so push and pull
/// agree on which directory to read/write.
function collectionLocalDir(collectionName: string): string {
  const folder = collectionName.startsWith(OPENIT_PREFIX)
    ? collectionName.slice(OPENIT_PREFIX.length)
    : collectionName;
  return `filestores/${folder}`;
}

export type { FilestoreCollection };

export type ConflictFile = {
  filename: string;
  reason: "local-and-remote-changed";
};

export type FilestoreSyncStatus = {
  phase: "idle" | "resolving" | "pulling" | "ready" | "pushing" | "error";
  collections: FilestoreCollection[];
  conflicts: ConflictFile[];
  lastError: string | null;
  lastPullAt: number | null;
};

/// Defaults for OpenIT-managed filestore collections. All names use the
/// `openit-` prefix so we can filter remote listings to only OpenIT's own
/// collections (a user's Pinkfish account may also have unrelated filestores).
///
/// Phase 1 of V2 sync (PIN-5775): renamed from `openit-docs-<orgId>` to
/// `openit-library` so the remote name mirrors the local folder name
/// (`filestores/library/`). Pre-V2 collections under the old name will be
/// orphaned — V1 deployment surface is small (test orgs) and Phase 2 covers
/// proper cross-engine migration.
export function getDefaultFilestores(_orgId: string) {
  return [
    {
      name: "openit-library",
      description: "Shared document storage for OpenIT",
    },
    {
      name: "openit-attachments",
      description: "OpenIT filestore: attachments",
    },
  ];
}

/// Prefix every OpenIT-managed filestore collection carries on the cloud.
/// Used to filter the user's full filestore list down to the ones we own
/// before any sync logic runs.
export const OPENIT_FILESTORE_PREFIX = "openit-";

/// Strip the `openit-` prefix for display in the UI. Returns the input
/// unchanged if it doesn't start with the prefix (defensive — should always
/// match for collections we manage, but the engine surfaces collection
/// names from remote which we don't fully control).
export function displayFilestoreName(name: string): string {
  return name.startsWith(OPENIT_FILESTORE_PREFIX)
    ? name.slice(OPENIT_FILESTORE_PREFIX.length)
    : name;
}

let status: FilestoreSyncStatus = {
  phase: "idle",
  collections: [],
  conflicts: [],
  lastError: null,
  lastPullAt: null,
};

const listeners = new Set<(s: FilestoreSyncStatus) => void>();
let resolvedRepos = new Set<string>();

// Org-scoped cache to prevent collections from one org leaking into another.
let createdCollections = new Map<string, Map<string, FilestoreCollection>>();

// Per-org in-flight resolve promise — concurrent callers share the same
// operation so we never race two list-then-create sequences.
const inflightResolve = new Map<string, Promise<FilestoreCollection[]>>();

function getOrgCache(orgId: string): Map<string, FilestoreCollection> {
  if (!createdCollections.has(orgId)) {
    createdCollections.set(orgId, new Map());
  }
  return createdCollections.get(orgId)!;
}

export function subscribeFilestoreSync(
  fn: (s: FilestoreSyncStatus) => void,
): () => void {
  listeners.add(fn);
  fn(status);
  return () => listeners.delete(fn);
}

export function getFilestoreSyncStatus(): FilestoreSyncStatus {
  return status;
}

function update(patch: Partial<FilestoreSyncStatus>) {
  status = { ...status, ...patch };
  for (const l of listeners) l(status);
}

// Each call to startPolling spawns its own 60s interval; we need to stop
// every collection's interval, not just the last one. Pre-fix this was a
// single scalar that the loop kept overwriting, leaking earlier pollers.
let stopPolls: Array<() => void> = [];

// Per-collection conflict tracking. Pre-fix, every poll callback set
// `status.conflicts` to only the firing collection's conflicts, so the
// last poll to complete clobbered every other collection's entries. We
// now keep one slot per collection and rebuild status.conflicts from
// the union on every update.
const conflictsByCollection = new Map<string, ConflictFile[]>();
function flattenConflicts(): ConflictFile[] {
  const out: ConflictFile[] = [];
  for (const list of conflictsByCollection.values()) out.push(...list);
  return out;
}

// Track every adapter prefix this run created so stopFilestoreSync can
// drop their entries from the engine's per-prefix conflict aggregate.
// Pre-fix the wrapper called clearConflictsForPrefix("filestore"), but
// the actual prefixes are filestores/<folder>, so the call cleared
// nothing.
const activePrefixes = new Set<string>();

// ---------------------------------------------------------------------------
// Resolve helpers — REST API via skillsApi. Unchanged from pre-engine; the
// resolve flow is filestore-specific and doesn't fit the engine.
// ---------------------------------------------------------------------------

export async function resolveProjectFilestores(
  creds: PinkfishCreds,
  onLog?: (msg: string) => void,
): Promise<FilestoreCollection[]> {
  const existing = inflightResolve.get(creds.orgId);
  if (existing) {
    console.log("[filestore] joining in-flight resolve for org:", creds.orgId);
    return existing;
  }
  const promise = resolveProjectFilestoresImpl(creds, onLog);
  inflightResolve.set(creds.orgId, promise);
  try {
    return await promise;
  } finally {
    inflightResolve.delete(creds.orgId);
  }
}

/// Dedupe by name across all openit-* collections. If the API returned
/// multiple collections with the same name (legacy duplicates), keep the
/// lexicographically smallest id so every caller in the same session
/// converges on the same one. Non-openit collections (e.g. user's own
/// `customer-feedback`) are filtered out so the sync engine never sees
/// them.
///
/// Pre-Phase-1 also had a tighter `dedupeByName(all, defaults)` that
/// further filtered to the hardcoded defaults set, but Phase 1 syncs
/// every openit-* collection (defaults + per-org dynamic ones) so the
/// defaults-filter variant was unused in production and removed.
export function dedupeOpenitByName(
  all: DataCollection[],
): FilestoreCollection[] {
  const byName = new Map<string, FilestoreCollection>();
  for (const c of all) {
    if (!c.name.startsWith(OPENIT_FILESTORE_PREFIX)) continue;
    const candidate = { id: String(c.id), name: c.name, description: c.description };
    const existing = byName.get(c.name);
    if (!existing || candidate.id < existing.id) {
      byName.set(c.name, candidate);
    }
  }
  return Array.from(byName.values());
}

async function resolveProjectFilestoresImpl(
  creds: PinkfishCreds,
  onLog?: (msg: string) => void,
): Promise<FilestoreCollection[]> {
  console.log("[filestore] resolveProjectFilestores called for org:", creds.orgId);
  const token = getToken();
  if (!token) throw new Error("not authenticated");

  const all = await listFilestoreCollections(creds);
  // Return every openit-* collection, deduped by name (lex-smallest id
  // wins). Implementation lives in `dedupeOpenitByName` so unit tests
  // pin the exact behavior the runtime uses.
  const openit = dedupeOpenitByName(all);

  console.log(
    `[filestore] ✓ Found ${all.length} filestore collections, ${openit.length} with openit-* prefix`,
  );
  openit.forEach((c) => {
    console.log(`  • ${c.name} (id: ${c.id})`);
    onLog?.(`  ✓ ${c.name} (id: ${c.id})`);
  });

  // Cache all discovered remote collections
  const orgCache = getOrgCache(creds.orgId);
  for (const c of openit) {
    orgCache.set(c.name, c);
  }

  return openit;
}

async function listFilestoreCollections(creds: PinkfishCreds): Promise<DataCollection[]> {
  const token = getToken();
  if (!token) throw new Error("not authenticated");
  const urls = derivedUrls(creds.tokenUrl);

  try {
    const fetchFn = makeSkillsFetch(token.accessToken);
    const url = new URL("/datacollection/", urls.skillsBaseUrl);
    url.searchParams.set("type", "filestorage");
    console.log("[filestore] Fetching from:", url.toString());
    const response = await fetchFn(url.toString());

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    let result: DataCollection[] | null;
    try {
      result = (await response.json()) as DataCollection[] | null;
    } catch (e) {
      console.error("[filestore] failed to parse list response JSON:", e);
      throw new Error(`Failed to parse collection list: ${e}`);
    }

    const collections = Array.isArray(result) ? result : [];
    console.log(`[filestore] list_collections returned ${collections.length} filestorage collections`);
    collections.forEach((c) => console.log(`  • ${c.name} (id: ${c.id})`));
    return collections;
  } catch (error) {
    console.error("[filestore] Failed to list collections:", error);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Sync loop — engine-driven.
// ---------------------------------------------------------------------------

async function runPull(args: {
  repo: string;
  adapter: ReturnType<typeof filestoreAdapter>;
  collectionId: string;
}): Promise<{ downloaded: number; total: number }> {
  // All status updates fire inside the engine's per-repo lock — see the
  // matching comment in kbSync.runPull for rationale.
  const result = await pullEntity(args.adapter, args.repo, {
    onPhase: (phase) => {
      if (phase === "pulling") update({ phase: "pulling" });
    },
    onResult: (r) => {
      conflictsByCollection.set(
        args.collectionId,
        r.conflicts.map((c) => ({
          filename: c.manifestKey,
          reason: "local-and-remote-changed",
        })),
      );
      update({
        phase: "ready",
        conflicts: flattenConflicts(),
        lastPullAt: Date.now(),
        lastError: null,
      });
    },
    onError: (e) => {
      update({ phase: "error", lastError: String(e) });
    },
  });
  return { downloaded: result.pulled, total: result.remoteCount };
}

/// Resolve filestore collections for this org and begin polling for changes.
/// Idempotent — safe to call again on org change.
export async function startFilestoreSync(args: {
  creds: PinkfishCreds;
  repo: string;
}): Promise<void> {
  const { creds, repo } = args;
  console.log("[filestoreSync] start", { repo });

  for (const stop of stopPolls) stop();
  stopPolls = [];
  conflictsByCollection.clear();
  for (const prefix of activePrefixes) clearConflictsForPrefix(prefix);
  activePrefixes.clear();

  update({ phase: "resolving", lastError: null });

  try {
    await fsStoreInit(repo);
  } catch (e) {
    console.error("[filestoreSync] fsStoreInit failed:", e);
    update({ phase: "error", lastError: String(e) });
    return;
  }

  let collections: FilestoreCollection[];
  try {
    collections = await resolveProjectFilestores(creds);
    console.log("[filestoreSync] resolved collections", collections);
  } catch (e) {
    console.error("[filestoreSync] resolveProjectFilestores failed:", e);
    update({ phase: "error", lastError: String(e) });
    return;
  }
  update({ collections });

  // Auto-create remote collections for local folders that don't exist yet.
  // Scan filestores/ for folders and ensure each has a corresponding openit-* collection on remote.
  // Use org-scoped cache to prevent duplicate creation on repeated startFilestoreSync calls.
  try {
    const token = getToken();
    const urls = derivedUrls(creds.tokenUrl);
    if (!token) throw new Error("not authenticated");
    
    const orgCache = getOrgCache(creds.orgId);
    const localFolderNames = ["library", "attachments"]; // Known default folders
    
    for (const folderName of localFolderNames) {
      const remoteName = `${OPENIT_FILESTORE_PREFIX}${folderName}`;
      
      // Check if already exists in remote list
      if (collections.some((c) => c.name === remoteName)) {
        console.log(`[filestoreSync] Remote collection ${remoteName} already exists`);
        orgCache.set(remoteName, collections.find((c) => c.name === remoteName)!);
        continue;
      }
      
      // Check if we recently created this one (avoid duplicate creation from eventual consistency delays)
      if (orgCache.has(remoteName)) {
        console.log(`[filestoreSync] Collection ${remoteName} cached as recently created, skipping duplicate attempt`);
        continue;
      }
      
      // MARK IN CACHE BEFORE CREATING: if another concurrent call checks cache, it will see that we're creating this
      // Use a sentinel to indicate "in progress" — we set the real collection AFTER creation succeeds
      const sentinel = { id: "pending", name: remoteName, description: "pending creation" } as FilestoreCollection;
      orgCache.set(remoteName, sentinel);
      
      // Create missing remote collection
      try {
        console.log(`[filestoreSync] Creating remote collection ${remoteName}...`);
        const fetchFn = makeSkillsFetch(token.accessToken);
        const url = new URL("/datacollection/", urls.skillsBaseUrl);
        const response = await fetchFn(url.toString(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: remoteName,
            type: "filestorage",
            description: `OpenIT filestore: ${folderName}`,
            createdBy: creds.orgId,
            createdByName: "OpenIT",
          }),
        });

        if (!response.ok) {
          if (response.status === 409) {
            console.log(`[filestoreSync] Collection ${remoteName} already exists (409)`);
            // Remove the sentinel and fetch the real collection info
            orgCache.delete(remoteName);
            continue;
          }
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const result = (await response.json()) as { id?: string | number } | null;
        if (result?.id) {
          const newCollection = {
            id: String(result.id),
            name: remoteName,
            description: `OpenIT filestore: ${folderName}`,
          } as FilestoreCollection;
          collections.push(newCollection);
          orgCache.set(remoteName, newCollection); // Update sentinel with real collection
          console.log(`[filestoreSync] ✓ Created ${remoteName} with id: ${result.id}`);
          
          // Post-create refetch to handle eventual consistency: verify the collection is now visible on the API
          try {
            console.log(`[filestoreSync] post-create refetch for ${remoteName}...`);
            const refetched = await listFilestoreCollections(creds);
            const refetchedOpenit = refetched.filter((c) => c.name.startsWith(OPENIT_FILESTORE_PREFIX));
            if (refetchedOpenit.some((c) => c.name === remoteName)) {
              console.log(`[filestoreSync] ✓ post-create refetch confirmed ${remoteName} is now visible`);
            } else {
              console.warn(`[filestoreSync] ⚠ post-create refetch did not see ${remoteName} yet (eventual consistency)`);
            }
          } catch (refetchErr) {
            console.warn(`[filestoreSync] post-create refetch failed:`, refetchErr);
          }
        } else {
          // No ID in response, clear the cache sentinel
          orgCache.delete(remoteName);
        }
      } catch (e) {
        console.warn(`[filestoreSync] Failed to create ${remoteName}:`, e);
        // Clear the cache sentinel on error
        orgCache.delete(remoteName);
      }
    }
  } catch (e) {
    console.warn(`[filestoreSync] Error during auto-create phase:`, e);
  }

  // After creating collections, re-resolve to pick up any existing files and get the newly created collections
  // The initial resolve only finds what was on remote before we created the defaults
  try {
    console.log(`[filestoreSync] re-resolving after collection creation...`);
    const refreshedCollections = await resolveProjectFilestores(creds);
    console.log("[filestoreSync] refreshed collections after creation", refreshedCollections);
    collections = refreshedCollections; // Update with the fresh list
    update({ collections });
  } catch (e) {
    console.warn(`[filestoreSync] re-resolve after creation failed:`, e);
    // Continue with what we have - created collections are already in the array
  }

  resolvedRepos.add(repo);

  // Pre-multi-collection code wrote the first collection's id to a
  // top-level collection_id/collection_name field. With the nested
  // per-collection manifest the top-level fields are obsolete; writing
  // them re-corrupts the format and forces every adapter through the
  // migration path on the next load. Don't touch the manifest here —
  // each adapter loads/saves its own slot via loadCollectionManifest /
  // saveCollectionManifest.

  if (collections.length > 0) {
    // Sync all collections, not just the first one
    for (const collection of collections) {
      console.log(`[filestoreSync] starting pull for collection: ${collection.name} (id: ${collection.id})`);
      const adapter = filestoreAdapter({ creds, collection });
      activePrefixes.add(adapter.prefix);
      try {
        console.log(`[filestoreSync] calling runPull for ${collection.name}...`);
        const result = await runPull({ repo, adapter, collectionId: collection.id });
        console.log(`[filestoreSync] runPull completed for ${collection.name}: ${result.downloaded}/${result.total} files`);
      } catch (e) {
        console.error(`[filestoreSync] initial pull failed for ${collection.name}:`, e);
      }

      console.log(`[filestoreSync] starting polling for ${collection.name}...`);
      stopPolls.push(startPolling(adapter, repo, {
        onPhase: (phase) => {
          console.log(`[filestoreSync] poll phase for ${collection.name}: ${phase}`);
          if (phase === "pulling") update({ phase: "pulling" });
        },
        onResult: (r) => {
          console.log(`[filestoreSync] poll result for ${collection.name}: ${r.pulled} pulled, ${r.remoteCount} remote, ${r.conflicts.length} conflicts`);
          conflictsByCollection.set(
            collection.id,
            r.conflicts.map((c) => ({
              filename: c.manifestKey,
              reason: "local-and-remote-changed",
            })),
          );
          update({
            phase: "ready",
            conflicts: flattenConflicts(),
            lastPullAt: Date.now(),
            lastError: null,
          });
        },
        onError: (e) => {
          console.error(`[filestoreSync] poll failed for ${collection.name}:`, e);
          update({ phase: "error", lastError: String(e) });
        },
      }));
    }
  } else {
    console.log(`[filestoreSync] no collections to sync`);
    update({ phase: "ready" });
  }
}

export function stopFilestoreSync() {
  for (const stop of stopPolls) stop();
  stopPolls = [];
  conflictsByCollection.clear();
  // Clear each adapter's contribution to the engine's conflict aggregate.
  // Pre-fix this called clearConflictsForPrefix("filestore"), but the
  // actual prefixes are filestores/<folder> so the call cleared nothing.
  for (const prefix of activePrefixes) clearConflictsForPrefix(prefix);
  activePrefixes.clear();
  update({
    phase: "idle",
    collections: [],
    conflicts: [],
    lastError: null,
  });
  resolvedRepos.clear();
}

/// Manual single-shot pull. Used by Shell.tsx's ↻ button and the modal
/// connect flow. Goes through the engine's per-repo lock.
///
/// Always resolves — never rejects — to match the pre-engine contract.
/// Failures are conveyed via the `ok` field (and getFilestoreSyncStatus()
/// for phase). Pre-push guard callers should check `ok === true`
/// before treating a zero-conflict result as "safe to push".
export async function pullOnce(args: {
  creds: PinkfishCreds;
  repo: string;
  collection: FilestoreCollection;
}): Promise<{
  ok: boolean;
  error?: string;
  downloaded: number;
  total: number;
}> {
  const adapter = filestoreAdapter({ creds: args.creds, collection: args.collection });
  try {
    const r = await runPull({ repo: args.repo, adapter, collectionId: args.collection.id });
    return { ok: true, ...r };
  } catch (e) {
    console.error("[filestoreSync] pullOnce failed:", e);
    return { ok: false, error: String(e), downloaded: 0, total: 0 };
  }
}

/// Push all local filestore files to the remote collection. Called by the
/// Sync tab's commit handler. Serializes against pull on the engine lock.
export async function pushAllToFilestore(args: {
  creds: PinkfishCreds;
  repo: string;
  collection: FilestoreCollection;
  onLine?: (msg: string) => void;
}): Promise<{ pushed: number; failed: number }> {
  return withRepoLock(args.repo, "filestore", () =>
    pushAllToFilestoreInner(args),
  );
}

async function pushAllToFilestoreInner(args: {
  creds: PinkfishCreds;
  repo: string;
  collection: FilestoreCollection;
  onLine?: (msg: string) => void;
}): Promise<{ pushed: number; failed: number }> {
  const { creds, repo, collection, onLine } = args;
  update({ phase: "pushing" });

  const token = getToken();
  if (!token) {
    onLine?.("x filestore push: not authenticated");
    update({ phase: "ready" });
    return { pushed: 0, failed: 0 };
  }
  const urls = derivedUrls(creds.tokenUrl);

  // Each collection has its own local subdir AND its own manifest entry.
  // The pre-multi-collection version listed from the hardcoded
  // filestores/library and shared one manifest, so dropping a file in
  // library would result in it being uploaded to every other collection
  // (replication bug) and tracked as if every collection had it.
  const dir = collectionLocalDir(collection.name);
  const local = await entityListLocal(repo, dir);
  const persisted = await loadCollectionManifest(repo, "fs", collection.id);

  // Sibling-aware shadow exclusion. Pass the full filename set; see
  // classifyAsShadow doc for why pre-filtering is wrong.
  const siblings = new Set(local.map((f) => f.filename));
  const toPush = local.filter((f) => {
    if (classifyAsShadow(f.filename, siblings)) return false;
    const tracked = persisted.files[f.filename];
    if (!tracked) return true;
    if (f.mtime_ms == null) return true;
    return f.mtime_ms > tracked.pulled_at_mtime_ms;
  });

  if (toPush.length === 0) {
    onLine?.(`filestore push (${collection.name}): nothing new to upload`);
    update({ phase: "ready" });
    return { pushed: 0, failed: 0 };
  }

  let pushed = 0;
  let failed = 0;
  const pushedNames = new Set<string>();

  for (const f of toPush) {
    try {
      onLine?.(`uploading ${dir}/${f.filename}`);
      const result = await fsStoreUploadFile({
        repo,
        filename: f.filename,
        collectionId: collection.id,
        skillsBaseUrl: urls.skillsBaseUrl,
        accessToken: token.accessToken,
        // Read from THIS collection's subdir, not the legacy library dir.
        subdir: dir,
      });
      // The skills API may sanitize filenames on upload (spaces become
      // dashes, etc.). When that happens, rename the local file to
      // match the server's canonical name so the next pull doesn't
      // download the sanitized version as a "new" file alongside the
      // original. Pre-fix: dropping `Foo Bar.png` left both
      // `Foo Bar.png` and `Foo-Bar.png` in the local folder forever.
      let canonical = f.filename;
      if (
        result?.filename &&
        result.filename !== f.filename &&
        !result.filename.includes("/") &&
        !result.filename.includes("\\")
      ) {
        try {
          const { entityRenameFile } = await import("./api");
          await entityRenameFile(repo, dir, f.filename, result.filename);
          onLine?.(
            `  renamed locally: ${f.filename} → ${result.filename}`,
          );
          canonical = result.filename;
        } catch (renameErr) {
          console.warn(
            `[filestoreSync] rename ${f.filename}→${result.filename} failed:`,
            renameErr,
          );
          // Fall through using the original name; the next pull will
          // download the sanitized version as a duplicate. Logged so
          // the surface is visible during BugBot review.
        }
      }
      persisted.files[canonical] = {
        remote_version: new Date().toISOString(),
        pulled_at_mtime_ms: f.mtime_ms ?? Date.now(),
      };
      pushedNames.add(canonical);
      pushed += 1;
    } catch (e) {
      failed += 1;
      onLine?.(`x ${dir}/${f.filename}: ${String(e)}`);
    }
  }

  // Reconcile remote_version after push, same pattern as KB.
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
      console.warn("filestore post-push remote-version sync failed:", e);
    }
  }

  await saveCollectionManifest(
    repo,
    "fs",
    collection.id,
    collection.name,
    persisted,
  );
  update({ phase: "ready" });
  return { pushed, failed };
}
