import { describe, it, expect, beforeAll } from "vitest";
import { loadConfig, deriveSkillsBaseUrl } from "./utils/config";
import { PinkfishClient, type DataCollection } from "./utils/pinkfish-api";

const config = loadConfig();
const skip = !config;

let client: PinkfishClient | null = null;
let openitCollections: DataCollection[] = [];

function expectedLocalDir(collectionName: string): string {
  const folder = collectionName.startsWith("openit-")
    ? collectionName.slice("openit-".length)
    : collectionName;
  return `filestores/${folder}`;
}

describe.skipIf(skip)("filestore sync - real integration", () => {
  beforeAll(async () => {
    if (!config) return;
    client = new PinkfishClient(config);

    console.log("\n" + "=".repeat(60));
    console.log("FILESTORE SYNC INTEGRATION TESTS");
    console.log("=".repeat(60));
    console.log("Repo:        ", config.repo);
    console.log("Org:         ", config.orgId);
    console.log("Token URL:   ", config.credentials.tokenUrl);
    console.log("Skills URL:  ", deriveSkillsBaseUrl(config.credentials.tokenUrl));
    console.log("=".repeat(60) + "\n");
  });

  it("should authenticate with OAuth and get an access token", async () => {
    if (!client) return;
    const token = await client.getToken();
    expect(token).toBeTruthy();
    expect(token.length).toBeGreaterThan(20);
    console.log(`✓ Token: ${token.slice(0, 20)}...`);
  });

  it("should discover all filestorage collections", async () => {
    if (!client) return;
    const all = await client.listCollections("filestorage");
    console.log(`\nFound ${all.length} filestorage collections:`);
    all.forEach((c) => {
      console.log(`  - ${c.name} (id: ${c.id})`);
    });
    expect(all.length).toBeGreaterThan(0);
  });

  it("should discover openit-* filestore collections", async () => {
    if (!client) return;
    openitCollections = await client.listOpenitFilestores();
    console.log(`\nFound ${openitCollections.length} openit-* collections:`);
    openitCollections.forEach((c) => {
      console.log(`  - ${c.name} (id: ${c.id})`);
      console.log(`    → ${expectedLocalDir(c.name)}/`);
    });
    expect(openitCollections.length).toBeGreaterThan(0);
  });

  it("should list files in each openit-* collection", async () => {
    if (!client) return;
    if (openitCollections.length === 0) {
      openitCollections = await client.listOpenitFilestores();
    }

    console.log("\n=== FILES PER COLLECTION ===");
    for (const collection of openitCollections) {
      const files = await client.listFilestoreItems(collection.id);
      const dir = expectedLocalDir(collection.name);
      console.log(`\n${collection.name} (id: ${collection.id})`);
      console.log(`  → ${dir}/`);
      if (files.length === 0) {
        console.log("    (empty)");
      } else {
        files.forEach((f) => {
          console.log(`    - ${f.filename}`);
          console.log(`      updated_at: ${f.updated_at ?? "(none)"}`);
          console.log(`      → ${dir}/${f.filename}`);
        });
      }
      expect(Array.isArray(files)).toBe(true);
    }
  });

  it("should verify routing: collection name → local folder", async () => {
    if (!client) return;
    if (openitCollections.length === 0) {
      openitCollections = await client.listOpenitFilestores();
    }

    console.log("\n=== ROUTING VERIFICATION ===");
    const expectations: Record<string, string> = {
      "openit-library": "filestores/library",
      "openit-attachments": "filestores/attachments",
    };

    for (const collection of openitCollections) {
      const expected = expectations[collection.name];
      const actual = expectedLocalDir(collection.name);
      if (expected) {
        console.log(`  ${collection.name} → ${actual}`);
        expect(actual).toBe(expected);
      } else {
        // Custom collection (e.g., openit-docs-653713545258 → filestores/docs-653713545258)
        const stripped = collection.name.slice("openit-".length);
        const expectedDynamic = `filestores/${stripped}`;
        console.log(`  ${collection.name} → ${actual} (dynamic)`);
        expect(actual).toBe(expectedDynamic);
      }
    }
  });
});
