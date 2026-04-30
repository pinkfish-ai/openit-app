import { makeSkillsFetch } from "../api/fetchAdapter";

// ---------------------------------------------------------------------------
// Types matching web project's generated models
// ---------------------------------------------------------------------------

export type SchemaField = {
  id: string;
  label: string;
  type: "string" | "number" | "boolean" | "date" | "select";
  required?: boolean;
  options?: string[];
};

export type CollectionSchema = {
  fields: SchemaField[];
  nextFieldId: number;
  sortConfig?: { fields: string[]; direction: string };
};

export type DataCollection = {
  id: string;
  name: string;
  type: string;
  description?: string;
  numItems: number;
  isStructured?: boolean;
  schema?: CollectionSchema;
  createdBy?: string;
  createdByName?: string;
};

export type MemoryItem = {
  id: string;
  key: string;
  // Second leg of the cloud's composite primary key. Required on read
  // (firebase-helpers MemoryItem schema). When the caller omits it on
  // POST, cloud auto-stamps `Date.now().toString()`. For
  // `openit-conversations` we send the msgId so `(key, sortField) =
  // (ticketId, msgId)` mirrors the on-disk
  // `databases/conversations/<ticketId>/<msgId>.json` layout.
  sortField: string;
  content: string | Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type MemoryBqueryResponse = {
  items: MemoryItem[];
  pagination: {
    totalCount: number;
    limit: number;
    offset: number;
    hasNextPage: boolean;
    hasPrevPage: boolean;
  };
  schema?: CollectionSchema;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function assertOk(response: Response): Promise<void> {
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status}: ${body}`);
  }
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * List data collections, optionally filtered by type.
 * GET /datacollection/ with optional ?type= query param
 */
export async function listCollections(
  skillsBaseUrl: string,
  accessToken: string,
  type?: string,
): Promise<DataCollection[]> {
  const fetchFn = makeSkillsFetch(accessToken);
  const url = new URL("/datacollection/", skillsBaseUrl);
  if (type) {
    url.searchParams.set("type", type);
  }
  const response = await fetchFn(url.toString());
  await assertOk(response);
  return response.json();
}

/**
 * Create a new data collection.
 * POST /datacollection/
 */
export async function createCollection(
  skillsBaseUrl: string,
  accessToken: string,
  body: {
    name: string;
    type: string;
    description?: string;
    createdBy: string;
    createdByName: string;
    isStructured?: boolean;
    templateId?: string;
  },
): Promise<DataCollection> {
  const fetchFn = makeSkillsFetch(accessToken);
  const url = new URL("/datacollection/", skillsBaseUrl);
  const response = await fetchFn(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  await assertOk(response);
  return response.json();
}

/**
 * Get a single data collection by ID.
 * GET /datacollection/{collectionId}
 */
export async function getCollection(
  skillsBaseUrl: string,
  accessToken: string,
  collectionId: string,
): Promise<DataCollection> {
  const fetchFn = makeSkillsFetch(accessToken);
  const url = new URL(`/datacollection/${collectionId}`, skillsBaseUrl);
  const response = await fetchFn(url.toString());
  await assertOk(response);
  return response.json();
}

/**
 * List items in a collection via the memory bquery endpoint.
 * GET /memory/bquery?collectionId={id}&limit={limit}&offset={offset}&includeSchema=true
 */
export async function listItems(
  skillsBaseUrl: string,
  accessToken: string,
  collectionId: string,
  limit: number = 100,
  offset: number = 0,
): Promise<MemoryBqueryResponse> {
  const fetchFn = makeSkillsFetch(accessToken);
  const url = new URL("/memory/bquery", skillsBaseUrl);
  url.searchParams.set("collectionId", collectionId);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("includeSchema", "true");
  const response = await fetchFn(url.toString());
  await assertOk(response);
  return response.json();
}
