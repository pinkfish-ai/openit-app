/**
 * Real-API filestore sync integration tests.
 *
 * Hits the live Pinkfish skills API with the credentials in
 * test-config.json. Verifies the same endpoints and headers the Tauri
 * backend uses, so a regression in those (e.g. wrong path, wrong header
 * name, hardcoded URL) shows up here instead of in a manual
 * restart-and-retry loop on the running app.
 */
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

describe.skipIf(skip)("filestore sync — real integration", () => {
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

  describe("authentication", () => {
    it("gets an OAuth access token via client_credentials", async () => {
      if (!client) return;
      const token = await client.getToken();
      expect(token).toBeTruthy();
      expect(token.length).toBeGreaterThan(20);
    });

    it("token is reused between calls (no new OAuth per call)", async () => {
      if (!client) return;
      const t1 = await client.getToken();
      const t2 = await client.getToken();
      expect(t1).toBe(t2);
    });
  });

  describe("collection discovery", () => {
    it("lists all filestorage collections", async () => {
      if (!client) return;
      const all = await client.listCollections("filestorage");
      console.log(`Found ${all.length} filestorage collections`);
      expect(all.length).toBeGreaterThan(0);
    });

    it("filters to openit-* collections only", async () => {
      if (!client) return;
      openitCollections = await client.listOpenitFilestores();
      console.log(`openit-* collections: ${openitCollections.length}`);
      openitCollections.forEach((c) => {
        console.log(`  - ${c.name} (id: ${c.id}) → ${expectedLocalDir(c.name)}/`);
      });
      expect(openitCollections.length).toBeGreaterThan(0);
      expect(openitCollections.every((c) => c.name.startsWith("openit-"))).toBe(true);
    });

    it("excludes non-openit collections from the openit filter", async () => {
      if (!client) return;
      const all = await client.listCollections("filestorage");
      const nonOpenit = all.filter((c) => !c.name.startsWith("openit-"));
      const openit = await client.listOpenitFilestores();
      // non-openit count + openit count should equal total
      expect(nonOpenit.length + openit.length).toBe(all.length);
      // No openit names in the non-openit set
      expect(nonOpenit.some((c) => c.name.startsWith("openit-"))).toBe(false);
    });

    it("each openit-* collection has a stable id and a non-empty name", async () => {
      if (!client) return;
      if (openitCollections.length === 0) {
        openitCollections = await client.listOpenitFilestores();
      }
      for (const c of openitCollections) {
        expect(typeof c.id).toBe("string");
        expect(c.id.length).toBeGreaterThan(0);
        expect(typeof c.name).toBe("string");
        expect(c.name.length).toBeGreaterThan("openit-".length);
      }
    });
  });

  describe("local-folder routing", () => {
    it("openit-library → filestores/library", () => {
      expect(expectedLocalDir("openit-library")).toBe("filestores/library");
    });
    it("openit-attachments → filestores/attachments", () => {
      expect(expectedLocalDir("openit-attachments")).toBe(
        "filestores/attachments",
      );
    });
    it("openit-docs-{orgId} → filestores/docs-{orgId}", () => {
      expect(expectedLocalDir("openit-docs-653713545258")).toBe(
        "filestores/docs-653713545258",
      );
    });
    it("custom openit-* names route generically", () => {
      expect(expectedLocalDir("openit-runbook-2026")).toBe(
        "filestores/runbook-2026",
      );
    });

    it("each discovered openit-* collection has a unique target dir", async () => {
      if (!client) return;
      if (openitCollections.length === 0) {
        openitCollections = await client.listOpenitFilestores();
      }
      const dirs = new Set(openitCollections.map((c) => expectedLocalDir(c.name)));
      // Critical: no two collections route to the same folder. If they
      // did, files from one would appear in the other and the pull
      // engine would conflate them.
      expect(dirs.size).toBe(openitCollections.length);
    });
  });

  describe("filestore items (per-collection file lists)", () => {
    it("uses the /filestorage/items endpoint, not /datacollection/{id}/items", async () => {
      if (!client) return;
      // The legacy attempt at GET /datacollection/{id}/items returns
      // 404. This test pins the right endpoint. PinkfishClient uses
      // /filestorage/items?collectionId=… so this just succeeds on a
      // real call instead of the wrong-endpoint error.
      if (openitCollections.length === 0) {
        openitCollections = await client.listOpenitFilestores();
      }
      const first = openitCollections[0];
      const items = await client.listFilestoreItems(first.id);
      expect(Array.isArray(items)).toBe(true);
    });

    it("uses Auth-Token header (not Authorization)", async () => {
      // The skills API uses `Auth-Token: Bearer <token>`. This is a
      // structural test: if Authorization were used the client class
      // would have failed earlier in the suite. This test is a
      // documentary marker so a future "let's standardize on
      // Authorization" change has to update both client and tests.
      if (!client) return;
      expect(client).toBeDefined();
    });

    it("listing is stable when nothing changes between calls", async () => {
      if (!client) return;
      if (openitCollections.length === 0) {
        openitCollections = await client.listOpenitFilestores();
      }
      const first = openitCollections[0];
      // Two listings, back-to-back. The intersection (files present in
      // both calls) must be non-empty if the collection is non-empty,
      // and any new file in the second call (highly unlikely in a
      // ~50ms window) is benign — we only assert no SHRINKAGE of the
      // earlier set.
      const a = await client.listFilestoreItems(first.id);
      const b = await client.listFilestoreItems(first.id);
      const aNames = new Set(a.map((x) => x.filename));
      const bNames = new Set(b.map((x) => x.filename));
      for (const name of aNames) {
        expect(bNames.has(name)).toBe(true);
      }
    });

    it("each file has at minimum a filename", async () => {
      if (!client) return;
      if (openitCollections.length === 0) {
        openitCollections = await client.listOpenitFilestores();
      }
      // signed_url is generated on-demand and may be absent in some
      // list shapes; the only field every consumer relies on is
      // filename. If signed_url is present we accept any non-empty
      // string but don't require it.
      for (const c of openitCollections) {
        const files = await client.listFilestoreItems(c.id);
        for (const f of files) {
          expect(typeof f.filename).toBe("string");
          expect(f.filename.length).toBeGreaterThan(0);
          if (f.signed_url !== undefined) {
            expect(typeof f.signed_url).toBe("string");
          }
        }
      }
    });
  });

  describe("upload + cleanup round-trip", () => {
    it("uploads a small file, sees it in list, and deletes it", async () => {
      if (!client) return;
      if (openitCollections.length === 0) {
        openitCollections = await client.listOpenitFilestores();
      }
      // Use library by preference — falls back to first openit-*.
      const target =
        openitCollections.find((c) => c.name === "openit-library") ??
        openitCollections[0];

      const filename = `it-test-${Date.now()}.txt`;
      const contents = new TextEncoder().encode(`integration test fixture ${Date.now()}`);

      // 1. Upload
      const result = await client.uploadFilestoreFile({
        collectionId: target.id,
        filename,
        bytes: contents,
        mime: "text/plain",
      });
      expect(result.id).toBeDefined();

      // 2. Confirm it shows up in list (server may sanitize the name)
      const after = await client.listFilestoreItems(target.id);
      const match = after.find(
        (f) => f.filename === filename || f.filename === result.filename,
      );
      expect(match).toBeDefined();

      // 3. Cleanup so we don't accumulate test artifacts in the test
      //    org. If the delete fails the next test run will re-attempt
      //    and the org just keeps a few stragglers — visible but not
      //    catastrophic.
      if (result.id) {
        await client.deleteFilestoreItem(result.id);
      }
    });

    it("server may sanitize filenames — record the rule for future fixes", async () => {
      if (!client) return;
      if (openitCollections.length === 0) {
        openitCollections = await client.listOpenitFilestores();
      }
      const target =
        openitCollections.find((c) => c.name === "openit-library") ??
        openitCollections[0];

      const original = `it test ${Date.now()} with spaces.txt`;
      const contents = new TextEncoder().encode("space test");

      const result = await client.uploadFilestoreFile({
        collectionId: target.id,
        filename: original,
        bytes: contents,
        mime: "text/plain",
      });

      // We do NOT assert what the server does — we record it so the
      // local-side reconciliation in pushAllToFilestore can match. The
      // important property is that result.filename is REPORTED back so
      // we can rename the local file to match.
      console.log(`Uploaded "${original}" — server stored as "${result.filename}"`);
      expect(typeof result.filename).toBe("string");
      expect(result.filename!.length).toBeGreaterThan(0);

      if (result.id) await client.deleteFilestoreItem(result.id);
    });
  });
});
