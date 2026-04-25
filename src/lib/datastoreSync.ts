import {
  getCollection,
  listItems,
  type DataCollection,
  type MemoryBqueryResponse,
  type MemoryItem,
} from "./skillsApi";
import { entityWriteFile, pinkfishMcpCall } from "./api";
import { derivedUrls, getToken, type PinkfishCreds } from "./pinkfishAuth";

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
 * List all Datastore-type datacollections matching the openit-* prefix.
 * If none are found, auto-creates the two defaults (tickets + people).
 * Returns the full list of matching collections (with schema).
 */
export async function resolveProjectDatastores(
  creds: PinkfishCreds,
): Promise<DataCollection[]> {
  const token = getToken();
  if (!token) throw new Error("not authenticated");
  const urls = derivedUrls(creds.tokenUrl);

  try {
    const result = (await pinkfishMcpCall({
      accessToken: token.accessToken,
      orgId: creds.orgId,
      server: "datastore-structured",
      tool: "datastore-structured_list_collections",
      arguments: {},
      baseUrl: urls.mcpBaseUrl,
    })) as { collections?: DataCollection[] } | null;

    const all = result?.collections ?? [];
    console.log(`[datastoreSync] list_collections returned ${all.length} collections`);
    all.forEach((c: DataCollection) => console.log(`  - ${c.name} (id: ${c.id})`));
    const defaults = DEFAULT_DATASTORES.map((d) => ({
      ...d,
      name: `${d.name}-${creds.orgId}`,
    }));
    let matching = all.filter((c: DataCollection) => defaults.some((d) => d.name === c.name));

    // If list returned nothing, check our in-memory cache of recently created collections
    if (matching.length === 0 && createdCollections.size > 0) {
      console.log(`[datastoreSync] using ${createdCollections.size} recently created collections`);
      matching = Array.from(createdCollections.values());
    }

    if (matching.length === 0) {
      console.log("[datastoreSync] no openit-* datastores found — creating defaults");
      for (const def of defaults) {
        try {
          const result = (await pinkfishMcpCall({
            accessToken: token.accessToken,
            orgId: creds.orgId,
            server: "datastore-structured",
            tool: "datastore-structured_create_collection",
            arguments: {
              name: def.name,
              type: "datastore",
              templateId: def.templateId,
              description: def.description,
              createdBy: creds.orgId,
              createdByName: "OpenIT",
            },
            baseUrl: urls.mcpBaseUrl,
          })) as { id?: string | number } | null;
          if (result?.id) {
            const col = {
              id: String(result.id),
              name: def.name,
              type: "datastore",
              description: def.description,
            } as DataCollection;
            matching.push(col);
            createdCollections.set(def.name, col);
            console.log(`[datastoreSync] created ${def.name}`);
          }
        } catch (e) {
          console.warn(`[datastoreSync] failed to create ${def.name}:`, e);
        }
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
