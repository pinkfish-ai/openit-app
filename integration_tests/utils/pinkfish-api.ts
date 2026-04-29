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

  constructor(private config: IntegrationTestConfig) {
    this.skillsBaseUrl = deriveSkillsBaseUrl(config.credentials.tokenUrl);
  }

  async getToken(): Promise<string> {
    if (this.token) return this.token;
    this.token = await getAccessTokenWithConfig(this.config);
    return this.token;
  }

  getSkillsBaseUrl(): string {
    return this.skillsBaseUrl;
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
}
