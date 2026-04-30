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
  isStructured?: boolean;
  schema?: { fields?: Array<{ id: string; label?: string; type?: string }> };
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
   * Get all openit-* datastore collections.
   * Phase 3 of V2 sync (PIN-5793): mirrors listOpenitFilestores /
   * listOpenitKbs for the datastore type.
   */
  async listOpenitDatastores(): Promise<DataCollection[]> {
    const all = await this.listCollections("datastore");
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
   * Create a data collection. Mirrors the POST our app sends in
   * `resolveProjectDatastores` (datastoreSync.ts) — single-call create
   * with caller schema. Cloud fixes #1 and #2 must be in for this to
   * land a structured collection on the first try.
   *
   * Endpoint: POST /datacollection/
   */
  async createCollection(body: Record<string, unknown>): Promise<DataCollection> {
    const url = new URL("/datacollection/", this.skillsBaseUrl);
    const response = await fetch(url.toString(), {
      method: "POST",
      headers: { ...(await this.authHeaders()), "Content-Type": "application/json" },
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
   * tolerates 403 (cred scope) and 404 (already gone).
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
   * Convenience: delete every collection whose name matches one of the
   * given names (across ALL types). Used by integration tests to
   * idempotently reset a known set of openit-* fixtures before a run.
   */
  async deleteCollectionsByName(names: string[]): Promise<number> {
    const types: Array<"datastore" | "filestorage" | "knowledge_base"> = [
      "datastore", "filestorage", "knowledge_base",
    ];
    let deleted = 0;
    for (const t of types) {
      const all = await this.listCollections(t);
      for (const c of all) {
        if (names.includes(c.name)) {
          await this.deleteCollection(c.id);
          deleted += 1;
        }
      }
    }
    return deleted;
  }

  /**
   * List items in a datastore collection. Returns parsed items array.
   *
   * Uses GET /memory/items (Firestore-backed, strongly consistent with
   * writes). Do NOT switch to /memory/bquery here: bquery reads from
   * BigQuery and lags behind freshly inserted rows by seconds, which
   * surfaces as flaky list-after-insert assertions in tests.
   *
   * Endpoint: GET /memory/items?collectionId={id}&limit={n}
   */
  async listDatastoreItems(collectionId: string, limit = 200): Promise<{
    items: Array<{ id?: string; key?: string; content?: unknown; updatedAt?: string }>;
  }> {
    const url = new URL("/memory/items", this.skillsBaseUrl);
    url.searchParams.set("collectionId", collectionId);
    url.searchParams.set("limit", String(limit));
    const response = await fetch(url.toString(), { headers: await this.authHeaders() });
    if (!response.ok) {
      throw new Error(
        `listDatastoreItems failed: HTTP ${response.status}: ${await response.text()}`,
      );
    }
    const data = await response.json();
    // /memory/items returns either a raw array (structured collections,
    // light format) or { items: [...] } (other shapes). Handle both.
    if (Array.isArray(data)) return { items: data };
    return { items: Array.isArray(data?.items) ? data.items : [] };
  }

  /**
   * POST one row to a datastore collection. Mirrors what
   * `pushAllToDatastoresImpl` does for new local files.
   * Endpoint: POST /memory/items?collectionId={id}
   */
  async postDatastoreRow(
    collectionId: string,
    key: string,
    content: unknown,
  ): Promise<{ id: string }> {
    const url = new URL("/memory/items", this.skillsBaseUrl);
    url.searchParams.set("collectionId", collectionId);
    const response = await fetch(url.toString(), {
      method: "POST",
      headers: { ...(await this.authHeaders()), "Content-Type": "application/json" },
      body: JSON.stringify({ key, content }),
    });
    if (!response.ok) {
      throw new Error(
        `postDatastoreRow failed: HTTP ${response.status}: ${await response.text()}`,
      );
    }
    const data = await response.json();
    return { id: String(data?.id ?? "") };
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
