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

let createdCollections = new Map<string, DataCollection>();

/**
 * Find or create openit-* Datastore collections. Creates defaults if none
 * exist. Uses the skills REST API (GET /datacollection/all).
 */
let lastCreationAttemptTime = 0;
const CREATION_COOLDOWN_MS = 10_000; // 10 seconds — allow time for API eventual consistency
export async function resolveProjectDatastores(
  creds: PinkfishCreds,
): Promise<DataCollection[]> {
  console.log("[datastoreSync] resolveProjectDatastores called");
  const token = getToken();
  if (!token) throw new Error("not authenticated");
  const urls = derivedUrls(creds.tokenUrl);

  try {
    // Use REST API for listing (GET works, MCP tool returns 0)
    const fetchFn = makeSkillsFetch(token.accessToken);
    const url = new URL("/datacollection/", urls.skillsBaseUrl);
    url.searchParams.set("type", "datastore");
    console.log("[datastoreSync] Fetching from:", url.toString(), "base:", urls.skillsBaseUrl);
    const response = await fetchFn(url.toString());
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = (await response.json()) as DataCollection[] | null;
    const allCollections = Array.isArray(result) ? result : [];
    console.log(`[datastoreSync] list_collections returned ${allCollections.length} datastore collections`);
    allCollections.forEach((c: DataCollection) => console.log(`  - ${c.name} (id: ${c.id})`));
    const defaults = DEFAULT_DATASTORES.map((d) => ({
      ...d,
      name: `${d.name}-${creds.orgId}`,
    }));
    let matching = allCollections.filter((c: DataCollection) => defaults.some((d) => d.name === c.name));

    // If list returned nothing, check our in-memory cache of recently created collections
    if (matching.length === 0 && createdCollections.size > 0) {
      console.log(`[datastoreSync] using ${createdCollections.size} recently created collections`);
      matching = Array.from(createdCollections.values());
    }

    if (matching.length === 0) {
      const now = Date.now();
      // Skip creation if we tried recently (eventual consistency delay)
      if (now - lastCreationAttemptTime < CREATION_COOLDOWN_MS) {
        console.log("[datastoreSync] skipping creation (cooldown active), using cached collections");
        return Array.from(createdCollections.values());
      }
      
      console.log("[datastoreSync] no openit-* datastores found — creating defaults");
      lastCreationAttemptTime = now;
      for (const def of defaults) {
        // Check if we recently created this collection to avoid duplicates
        if (createdCollections.has(def.name)) {
          const col = createdCollections.get(def.name)!;
          matching.push(col);
          continue;
        }

        try {
          const fetchFn = makeSkillsFetch(token.accessToken);
          const url = new URL("/datacollection/", urls.skillsBaseUrl);
          const response = await fetchFn(url.toString(), {
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
          
          console.log(`[datastoreSync] POST /datacollection/ response status: ${response.status} ${response.statusText}`);
          
          if (!response.ok) {
            const errText = await response.text();
            console.error("[datastoreSync] response error:", errText);
            // 409 means collection already exists, skip it
            if (response.status === 409) {
              console.log(`[datastoreSync] collection ${def.name} already exists`);
              continue;
            }
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }

          const result = (await response.json()) as any;
          console.log(`[datastoreSync] create response for ${def.name}:`, JSON.stringify(result));
          
          // Check for id in different possible formats
          const id = result?.id || result?.data?.id || result?.collection?.id;
          if (id) {
            const col = {
              id: String(id),
              name: def.name,
              type: "datastore",
              description: def.description,
            } as DataCollection;
            matching.push(col);
            createdCollections.set(def.name, col);
            console.log(`[datastoreSync] cached ${def.name} with id: ${id}`);
          } else {
            console.warn(`[datastoreSync] no id found in response for ${def.name}. Response keys:`, Object.keys(result || {}));
          }
        } catch (e) {
          console.warn(`[datastoreSync] failed to create ${def.name}:`, e);
        }
      }
    }

    // After creation, re-fetch to ensure we have the authoritative list
    if (matching.length > 0) {
      try {
        // Wait for API eventual consistency (collections take ~5 seconds to appear)
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        const fetchFn = makeSkillsFetch(token.accessToken);
        const url = new URL("/datacollection/", urls.skillsBaseUrl);
        url.searchParams.set("type", "datastore");
        const refetchResponse = await fetchFn(url.toString());
        const refetched = (await refetchResponse.json()) as DataCollection[] | null;
        const allCollections = Array.isArray(refetched) ? refetched : [];
        const updatedMatching = allCollections.filter((c: DataCollection) => defaults.some((d) => d.name === c.name));
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
