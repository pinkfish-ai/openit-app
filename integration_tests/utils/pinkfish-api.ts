import { deriveSkillsBaseUrl, type IntegrationTestConfig } from "./config";
import { getAccessTokenWithConfig } from "./auth";

export interface DataCollection {
  id: string;
  name: string;
  type: string;
  description?: string;
  created_by?: string;
  created_at?: string;
  updated_at?: string;
}

export interface RemoteFile {
  filename: string;
  signed_url: string;
  updated_at?: string;
  size?: number;
}

/**
 * Wrapper around the Pinkfish skills API for integration tests.
 * Uses the same endpoints and headers the Tauri app uses.
 */
export class PinkfishClient {
  private token: string | null = null;
  private skillsBaseUrl: string;
  private appBaseUrl: string;

  constructor(private config: IntegrationTestConfig) {
    this.skillsBaseUrl = deriveSkillsBaseUrl(config.credentials.tokenUrl);
    // app-api host (e.g., https://app-api.dev20.pinkfish.dev) — derived
    // from the tokenUrl by stripping /oauth/token. Used for collection
    // create/delete which live on the app-api surface, not skills.
    this.appBaseUrl = config.credentials.tokenUrl.replace(
      /\/oauth\/token\/?$/,
      "",
    );
  }

  async getToken(): Promise<string> {
    if (this.token) return this.token;
    this.token = await getAccessTokenWithConfig(this.config);
    return this.token;
  }

  getSkillsBaseUrl(): string {
    return this.skillsBaseUrl;
  }

  getAppBaseUrl(): string {
    return this.appBaseUrl;
  }

  /**
   * Headers for skills API requests.
   * The Pinkfish skills API uses `Auth-Token: Bearer <token>`, NOT
   * the standard `Authorization` header.
   */
  private async authHeaders(): Promise<Record<string, string>> {
    const token = await this.getToken();
    return {
      "Auth-Token": `Bearer ${token}`,
      Accept: "*/*",
    };
  }

  /**
   * List all data collections of a given type (e.g., "filestorage", "datastore").
   * Endpoint: GET /datacollection/?type={type}
   */
  async listCollections(type: string): Promise<DataCollection[]> {
    const url = new URL("/datacollection/", this.skillsBaseUrl);
    url.searchParams.set("type", type);

    const response = await fetch(url.toString(), {
      headers: await this.authHeaders(),
    });

    if (!response.ok) {
      throw new Error(
        `listCollections failed: HTTP ${response.status}: ${await response.text()}`,
      );
    }

    const data = await response.json();
    return Array.isArray(data) ? (data as DataCollection[]) : [];
  }

  /**
   * List items in a filestorage collection.
   * Endpoint: GET /filestorage/items?collectionId={id}&format=full
   * (Same endpoint kb_list_remote uses in the Tauri backend)
   */
  async listFilestoreItems(collectionId: string): Promise<RemoteFile[]> {
    const url = new URL("/filestorage/items", this.skillsBaseUrl);
    url.searchParams.set("collectionId", collectionId);
    url.searchParams.set("format", "full");

    const response = await fetch(url.toString(), {
      headers: await this.authHeaders(),
    });

    if (!response.ok) {
      throw new Error(
        `listFilestoreItems failed for ${collectionId}: HTTP ${response.status}: ${await response.text()}`,
      );
    }

    const data = await response.json();
    if (Array.isArray(data)) return data as RemoteFile[];
    if (data && typeof data === "object" && Array.isArray((data as any).items)) {
      return (data as any).items;
    }
    return [];
  }

  /**
   * Find a collection by exact name match.
   * Returns null if not found.
   */
  async findCollectionByName(
    type: string,
    name: string,
  ): Promise<DataCollection | null> {
    const all = await this.listCollections(type);
    return all.find((c) => c.name === name) ?? null;
  }

  /**
   * Get all openit-* filestore collections.
   */
  async listOpenitFilestores(): Promise<DataCollection[]> {
    const all = await this.listCollections("filestorage");
    return all.filter((c) => c.name.startsWith("openit-"));
  }

  /**
   * Get all openit-* knowledge-base collections.
   * Phase 2 of V2 sync (PIN-5775): KB resolver moved to REST. The valid
   * `?type=` value is the snake_case `knowledge_base` (matches
   * DataCollectionType.KnowledgeBase from /firebase-helpers).
   */
  async listOpenitKbs(): Promise<DataCollection[]> {
    const all = await this.listCollections("knowledge_base");
    return all.filter((c) => c.name.startsWith("openit-"));
  }

  /**
   * Get all openit-* datastore collections.
   * Phase 3 of V2 sync (PIN-5779).
   */
  async listOpenitDatastores(): Promise<DataCollection[]> {
    const all = await this.listCollections("datastore");
    return all.filter((c) => c.name.startsWith("openit-"));
  }

  /**
   * Upload a file to a filestorage collection. Multipart form upload to
   * the same endpoint the Tauri backend uses.
   * Endpoint: POST /filestorage/items/upload?collectionId={id}
   * Returns the response object (which may contain a sanitized filename
   * if the server normalized it).
   */
  async uploadFilestoreFile(args: {
    collectionId: string;
    filename: string;
    bytes: Uint8Array | ArrayBuffer;
    mime?: string;
  }): Promise<{ id?: string; filename?: string; file_url?: string }> {
    const url = new URL("/filestorage/items/upload", this.skillsBaseUrl);
    url.searchParams.set("collectionId", args.collectionId);

    const blob = new Blob(
      [args.bytes instanceof Uint8Array ? args.bytes : new Uint8Array(args.bytes)],
      { type: args.mime ?? "application/octet-stream" },
    );
    const form = new FormData();
    form.append("file", blob, args.filename);
    form.append("metadata", "{}");

    const response = await fetch(url.toString(), {
      method: "POST",
      headers: await this.authHeaders(),
      body: form,
    });

    if (!response.ok) {
      throw new Error(
        `uploadFilestoreFile failed: HTTP ${response.status}: ${await response.text()}`,
      );
    }
    const json = await response.json();
    return {
      id: json?.id,
      filename: json?.metadata?.filename ?? args.filename,
      file_url: json?.file_url,
    };
  }

  /**
   * Create a data collection. Mirrors the POST our app sends in
   * `autoCreateDefaultsIfMissing` (syncEngine.ts) so tests reproduce
   * the exact create body and can observe whether the backend
   * auto-populates rows after create.
   *
   * Endpoint: POST /datacollection/
   */
  async createCollection(body: Record<string, unknown>): Promise<DataCollection> {
    const url = new URL("/datacollection/", this.skillsBaseUrl);
    const response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        ...(await this.authHeaders()),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(
        `createCollection failed: HTTP ${response.status}: ${await response.text()}`,
      );
    }
    return (await response.json()) as DataCollection;
  }

  /**
   * Delete an entire data collection by id. Best-effort cleanup —
   * tolerates 403/404 like deleteFilestoreItem does.
   *
   * Endpoint: DELETE /datacollection/{id}
   */
  async deleteCollection(id: string): Promise<void> {
    const url = new URL(
      `/datacollection/${encodeURIComponent(id)}`,
      this.skillsBaseUrl,
    );
    const response = await fetch(url.toString(), {
      method: "DELETE",
      headers: await this.authHeaders(),
    });
    if (response.ok || response.status === 404) return;
    if (response.status === 403) {
      console.warn(`[pinkfish-api] cleanup delete forbidden for collection ${id}`);
      return;
    }
    throw new Error(
      `deleteCollection failed: HTTP ${response.status}: ${await response.text()}`,
    );
  }

  /**
   * Create a structured datastore + import rows in a single multipart
   * POST. This is the only way to make a structured collection without
   * triggering Pinkfish's auto-template behavior — see
   * `datastore-create-no-template.test.ts` for the diagnosis.
   *
   * Endpoint: POST /datacollection/import-csv?dateFormat=<fmt>&async=true
   * Multipart fields:
   *   file          — text/csv body
   *   name          — collection name
   *   schema        — JSON: { fields: [{id, label, type, required, ...}], nextFieldId }
   *   createdByName — string ("OpenIT")
   * Returns: { status, collectionId, jobId, statusFileUrl, schema, ... }
   */
  async importCsv(args: {
    name: string;
    csv: string;
    schema: Record<string, unknown>;
    createdByName: string;
    dateFormat?: string; // "MDY" | "DMY" | "YMD" — picks how date columns parse
  }): Promise<{
    status: string;
    collectionId: string;
    jobId: string;
    statusFileUrl: string;
  }> {
    const url = new URL("/datacollection/import-csv", this.skillsBaseUrl);
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

    const response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        // Don't set Content-Type — fetch sets the multipart boundary.
        "Auth-Token": `Bearer ${await this.getToken()}`,
      },
      body: form,
    });
    if (!response.ok) {
      throw new Error(
        `importCsv failed: HTTP ${response.status}: ${await response.text()}`,
      );
    }
    return (await response.json()) as {
      status: string;
      collectionId: string;
      jobId: string;
      statusFileUrl: string;
    };
  }

  /**
   * Poll the signed URL returned by `importCsv`. Returns the parsed
   * status JSON (status: queued | running | completed | failed; counts;
   * timing).
   */
  async fetchImportStatus(statusFileUrl: string): Promise<{
    status: string;
    inserted?: number;
    updated?: number;
    failed?: number;
    total?: number;
    completedAt?: string;
  }> {
    const response = await fetch(statusFileUrl);
    if (!response.ok) {
      throw new Error(
        `fetchImportStatus failed: HTTP ${response.status}: ${await response.text()}`,
      );
    }
    return await response.json();
  }

  /**
   * Set or update a structured datastore's schema. Server-side this
   * also flips `isStructured` to true. Mirror of the PUT we'll start
   * sending from `pushAllToDatastoreImpl` (the schema-push step).
   *
   * Endpoint: PUT /datacollection/{id}/schema
   */
  async putCollectionSchema(
    id: string,
    schema: Record<string, unknown>,
  ): Promise<void> {
    const url = new URL(
      `/datacollection/${encodeURIComponent(id)}/schema`,
      this.skillsBaseUrl,
    );
    const response = await fetch(url.toString(), {
      method: "PUT",
      headers: {
        ...(await this.authHeaders()),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ schema }),
    });
    if (!response.ok) {
      throw new Error(
        `putCollectionSchema failed: HTTP ${response.status}: ${await response.text()}`,
      );
    }
  }

  /**
   * List items in a datastore collection (`/memory/bquery`). Returns
   * the raw items array and total count so a test can assert "this
   * collection was created with N pre-existing rows" right after a
   * POST /datacollection/.
   *
   * Endpoint: GET /memory/bquery?collectionId={id}&limit=100
   */
  async listDatastoreItems(collectionId: string): Promise<{
    items: Array<Record<string, unknown>>;
    total: number;
  }> {
    const url = new URL("/memory/bquery", this.skillsBaseUrl);
    url.searchParams.set("collectionId", collectionId);
    url.searchParams.set("limit", "100");
    const response = await fetch(url.toString(), {
      headers: await this.authHeaders(),
    });
    if (!response.ok) {
      throw new Error(
        `listDatastoreItems failed: HTTP ${response.status}: ${await response.text()}`,
      );
    }
    const data = (await response.json()) as {
      items?: Array<Record<string, unknown>>;
      total?: number;
    };
    return { items: data.items ?? [], total: data.total ?? (data.items?.length ?? 0) };
  }

  /**
   * Delete an item from a filestorage collection by its server id.
   * Endpoint: DELETE /filestorage/items/{itemId}
   *
   * Best-effort cleanup for tests: tolerates 403 (some credential
   * scopes can write but not delete) and 404 (already gone) so an
   * upload-then-delete fixture cycle still completes the assertion
   * even if the delete leg can't run. Logs a warning so the test
   * artifacts in the org stay visible.
   */
  async deleteFilestoreItem(itemId: string): Promise<void> {
    const url = new URL(
      `/filestorage/items/${encodeURIComponent(itemId)}`,
      this.skillsBaseUrl,
    );
    const response = await fetch(url.toString(), {
      method: "DELETE",
      headers: await this.authHeaders(),
    });
    if (response.ok || response.status === 404) return;
    if (response.status === 403) {
      console.warn(
        `[pinkfish-api] cleanup delete forbidden for item ${itemId} — leaving artifact in remote (test will pass, org will accumulate fixtures)`,
      );
      return;
    }
    throw new Error(
      `deleteFilestoreItem failed: HTTP ${response.status}: ${await response.text()}`,
    );
  }
}
