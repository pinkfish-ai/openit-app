/**
 * Real-API knowledge-base sync integration tests — Phase 2 of V2 sync
 * (PIN-5775).
 *
 * Hits the live Pinkfish skills API with the credentials in
 * test-config.json. Mirror of filestore-sync.test.ts: verifies the same
 * REST surface the Tauri backend uses for KB sync — same endpoints,
 * same headers, same auth.
 *
 * Skipped without test-config.json present.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { loadConfig, deriveSkillsBaseUrl } from "./utils/config";
import { PinkfishClient, type DataCollection } from "./utils/pinkfish-api";

const config = loadConfig();
const skip = !config;

let client: PinkfishClient | null = null;
let openitKbs: DataCollection[] = [];

function expectedLocalDir(collectionName: string): string {
  const folder = collectionName.startsWith("openit-")
    ? collectionName.slice("openit-".length)
    : collectionName;
  return `knowledge-bases/${folder}`;
}

describe.skipIf(skip)("KB sync — real integration", () => {
  beforeAll(async () => {
    if (!config) return;
    client = new PinkfishClient(config);
    console.log("\n" + "=".repeat(60));
    console.log("KB SYNC INTEGRATION TESTS");
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
    it("lists all knowledge-base collections", async () => {
      if (!client) return;
      const all = await client.listCollections("knowledge_base");
      console.log(`Found ${all.length} knowledge-base collections`);
      // It's fine if the org has no KBs yet — the auto-create path
      // creates `openit-default` on the next connect. Just confirm the
      // endpoint responds.
      expect(Array.isArray(all)).toBe(true);
    });

    it("filters to openit-* collections only", async () => {
      if (!client) return;
      openitKbs = await client.listOpenitKbs();
      console.log(`openit-* KB collections: ${openitKbs.length}`);
      openitKbs.forEach((c) => {
        console.log(`  - ${c.name} (id: ${c.id}) → ${expectedLocalDir(c.name)}/`);
      });
      expect(openitKbs.every((c) => c.name.startsWith("openit-"))).toBe(true);
    });

    it("excludes non-openit collections from the openit filter", async () => {
      if (!client) return;
      const all = await client.listCollections("knowledge_base");
      const nonOpenit = all.filter((c) => !c.name.startsWith("openit-"));
      const openit = await client.listOpenitKbs();
      expect(nonOpenit.length + openit.length).toBe(all.length);
      expect(nonOpenit.some((c) => c.name.startsWith("openit-"))).toBe(false);
    });
  });

  describe("name → local-dir routing (Phase 2 multi-collection)", () => {
    it("maps openit-default → knowledge-bases/default", () => {
      expect(expectedLocalDir("openit-default")).toBe("knowledge-bases/default");
    });

    it("maps openit-runbooks → knowledge-bases/runbooks", () => {
      expect(expectedLocalDir("openit-runbooks")).toBe("knowledge-bases/runbooks");
    });

    it("returns the input verbatim for non-openit names (defensive)", () => {
      expect(expectedLocalDir("customer-knowledge")).toBe(
        "knowledge-bases/customer-knowledge",
      );
    });
  });

  describe("REST endpoint contract — must match the orchestrator", () => {
    it("knowledge-base type filter returns only knowledge-base collections", async () => {
      if (!client) return;
      const kbs = await client.listCollections("knowledge_base");
      const fs = await client.listCollections("filestorage");
      // Disjoint sets — no collection should appear in both type
      // listings (the server filters by `type`).
      const kbIds = new Set(kbs.map((c) => c.id));
      const fsIds = new Set(fs.map((c) => c.id));
      for (const id of kbIds) expect(fsIds.has(id)).toBe(false);
    });
  });
});
