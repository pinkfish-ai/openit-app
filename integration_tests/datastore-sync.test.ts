/**
 * Real-API datastore sync integration tests — Phase 3 of V2 sync
 * (PIN-5779).
 *
 * Hits the live Pinkfish skills API with the credentials in
 * test-config.json. Mirror of filestore-sync.test.ts and
 * kb-sync.test.ts: verifies the REST surface the orchestrator uses
 * for datastore sync — same endpoints, same headers, same auth.
 * Covers both flavors (structured + unstructured) since Phase 3's
 * `discoverLocalCollections` hook can mint either.
 *
 * Skipped without test-config.json present.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { loadConfig, deriveSkillsBaseUrl } from "./utils/config";
import { PinkfishClient, type DataCollection } from "./utils/pinkfish-api";

const config = loadConfig();
const skip = !config;

let client: PinkfishClient | null = null;
let openitDatastores: DataCollection[] = [];

function expectedLocalDir(collectionName: string): string {
  const folder = collectionName.startsWith("openit-")
    ? collectionName.slice("openit-".length)
    : collectionName;
  return `databases/${folder}`;
}

describe.skipIf(skip)("Datastore sync — real integration", () => {
  beforeAll(async () => {
    if (!config) return;
    client = new PinkfishClient(config);
    console.log("\n" + "=".repeat(60));
    console.log("DATASTORE SYNC INTEGRATION TESTS");
    console.log("=".repeat(60));
    console.log("Repo:        ", config.repo);
    console.log("Org:         ", config.orgId);
    console.log("Token URL:   ", config.credentials.tokenUrl);
    console.log("Skills URL:  ", deriveSkillsBaseUrl(config.credentials.tokenUrl));
    console.log("=".repeat(60) + "\n");
  });

  describe("authentication", () => {
    it("gets an OAuth access token via client_credentials", async () => {
      if (!client) return;
      const token = await client.getToken();
      expect(token).toBeTruthy();
      expect(token.length).toBeGreaterThan(20);
    });
  });

  describe("collection discovery", () => {
    it("lists all datastore collections (the REST `?type=datastore` path)", async () => {
      if (!client) return;
      const all = await client.listCollections("datastore");
      console.log(`Found ${all.length} datastore collections`);
      expect(Array.isArray(all)).toBe(true);
    });

    it("filters to openit-* collections only", async () => {
      if (!client) return;
      openitDatastores = await client.listOpenitDatastores();
      console.log(`openit-* datastore collections: ${openitDatastores.length}`);
      openitDatastores.forEach((c) => {
        const flavor = c.isStructured ? "structured" : "unstructured";
        console.log(
          `  - ${c.name} (id: ${c.id}, ${flavor}) → ${expectedLocalDir(c.name)}/`,
        );
      });
      expect(openitDatastores.every((c) => c.name.startsWith("openit-"))).toBe(true);
    });

    it("excludes non-openit collections from the openit filter", async () => {
      if (!client) return;
      const all = await client.listCollections("datastore");
      const nonOpenit = all.filter((c) => !c.name.startsWith("openit-"));
      const openit = await client.listOpenitDatastores();
      expect(nonOpenit.length + openit.length).toBe(all.length);
      expect(nonOpenit.some((c) => c.name.startsWith("openit-"))).toBe(false);
    });
  });

  describe("name → local-dir routing (Phase 3 multi-collection)", () => {
    it("maps openit-tickets → databases/tickets", () => {
      expect(expectedLocalDir("openit-tickets")).toBe("databases/tickets");
    });

    it("maps openit-people → databases/people", () => {
      expect(expectedLocalDir("openit-people")).toBe("databases/people");
    });

    it("maps openit-projects → databases/projects (custom datastore)", () => {
      expect(expectedLocalDir("openit-projects")).toBe("databases/projects");
    });

    it("returns the input verbatim for non-openit names (defensive)", () => {
      expect(expectedLocalDir("customer-feedback")).toBe(
        "databases/customer-feedback",
      );
    });
  });

  describe("flavor inspection — structured vs unstructured", () => {
    it("openit-tickets default is structured (has a schema)", async () => {
      if (!client) return;
      if (openitDatastores.length === 0) {
        openitDatastores = await client.listOpenitDatastores();
      }
      const tickets = openitDatastores.find((c) => c.name === "openit-tickets");
      // Tickets is one of the hardcoded auto-create defaults
      // (`isStructured: true`, `templateId: "case-management"`). If the
      // org hasn't been bootstrapped yet, the test is informational.
      if (!tickets) {
        console.log("  openit-tickets not yet auto-created; skipping flavor check");
        return;
      }
      expect(tickets.isStructured).toBe(true);
      expect(tickets.schema).toBeDefined();
    });
  });

  describe("REST endpoint contract — must match the orchestrator", () => {
    it("datastore type filter returns only datastore collections (disjoint from filestorage + knowledge_base)", async () => {
      if (!client) return;
      const datastores = await client.listCollections("datastore");
      const filestores = await client.listCollections("filestorage");
      const kbs = await client.listCollections("knowledge_base");
      const dsIds = new Set(datastores.map((c) => c.id));
      const fsIds = new Set(filestores.map((c) => c.id));
      const kbIds = new Set(kbs.map((c) => c.id));
      for (const id of dsIds) {
        expect(fsIds.has(id)).toBe(false);
        expect(kbIds.has(id)).toBe(false);
      }
    });
  });
});
