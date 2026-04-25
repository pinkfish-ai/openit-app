import {
  getCollection,
  listItems,
  type DataCollection,
  type MemoryBqueryResponse,
  type MemoryItem,
} from "./skillsApi";
import { entityWriteFile } from "./api";
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

const PREFIX = "openit-";

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
      // Update cache with verified collections from API
      for (const m of matching) {
        orgCache.set(m.name, m);
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
    setLastCreationTime(creds.orgId, now);
    for (const def of defaults) {
      // Check if we recently created this collection to avoid duplicates
      if (orgCache.has(def.name)) {
        const col = orgCache.get(def.name)!;
        matching.push(col);
        continue;
      }

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
          // 409 means collection already exists, skip it
          if (createResponse.status === 409) {
            console.log(`[datastoreSync] collection ${def.name} already exists`);
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
        
        // Check for id in different possible formats
        const id = createResult?.id || createResult?.data?.id || createResult?.collection?.id;
        if (id) {
          const col = {
            id: String(id),
            name: def.name,
            type: "datastore",
            description: def.description,
          } as DataCollection;
          matching.push(col);
          orgCache.set(def.name, col);
          console.log(`[datastoreSync] cached ${def.name} with id: ${id}`);
        } else {
          console.warn(`[datastoreSync] no id found in response for ${def.name}. Response keys:`, Object.keys(createResult || {}));
        }
      } catch (e) {
        console.warn(`[datastoreSync] failed to create ${def.name}:`, e);
      }
    }

    // After creation, re-fetch to ensure we have the authoritative list
    if (matching.length > 0) {
      try {
        // Wait for API eventual consistency (collections take ~5 seconds to appear)
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
        if (updatedMatching.length > matching.length) {
          console.log("[datastoreSync] re-fetched collections after creation");
          return updatedMatching;
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
