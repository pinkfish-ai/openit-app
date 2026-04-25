import {
  getCollection,
  listItems,
  type DataCollection,
  type MemoryBqueryResponse,
  type MemoryItem,
} from "./skillsApi";
import {
  datastoreListLocal,
  datastoreStateLoad,
  datastoreStateSave,
  entityWriteFile,
  fsList,
  fsRead,
  gitCommitPaths,
  type KbStatePersisted,
} from "./api";
import { derivedUrls, getToken, type PinkfishCreds } from "./pinkfishAuth";
import { makeSkillsFetch } from "../api/fetchAdapter";

// Type definitions for API responses
type CreateCollectionResponse = {
  message?: string;
  id?: string | number;
  schema?: Record<string, unknown>;
  isStructured?: boolean;
  [key: string]: unknown;
};

type ListCollectionsResponse = DataCollection[] | null;

const DEFAULT_DATASTORES = [
  {
    name: "openit-tickets",
    templateId: "case-management",
    description: "IT ticket tracking",
  },
  {
    name: "openit-people",
    templateId: "contacts",
    description: "Contact/people directory",
  },
];

// Org-scoped cache to prevent collections from one org leaking into another
let createdCollections = new Map<string, Map<string, DataCollection>>();
let lastCreationAttemptTime = new Map<string, number>();

// Per-org in-flight resolve promise — concurrent callers share the same operation
// so we never race two list-then-create sequences against each other.
const inflightResolve = new Map<string, Promise<DataCollection[]>>();

/**
 * Get or create org-specific cache for created collections.
 */
function getOrgCache(orgId: string): Map<string, DataCollection> {
  if (!createdCollections.has(orgId)) {
    createdCollections.set(orgId, new Map());
  }
  return createdCollections.get(orgId)!;
}

/**
 * Get the last creation attempt time for an org (default 0 if never attempted).
 */
function getLastCreationTime(orgId: string): number {
  return lastCreationAttemptTime.get(orgId) ?? 0;
}

/**
 * Update the last creation attempt time for an org.
 */
function setLastCreationTime(orgId: string, time: number): void {
  lastCreationAttemptTime.set(orgId, time);
}

/**
 * Find or create openit-* Datastore collections. Creates defaults if none
 * exist. Uses the skills REST API (GET /datacollection/?type=datastore).
 */
const CREATION_COOLDOWN_MS = 10_000; // 10 seconds — allow time for API eventual consistency
export async function resolveProjectDatastores(
  creds: PinkfishCreds,
  onLog?: (msg: string) => void,
): Promise<DataCollection[]> {
  const existing = inflightResolve.get(creds.orgId);
  if (existing) {
    console.log("[datastoreSync] joining in-flight resolve for org:", creds.orgId);
    return existing;
  }
  const promise = resolveProjectDatastoresImpl(creds, onLog);
  inflightResolve.set(creds.orgId, promise);
  try {
    return await promise;
  } finally {
    inflightResolve.delete(creds.orgId);
  }
}

async function resolveProjectDatastoresImpl(
  creds: PinkfishCreds,
  onLog?: (msg: string) => void,
): Promise<DataCollection[]> {
  console.log("[datastoreSync] resolveProjectDatastores called for org:", creds.orgId);
  const token = getToken();
  if (!token) throw new Error("not authenticated");
  const urls = derivedUrls(creds.tokenUrl);

  try {
    // Use REST API for listing
    const fetchFn = makeSkillsFetch(token.accessToken);
    const url = new URL("/datacollection/", urls.skillsBaseUrl);
    url.searchParams.set("type", "datastore");
    console.log("[datastoreSync] Fetching from:", url.toString());
    const response = await fetchFn(url.toString());
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = (await response.json()) as DataCollection[] | null;
    const allCollections = Array.isArray(result) ? result : [];
    console.log(`[datastoreSync] ✓ Found ${allCollections.length} datastore collections`);
    allCollections.forEach((c: DataCollection) => console.log(`  • ${c.name} (id: ${c.id})`));
    const defaults = DEFAULT_DATASTORES.map((d) => ({
      ...d,
      name: `${d.name}-${creds.orgId}`,
    }));
    let matching = allCollections.filter((c: DataCollection) => defaults.some((d) => d.name === c.name));
    console.log(`[datastoreSync] ✓ Matching default collections: ${matching.length}`);

    // Get org-specific cache
    const orgCache = getOrgCache(creds.orgId);

    // If list returned matching collections, we're done
    if (matching.length > 0) {
      for (const m of matching) {
        orgCache.set(m.name, m);
        onLog?.(`  ✓ ${m.name}  (id: ${m.id})`);
      }
      return matching;
    }

    // List is empty - check if we recently created collections
    // Only return cache if we attempted creation recently (within cooldown)
    const now = Date.now();
    const lastCreationTime = getLastCreationTime(creds.orgId);
    if (orgCache.size > 0 && (now - lastCreationTime < CREATION_COOLDOWN_MS)) {
      console.log("[datastoreSync] collections not yet visible in API list, returning cached collections");
      return Array.from(orgCache.values());
    }

    // Nothing in API, and either no cache or cache is stale - try creating
    if (now - lastCreationTime < CREATION_COOLDOWN_MS) {
      console.log("[datastoreSync] skipping creation (cooldown active)");
      return Array.from(orgCache.values());
    }

    console.log("[datastoreSync] no openit-* datastores found — creating defaults");
    // API says nothing matches and we're past the eventual-consistency window —
    // any cached entries are stale. Wipe before creating so we actually POST.
    orgCache.clear();
    setLastCreationTime(creds.orgId, now);
    let conflictHit = false;
    for (const def of defaults) {
      try {
        const createUrl = new URL("/datacollection/", urls.skillsBaseUrl);
        const createResponse = await fetchFn(createUrl.toString(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: def.name,
            type: "datastore",
            templateId: def.templateId,
            description: def.description,
            createdBy: creds.orgId,
            createdByName: "OpenIT",
            triggerUrls: [],
            isStructured: true,
          }),
        });

        console.log(`[datastoreSync] POST /datacollection/ response status: ${createResponse.status} ${createResponse.statusText}`);

        if (!createResponse.ok) {
          const errText = await createResponse.text();
          console.error("[datastoreSync] response error:", errText);
          // 409 means the list was stale and the collection actually exists —
          // force a refetch so we grab the authoritative id.
          if (createResponse.status === 409) {
            console.log(`[datastoreSync] collection ${def.name} already exists (409) — will refetch`);
            conflictHit = true;
            continue;
          }
          throw new Error(`HTTP ${createResponse.status}: ${createResponse.statusText}`);
        }

        let createResult: CreateCollectionResponse | null;
        try {
          createResult = (await createResponse.json()) as CreateCollectionResponse | null;
        } catch (e) {
          console.error("[datastoreSync] failed to parse create response JSON:", e);
          throw new Error(`Failed to parse collection creation response: ${e}`);
        }

        console.log(`[datastoreSync] create response for ${def.name}:`, JSON.stringify(createResult));

        const idAny = createResult?.id as string | number | undefined;
        const id = idAny != null ? String(idAny) : undefined;
        if (id) {
          const col = {
            id,
            name: def.name,
            type: "datastore",
            description: def.description,
          } as DataCollection;
          matching.push(col);
          orgCache.set(def.name, col);
          console.log(`[datastoreSync] cached ${def.name} with id: ${id}`);
          onLog?.(`  + ${def.name}  (id: ${id})  [created]`);
        } else {
          console.warn(`[datastoreSync] no id found in response for ${def.name}. Response keys:`, Object.keys(createResult || {}));
        }
      } catch (e) {
        console.warn(`[datastoreSync] failed to create ${def.name}:`, e);
      }
    }

    // Refetch authoritatively whenever we touched the create path — handles
    // eventual consistency, 409 conflicts (list was stale), and concurrent
    // creators. Always prefer refetch as the source of truth.
    if (matching.length > 0 || conflictHit) {
      try {
        await new Promise(resolve => setTimeout(resolve, 5000));

        const refetchUrl = new URL("/datacollection/", urls.skillsBaseUrl);
        refetchUrl.searchParams.set("type", "datastore");
        const refetchResponse = await fetchFn(refetchUrl.toString());

        let refetchResult: ListCollectionsResponse;
        try {
          refetchResult = (await refetchResponse.json()) as ListCollectionsResponse;
        } catch (e) {
          console.error("[datastoreSync] failed to parse refetch response JSON:", e);
          throw new Error(`Failed to parse refetch response: ${e}`);
        }

        const refetched = Array.isArray(refetchResult) ? refetchResult : [];
        const updatedMatching = refetched.filter((c: DataCollection) => defaults.some((d) => d.name === c.name));
        if (updatedMatching.length >= matching.length && updatedMatching.length > 0) {
          console.log("[datastoreSync] re-fetched collections after creation");
          for (const m of updatedMatching) orgCache.set(m.name, m);
          return updatedMatching;
        }
        if (conflictHit && matching.length === 0) {
          console.warn("[datastoreSync] 409 conflict but refetch still returned no matches — API may be lagging");
        }
      } catch (e) {
        console.warn("[datastoreSync] failed to re-fetch after creation:", e);
      }
    }

    return matching;
  } catch (error) {
    console.log("----END DATASTORE SYNC (error)----");
    console.error("[datastoreSync] resolveProjectDatastores failed:", error);
    throw error;
  }
}

/**
 * Convenience wrapper for listing items in a datastore collection with pagination.
 */
export async function fetchDatastoreItems(
  creds: PinkfishCreds,
  collectionId: string,
  limit?: number,
  offset?: number,
): Promise<MemoryBqueryResponse> {
  const token = getToken();
  if (!token) throw new Error("not authenticated");
  const urls = derivedUrls(creds.tokenUrl);

  return listItems(urls.skillsBaseUrl, token.accessToken, collectionId, limit, offset);
}

export async function fetchDatastoreSchema(
  creds: PinkfishCreds,
  collectionId: string,
): Promise<any> {
  const token = getToken();
  if (!token) throw new Error("not authenticated");
  const urls = derivedUrls(creds.tokenUrl);

  const collection = await getCollection(urls.skillsBaseUrl, token.accessToken, collectionId);
  return collection.schema;
}

export async function syncDatastoresToDisk(
  repo: string,
  collections: DataCollection[],
  itemsByCollection: Record<string, { items: MemoryItem[]; hasMore: boolean }>,
): Promise<void> {
  for (const col of collections) {
    const subdir = `databases/${col.name}`;
    // Write/overwrite — don't clear first to avoid empty-dir flash
    // Write schema
    if (col.schema) {
      await entityWriteFile(repo, subdir, "_schema.json", JSON.stringify(col.schema, null, 2));
    }
    // Write each row
    const data = itemsByCollection[col.id];
    if (data) {
      for (const item of data.items) {
        const filename = (item.key || item.id) + ".json";
        const content = typeof item.content === "object"
          ? JSON.stringify(item.content, null, 2)
          : item.content;
        await entityWriteFile(repo, subdir, filename, content);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Push — upload locally edited datastore rows back to Pinkfish.
// Called by the Sync tab's commit handler.
// ---------------------------------------------------------------------------

type PushResult = { pushed: number; failed: number };

/**
 * Loose deep-equal for JSON-shaped data — used to skip upload when local
 * content already matches remote. Stringify with sorted keys for stability.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

/**
 * Push local datastore rows to Pinkfish for every openit-* collection.
 *
 * Strategy: full reconcile per collection.
 *   - For each local file (databases/<col>/<key>.json, excluding _schema.json):
 *     - if remote has matching key + same content → skip
 *     - if remote has matching key + different content → PUT /memory/items/{id}
 *     - if remote has no matching key → POST /memory/items?collectionId=...
 *   - For each remote item without a corresponding local file → DELETE.
 *
 * No manifest yet — content equality + key matching is the v1 approach.
 * The bigger sync-engine plan replaces this with git-ref + content-hash diff.
 */
export async function pushAllToDatastores(args: {
  creds: PinkfishCreds;
  repo: string;
  onLine?: (line: string) => void;
}): Promise<PushResult> {
  const { creds, repo, onLine } = args;
  const token = getToken();
  if (!token) {
    onLine?.("✗ datastore push: not authenticated");
    return { pushed: 0, failed: 0 };
  }
  const urls = derivedUrls(creds.tokenUrl);
  const fetchFn = makeSkillsFetch(token.accessToken);

  const collections = await resolveProjectDatastores(creds);
  if (collections.length === 0) {
    onLine?.("▸ datastore push: no openit-* collections — nothing to push");
    return { pushed: 0, failed: 0 };
  }

  let totalPushed = 0;
  let totalFailed = 0;

  for (const col of collections) {
    const colDir = `${repo}/databases/${col.name}`;

    // 1. Remote items keyed by their `key`.
    let remote: MemoryItem[];
    try {
      const resp = await fetchDatastoreItems(creds, col.id, 1000, 0);
      remote = resp.items;
    } catch (e) {
      onLine?.(`✗ datastore: list ${col.name} failed: ${String(e)}`);
      totalFailed += 1;
      continue;
    }
    const remoteByKey = new Map<string, MemoryItem>();
    for (const r of remote) {
      const k = (r.key ?? r.id ?? "").toString();
      if (k) remoteByKey.set(k, r);
    }

    // 2. Local files (flat, .json, exclude _schema.json).
    // Track whether the directory actually exists. If `fsList` throws
    // because the directory doesn't exist yet (e.g. user committed a KB
    // file before the initial datastore pull ran), an empty `localFiles`
    // does NOT mean "user deleted everything" — we have no signal to act
    // on. Skip the deletion phase entirely in that case so we don't nuke
    // remote rows.
    let localFiles: { key: string; absPath: string }[] = [];
    let localDirExists = true;
    try {
      const nodes = await fsList(colDir);
      localFiles = nodes
        .filter(
          (n) =>
            !n.is_dir &&
            n.name.endsWith(".json") &&
            n.name !== "_schema.json" &&
            // Exclude conflict shadow files — they're not real rows; pushing
            // them would create junk items with keys like `<key>.server` on
            // the remote.
            !n.name.includes(".server."),
        )
        .map((n) => ({ key: n.name.replace(/\.json$/, ""), absPath: n.path }));
    } catch {
      localDirExists = false;
    }
    const localKeys = new Set(localFiles.map((f) => f.key));

    // 3. Push local → remote (POST new, PUT changed, skip unchanged).
    for (const { key, absPath } of localFiles) {
      let parsed: unknown;
      try {
        const raw = await fsRead(absPath);
        parsed = JSON.parse(raw);
      } catch (e) {
        onLine?.(`✗ datastore: ${col.name}/${key}.json — invalid JSON: ${String(e)}`);
        totalFailed += 1;
        continue;
      }

      const existing = remoteByKey.get(key);
      try {
        if (!existing) {
          const url = new URL("/memory/items", urls.skillsBaseUrl);
          url.searchParams.set("collectionId", col.id);
          const resp = await fetchFn(url.toString(), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ key, content: parsed }),
          });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
          onLine?.(`  + ${col.name}/${key}.json (created)`);
          totalPushed += 1;
        } else if (!jsonEqual(parsed, existing.content)) {
          const url = new URL(`/memory/items/${encodeURIComponent(existing.id)}`, urls.skillsBaseUrl);
          url.searchParams.set("collectionId", col.id);
          const resp = await fetchFn(url.toString(), {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: parsed }),
          });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
          onLine?.(`  ✓ ${col.name}/${key}.json (updated)`);
          totalPushed += 1;
        }
        // else: content matches, skip silently.
      } catch (e) {
        onLine?.(`✗ datastore: ${col.name}/${key}.json — ${String(e)}`);
        totalFailed += 1;
      }
    }

    // 4. Delete remote items that no longer have a local file.
    // SAFETY: only run this if the local collection dir actually exists.
    // Otherwise an empty `localKeys` would be interpreted as "user deleted
    // everything" and we'd nuke every remote row — which would happen on
    // the very first commit if the datastore pull hadn't completed yet.
    if (localDirExists) {
      for (const r of remote) {
        const k = (r.key ?? r.id ?? "").toString();
        if (!k || localKeys.has(k)) continue;
        try {
          const url = new URL(
            `/memory/items/id/${encodeURIComponent(r.id)}`,
            urls.skillsBaseUrl,
          );
          url.searchParams.set("collectionId", col.id);
          const resp = await fetchFn(url.toString(), { method: "DELETE" });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
          onLine?.(`  − ${col.name}/${k}.json (deleted on remote)`);
          totalPushed += 1;
        } catch (e) {
          onLine?.(`✗ datastore: delete ${col.name}/${k} — ${String(e)}`);
          totalFailed += 1;
        }
      }
    } else {
      onLine?.(`▸ datastore: ${col.name} has no local dir yet — skipping deletion phase`);
    }
  }

  return { pushed: totalPushed, failed: totalFailed };
}

// ---------------------------------------------------------------------------
// Pull — 60s background poll for remote datastore changes.
// Mirrors startKbSync/startFilestoreSync. Per-row diff via manifest:
// remote.updatedAt vs manifest.remote_version + local mtime vs
// manifest.pulled_at_mtime_ms. Conflict drops a `<key>.server.json` shadow
// next to the local file so Claude or the user can merge.
// ---------------------------------------------------------------------------

export type DatastoreConflict = {
  collectionName: string;
  key: string;
  reason: "local-and-remote-changed";
};

export type DatastoreSyncStatus = {
  phase: "idle" | "resolving" | "pulling" | "ready" | "error";
  collections: DataCollection[];
  conflicts: DatastoreConflict[];
  lastError: string | null;
  lastPullAt: number | null;
};

let datastoreStatus: DatastoreSyncStatus = {
  phase: "idle",
  collections: [],
  conflicts: [],
  lastError: null,
  lastPullAt: null,
};
const datastoreListeners = new Set<(s: DatastoreSyncStatus) => void>();

export function subscribeDatastoreSync(
  fn: (s: DatastoreSyncStatus) => void,
): () => void {
  datastoreListeners.add(fn);
  fn(datastoreStatus);
  return () => datastoreListeners.delete(fn);
}

function updateDatastoreStatus(patch: Partial<DatastoreSyncStatus>): void {
  datastoreStatus = { ...datastoreStatus, ...patch };
  for (const l of datastoreListeners) l(datastoreStatus);
}

function shadowName(key: string): string {
  return `${key}.server.json`;
}

function manifestKey(collectionName: string, key: string): string {
  return `${collectionName}/${key}`;
}

let datastorePollTimer: ReturnType<typeof setInterval> | null = null;
const DATASTORE_POLL_INTERVAL_MS = 60_000;

/**
 * Run one pull pass across every openit-* datastore collection. Diffs each
 * remote row against the local manifest + working tree; writes new/changed
 * rows; drops conflict shadows for both-changed rows. Auto-commits the
 * touched paths so `git status` stays clean and the Sync tab reflects the
 * pull as a single `sync: pull @ <ts>` commit (matching KB/filestore).
 */
export async function pullDatastoresOnce(args: {
  creds: PinkfishCreds;
  repo: string;
}): Promise<{ pulled: number; conflicts: DatastoreConflict[] }> {
  const { creds, repo } = args;
  updateDatastoreStatus({ phase: "pulling" });

  let collections: DataCollection[];
  try {
    collections = await resolveProjectDatastores(creds);
  } catch (e) {
    updateDatastoreStatus({ phase: "error", lastError: String(e) });
    return { pulled: 0, conflicts: [] };
  }
  updateDatastoreStatus({ collections });

  const persisted: KbStatePersisted = await datastoreStateLoad(repo);
  const conflicts: DatastoreConflict[] = [];
  const touched: string[] = [];
  let pulled = 0;

  for (const col of collections) {
    let remote: MemoryItem[];
    try {
      const resp = await fetchDatastoreItems(creds, col.id, 1000, 0);
      remote = resp.items;
    } catch (e) {
      console.error(`[datastoreSync] list ${col.name} failed:`, e);
      continue;
    }

    let local: { filename: string; mtime_ms: number | null }[];
    try {
      local = await datastoreListLocal(repo, col.name);
    } catch {
      local = [];
    }
    const localByName = new Map(local.map((f) => [f.filename, f]));

    for (const r of remote) {
      const key = (r.key ?? r.id ?? "").toString();
      if (!key) continue;
      const filename = `${key}.json`;
      const mKey = manifestKey(col.name, key);
      const tracked = persisted.files[mKey];
      const localFile = localByName.get(filename);
      const remoteVer = r.updatedAt ?? "";
      const subdir = `databases/${col.name}`;

      const writeRow = async () => {
        const content = typeof r.content === "object"
          ? JSON.stringify(r.content, null, 2)
          : (r.content as unknown as string);
        await entityWriteFile(repo, subdir, filename, content);
        persisted.files[mKey] = {
          remote_version: remoteVer,
          pulled_at_mtime_ms: Date.now(),
        };
        touched.push(`${subdir}/${filename}`);
        pulled += 1;
      };

      if (!tracked && !localFile) {
        // New remote row — pull.
        try {
          await writeRow();
        } catch (e) {
          console.error(`[datastoreSync] write ${mKey} failed:`, e);
        }
        continue;
      }

      if (tracked && localFile) {
        const remoteChanged = remoteVer !== "" && remoteVer !== tracked.remote_version;
        const localChanged =
          localFile.mtime_ms != null && localFile.mtime_ms > tracked.pulled_at_mtime_ms;

        if (remoteChanged && localChanged) {
          // Both moved — drop a shadow with the remote content for merge.
          // Only WRITE the shadow on the first detection: if a shadow file
          // is already present, the conflict is unresolved from a prior
          // pass and re-writing it would re-touch + re-commit on every
          // poll. We still report the conflict every cycle for the banner.
          // (Matches the KB pattern in kbSync's pullOnce.)
          const shadowFilename = shadowName(key);
          const hasShadow = localByName.has(shadowFilename);
          if (!hasShadow) {
            try {
              const content = typeof r.content === "object"
                ? JSON.stringify(r.content, null, 2)
                : (r.content as unknown as string);
              await entityWriteFile(repo, subdir, shadowFilename, content);
              touched.push(`${subdir}/${shadowFilename}`);
            } catch (e) {
              console.error(`[datastoreSync] shadow ${mKey} failed:`, e);
            }
          }
          conflicts.push({
            collectionName: col.name,
            key,
            reason: "local-and-remote-changed",
          });
          continue;
        }
        if (remoteChanged && !localChanged) {
          try {
            await writeRow();
          } catch (e) {
            console.error(`[datastoreSync] write ${mKey} failed:`, e);
          }
        }
        // else: nothing to do.
        continue;
      }

      // tracked but file missing locally → user/Claude deleted; leave alone.
      // (push handles the delete on the next commit.)
    }

    // Detect server-side deletions: anything tracked for this collection
    // that's NOT in the remote response — server deleted. We do NOT delete
    // the local file (user might still want it); we just drop the manifest
    // entry so a subsequent push doesn't try to re-create from stale state.
    const remoteKeys = new Set(remote.map((r) => (r.key ?? r.id ?? "").toString()));
    for (const mKey of Object.keys(persisted.files)) {
      if (!mKey.startsWith(`${col.name}/`)) continue;
      const key = mKey.slice(col.name.length + 1);
      if (remoteKeys.has(key)) continue;
      // Don't delete the local file (push semantics handle that). Just drop
      // the manifest entry so the row is no longer "tracked".
      delete persisted.files[mKey];
    }
  }

  await datastoreStateSave(repo, persisted);

  if (touched.length > 0) {
    try {
      const ts = new Date().toISOString();
      await gitCommitPaths(repo, touched, `sync: pull @ ${ts}`);
    } catch (e) {
      console.warn("[datastoreSync] git commit after pull failed:", e);
    }
  }

  updateDatastoreStatus({
    phase: "ready",
    conflicts,
    lastPullAt: Date.now(),
    lastError: null,
  });

  return { pulled, conflicts };
}

/**
 * Begin background datastore sync — initial pull + 60s poll. Idempotent;
 * subsequent calls clear and restart the timer.
 */
export async function startDatastoreSync(args: {
  creds: PinkfishCreds;
  repo: string;
}): Promise<void> {
  const { creds, repo } = args;
  if (datastorePollTimer) {
    clearInterval(datastorePollTimer);
    datastorePollTimer = null;
  }

  updateDatastoreStatus({ phase: "resolving", lastError: null });

  await pullDatastoresOnce({ creds, repo }).catch((e) => {
    console.error("[datastoreSync] initial pull failed:", e);
    updateDatastoreStatus({ phase: "error", lastError: String(e) });
  });

  datastorePollTimer = setInterval(() => {
    pullDatastoresOnce({ creds, repo }).catch((e) =>
      console.error("[datastoreSync] poll failed:", e),
    );
  }, DATASTORE_POLL_INTERVAL_MS);
}

export function stopDatastoreSync(): void {
  if (datastorePollTimer) {
    clearInterval(datastorePollTimer);
    datastorePollTimer = null;
  }
  updateDatastoreStatus({
    phase: "idle",
    collections: [],
    conflicts: [],
    lastError: null,
  });
}
