import {
  listCollections,
  createCollection,
  getCollection,
  listItems,
  type DataCollection,
  type MemoryBqueryResponse,
  type MemoryItem,
} from "./skillsApi";
import { entityWriteFile, entityClearDir } from "./api";
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

  const all = await listCollections(
    urls.skillsBaseUrl,
    token.accessToken,
    "datastore",
  );
  let matching = all.filter((c) => c.name.startsWith(PREFIX));

  if (matching.length === 0) {
    console.log("[datastoreSync] no openit-* datastores found — creating defaults");
    for (const def of DEFAULT_DATASTORES) {
      const created = await createCollection(urls.skillsBaseUrl, token.accessToken, {
        name: def.name,
        type: "datastore",
        isStructured: true,
        templateId: def.templateId,
        description: def.description,
        createdBy: creds.orgId,
        createdByName: "OpenIT",
      });
      matching.push(created);
    }
  }

  // Ensure each collection has its schema populated. If a collection was
  // returned from the list endpoint without schema details, fetch it individually.
  const resolved: DataCollection[] = [];
  for (const col of matching) {
    if (!col.schema) {
      try {
        const full = await getCollection(
          urls.skillsBaseUrl,
          token.accessToken,
          col.id,
        );
        resolved.push(full);
      } catch (e) {
        console.warn(
          `[datastoreSync] failed to fetch schema for ${col.name}:`,
          e,
        );
        resolved.push(col);
      }
    } else {
      resolved.push(col);
    }
  }

  return resolved;
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
    await entityClearDir(repo, subdir);
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
