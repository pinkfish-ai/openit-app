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
 * Create a structured datastore + populate it via CSV in a single
 * multipart POST. The `import-csv` endpoint is the canonical structured-
 * create path: it bypasses the cloud's auto-template behavior that
 * `POST /datacollection/` with `isStructured + schema` triggers (10 sample
 * rows with `f_1`/`f_2` field IDs that don't match our schema).
 *
 * `schema` is the cloud-shaped schema (f_N IDs, narrow types). Use
 * `localSchemaToCloud()` in `datastoreSync.ts` to convert from the
 * rich on-disk shape.
 *
 * POST /datacollection/import-csv?dateFormat=<fmt>&async=true
 */
export async function importCsv(
  skillsBaseUrl: string,
  accessToken: string,
  args: {
    name: string;
    csv: string;
    schema: Record<string, unknown>;
    createdByName: string;
    dateFormat?: string;
  },
): Promise<{
  status: string;
  collectionId: string;
  jobId: string;
  statusFileUrl: string;
}> {
  const fetchFn = makeSkillsFetch(accessToken);
  const url = new URL("/datacollection/import-csv", skillsBaseUrl);
  url.searchParams.set("dateFormat", args.dateFormat ?? "MDY");
  url.searchParams.set("async", "true");

  const form = new FormData();
  form.append(
    "file",
    new Blob([args.csv], { type: "text/csv" }),
    `${args.name}.csv`,
  );
  form.append("name", args.name);
  form.append("schema", JSON.stringify(args.schema));
  form.append("createdByName", args.createdByName);

  const response = await fetchFn(url.toString(), {
    method: "POST",
    body: form,
  });
  await assertOk(response);
  return (await response.json()) as {
    status: string;
    collectionId: string;
    jobId: string;
    statusFileUrl: string;
  };
}

/**
 * Poll the signed status URL returned by `importCsv`. The URL has a
 * 24-hour TTL so this is best-effort: if the URL has expired or the
 * collection has been recycled, the GET returns 403/404 and we treat
 * the import as failed.
 */
export async function fetchImportStatus(
  statusFileUrl: string,
): Promise<{
  status: string;
  inserted?: number;
  updated?: number;
  failed?: number;
  total?: number;
  completedAt?: string;
}> {
  // Signed URL — no auth header needed (and adding one breaks the
  // signature on some Google Cloud Storage endpoints).
  const response = await fetch(statusFileUrl);
  if (!response.ok) {
    throw new Error(
      `fetchImportStatus failed: HTTP ${response.status}: ${await response.text()}`,
    );
  }
  return await response.json();
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
