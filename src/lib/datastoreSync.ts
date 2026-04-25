import {
  getCollection,
  listItems,
  type DataCollection,
  type MemoryBqueryResponse,
  type MemoryItem,
} from "./skillsApi";
import { entityWriteFile, fsList, fsRead } from "./api";
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
    let localFiles: { key: string; absPath: string }[] = [];
    try {
      const nodes = await fsList(colDir);
      localFiles = nodes
        .filter(
          (n) =>
            !n.is_dir &&
            n.name.endsWith(".json") &&
            n.name !== "_schema.json",
        )
        .map((n) => ({ key: n.name.replace(/\.json$/, ""), absPath: n.path }));
    } catch {
      // Collection dir doesn't exist locally yet — nothing to push, but we
      // still process deletions below if there are remote items left.
      localFiles = [];
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
  }

  return { pushed: totalPushed, failed: totalFailed };
}
