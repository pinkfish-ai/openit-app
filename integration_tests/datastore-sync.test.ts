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

  // -----------------------------------------------------------------
  // PIN-5793 scenario coverage. These tests pre-clean a known set of
  // openit-* fixture collections and then drive the cloud through the
  // exact REST shapes our app sends, asserting the cloud accepts them
  // and the resulting state matches what `pushAllToDatastoresImpl` /
  // `resolveProjectDatastores` expect to read back. They DO NOT drive
  // our orchestrator code in-process (no mock-Tauri layer here) — the
  // unit tests in `src/lib/{seed,entities/datastore}.test.ts` cover
  // that side. Together they bracket the full pipeline.
  // -----------------------------------------------------------------

  // Names used as test fixtures. Distinct from production defaults so
  // a test run against a production-ish org can't clobber real data.
  const FIXTURE = {
    tickets: "openit-tickets-itest",
    people: "openit-people-itest",
    conversations: "openit-conversations-itest",
    customProjects: "openit-projects-itest",
  };
  const FIXTURE_NAMES = Object.values(FIXTURE);

  // (Bundled schemas live on disk via the plugin overlay. Cloud-side
  // collections are unstructured for v1 — see DEFAULT_DATASTORES in
  // src/lib/datastoreSync.ts. No schema fixture needed here.)

  describe("PIN-5793 — default datastore shapes after auto-create", () => {
    beforeAll(async () => {
      if (!client) return;
      await client.deleteCollectionsByName(FIXTURE_NAMES);
    }, 60_000);

    afterAll(async () => {
      if (!client) return;
      await client.deleteCollectionsByName(FIXTURE_NAMES);
    }, 60_000);

    // All three defaults are intentionally created UNSTRUCTURED on the
    // cloud — see the comment on `DEFAULT_DATASTORES` in `datastoreSync.ts`.
    // The bundled `_schema.json` still lands on disk via the plugin
    // overlay so the local UI's schema-aware rendering keeps working.
    // When the cloud row-insert bug is fixed and we flip tickets/people
    // back to `isStructured: true`, just update these assertions.

    it("openit-tickets is created (unstructured for v1; bundled schema lives on disk)", async () => {
      if (!client) return;
      await client.createCollection({
        name: FIXTURE.tickets,
        type: "datastore",
        description: "IT ticket tracking",
        createdBy: config!.orgId,
        createdByName: "OpenIT (integration test)",
        triggerUrls: [],
        isStructured: false,
      });
      const list = await client.listOpenitDatastores();
      const t = list.find((c) => c.name === FIXTURE.tickets);
      expect(t).toBeDefined();
      expect(t!.isStructured).toBe(false);
    }, 60_000);

    it("openit-people is created (unstructured for v1; bundled schema lives on disk)", async () => {
      if (!client) return;
      await client.createCollection({
        name: FIXTURE.people,
        type: "datastore",
        description: "Contact/people directory",
        createdBy: config!.orgId,
        createdByName: "OpenIT (integration test)",
        triggerUrls: [],
        isStructured: false,
      });
      const list = await client.listOpenitDatastores();
      const p = list.find((c) => c.name === FIXTURE.people);
      expect(p).toBeDefined();
      expect(p!.isStructured).toBe(false);
    }, 60_000);

    it("openit-conversations is created unstructured", async () => {
      if (!client) return;
      await client.createCollection({
        name: FIXTURE.conversations,
        type: "datastore",
        description: "Per-message conversation turns",
        createdBy: config!.orgId,
        createdByName: "OpenIT (integration test)",
        triggerUrls: [],
        isStructured: false,
      });
      const list = await client.listOpenitDatastores();
      const c = list.find((cc) => cc.name === FIXTURE.conversations);
      expect(c).toBeDefined();
      expect(c!.isStructured).toBe(false);
    }, 60_000);
  });

  describe("PIN-5793 — empty cloud + push local ⇒ cloud mirrors local (defaults + custom)", () => {
    beforeAll(async () => {
      if (!client) return;
      await client.deleteCollectionsByName(FIXTURE_NAMES);
    }, 60_000);

    afterAll(async () => {
      if (!client) return;
      await client.deleteCollectionsByName(FIXTURE_NAMES);
    }, 60_000);

    it("creates the 3 defaults + 1 custom and uploads rows for each", async () => {
      if (!client) return;

      // 1. Auto-create the 3 default datastores (mirrors what
      //    resolveProjectDatastores does on first connect to a fresh
      //    org). All three are unstructured for v1 — see DEFAULT_DATASTORES
      //    comment in datastoreSync.ts.
      const tickets = await client.createCollection({
        name: FIXTURE.tickets, type: "datastore", description: "tickets",
        createdBy: config!.orgId, createdByName: "OpenIT (itest)", triggerUrls: [],
        isStructured: false,
      });
      const people = await client.createCollection({
        name: FIXTURE.people, type: "datastore", description: "people",
        createdBy: config!.orgId, createdByName: "OpenIT (itest)", triggerUrls: [],
        isStructured: false,
      });
      const conversations = await client.createCollection({
        name: FIXTURE.conversations, type: "datastore", description: "conv",
        createdBy: config!.orgId, createdByName: "OpenIT (itest)", triggerUrls: [],
        isStructured: false,
      });

      // 2. Custom datastore the user might create themselves
      //    ("default 3 + whatever else they've created").
      const projects = await client.createCollection({
        name: FIXTURE.customProjects, type: "datastore", description: "custom",
        createdBy: config!.orgId, createdByName: "OpenIT (itest)", triggerUrls: [],
        isStructured: false,
      });

      // 3. Push rows mirroring what `pushAllToDatastoresImpl` would
      //    send for the local seed bundle (5 + 5 + 2-conv) plus 1
      //    custom row to prove non-default collections work too.
      await client.postDatastoreRow(tickets.id, "sample-ticket-1", {
        subject: "Sample — Cannot access email", asker: "alice@example.com", status: "open", priority: "normal",
      });
      await client.postDatastoreRow(tickets.id, "sample-ticket-2", {
        subject: "Sample — VPN drops", asker: "bob@example.com", status: "escalated", priority: "high",
      });
      await client.postDatastoreRow(people.id, "alice", {
        firstName: "Alice", lastName: "Sample", email: "alice@example.com",
      });
      await client.postDatastoreRow(people.id, "bob", {
        firstName: "Bob", lastName: "Sample", email: "bob@example.com",
      });
      await client.postDatastoreRow(conversations.id, "msg-aa01", {
        ticketId: "sample-ticket-1", role: "asker", body: "Help!", timestamp: "2026-04-28T14:22:11Z",
      });
      await client.postDatastoreRow(conversations.id, "msg-bb01", {
        ticketId: "sample-ticket-2", role: "asker", body: "VPN broken", timestamp: "2026-04-28T16:10:00Z",
      });
      await client.postDatastoreRow(projects.id, "proj-alpha", {
        name: "Alpha", lead: "alice@example.com",
      });

      // 4. Read back and assert each collection has the rows we sent.
      const ticketsAfter = await client.listDatastoreItems(tickets.id);
      const peopleAfter = await client.listDatastoreItems(people.id);
      const convAfter = await client.listDatastoreItems(conversations.id);
      const projAfter = await client.listDatastoreItems(projects.id);

      expect(ticketsAfter.items.length).toBe(2);
      expect(peopleAfter.items.length).toBe(2);
      expect(convAfter.items.length).toBe(2);
      expect(projAfter.items.length).toBe(1);

      // Row contents survived.
      const subjects = ticketsAfter.items
        .map((r) => (r.content as any)?.subject)
        .filter(Boolean);
      expect(subjects).toEqual(
        expect.arrayContaining(["Sample — Cannot access email", "Sample — VPN drops"]),
      );

      // Conversations: ticketId field round-trips (the engine adapter
      // depends on this for the nested local layout).
      for (const r of convAfter.items) {
        expect((r.content as any)?.ticketId).toMatch(/^sample-ticket-/);
      }

      // Custom datastore is just `openit-projects-itest` — discovered
      // by the openit-* prefix filter, sync engine treats it like any
      // other unstructured collection.
      const list = await client.listOpenitDatastores();
      expect(list.map((c) => c.name)).toEqual(
        expect.arrayContaining([
          FIXTURE.tickets,
          FIXTURE.people,
          FIXTURE.conversations,
          FIXTURE.customProjects,
        ]),
      );
    }, 120_000);
  });

  describe("PIN-5793 — cloud not empty + push local ⇒ merges (no clobber)", () => {
    beforeAll(async () => {
      if (!client) return;
      await client.deleteCollectionsByName(FIXTURE_NAMES);
    }, 60_000);

    afterAll(async () => {
      if (!client) return;
      await client.deleteCollectionsByName(FIXTURE_NAMES);
    }, 60_000);

    it("pushes 3 new rows on top of 2 pre-existing and lands 5 total", async () => {
      if (!client) return;

      // Cloud-side state: tickets collection exists with 2 "remote-only" rows
      // simulating a multi-device situation (other device pushed first).
      const tickets = await client.createCollection({
        name: FIXTURE.tickets, type: "datastore", description: "tickets",
        createdBy: config!.orgId, createdByName: "OpenIT (itest)", triggerUrls: [],
        isStructured: false,
      });
      await client.postDatastoreRow(tickets.id, "remote-only-1", {
        subject: "Remote-only ticket A", asker: "remote@example.com", status: "open", priority: "normal",
      });
      await client.postDatastoreRow(tickets.id, "remote-only-2", {
        subject: "Remote-only ticket B", asker: "remote@example.com", status: "resolved", priority: "low",
      });

      // Local-side push: 3 new rows. None overlap by key with the
      // remote-only ones, so this is the no-conflict merge case.
      await client.postDatastoreRow(tickets.id, "local-1", {
        subject: "Local ticket 1", asker: "local@example.com", status: "open", priority: "normal",
      });
      await client.postDatastoreRow(tickets.id, "local-2", {
        subject: "Local ticket 2", asker: "local@example.com", status: "escalated", priority: "high",
      });
      await client.postDatastoreRow(tickets.id, "local-3", {
        subject: "Local ticket 3", asker: "local@example.com", status: "open", priority: "low",
      });

      const after = await client.listDatastoreItems(tickets.id);
      const keys = after.items.map((r) => r.key).sort();
      expect(keys).toEqual([
        "local-1", "local-2", "local-3", "remote-only-1", "remote-only-2",
      ]);
      // Remote-only rows were not modified by the local push.
      const remoteA = after.items.find((r) => r.key === "remote-only-1");
      expect((remoteA!.content as any)?.subject).toBe("Remote-only ticket A");
    }, 120_000);
  });
});
