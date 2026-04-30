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

  describe("flavor inspection — tickets+people structured, conversations unstructured", () => {
    it("openit-tickets default is structured with the bundled schema", async () => {
      if (!client) return;
      if (openitDatastores.length === 0) {
        openitDatastores = await client.listOpenitDatastores();
      }
      const tickets = openitDatastores.find((c) => c.name === "openit-tickets");
      if (!tickets) {
        console.log("  openit-tickets not yet auto-created; skipping flavor check");
        return;
      }
      expect(tickets.isStructured).toBe(true);
      expect(tickets.schema?.fields?.length).toBeGreaterThan(0);
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

  function uniqueName(base: string): string {
    return `${base}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  // (Bundled schemas live on disk via the plugin overlay. Cloud-side
  // collections are unstructured for v1 — see DEFAULT_DATASTORES in
  // src/lib/datastoreSync.ts. No schema fixture needed here.)

  // Bundled schemas — tests don't `import` the JSON (vitest config doesn't
  // include scripts/) so we paste a minimal subset of fields here. The full
  // schemas are at `scripts/openit-plugin/schemas/{tickets,people}._schema.json`
  // and `src/lib/seed.shape.test.ts` validates the seed against them.
  const TICKETS_SCHEMA = {
    fields: [
      { id: "subject", label: "Subject", type: "string", required: true },
      { id: "description", label: "Description", type: "text", required: true },
      { id: "asker", label: "From", type: "string", required: true },
      { id: "status", label: "Status", type: "enum", required: true,
        values: ["incoming", "agent-responding", "open", "escalated", "resolved", "closed"] },
    ],
    nextFieldId: 5,
  };
  const PEOPLE_SCHEMA = {
    fields: [
      { id: "firstName", label: "First name", type: "string", required: true },
      { id: "lastName", label: "Last name", type: "string", nullable: true },
      { id: "email", label: "Email", type: "string", nullable: true },
      { id: "createdAt", label: "Added", type: "datetime", required: true },
      { id: "updatedAt", label: "Last update", type: "datetime", required: true },
    ],
    nextFieldId: 6,
  };

  describe("PIN-5793 — default datastore shapes after auto-create", () => {
    beforeAll(async () => {
      if (!client) return;
      await client.deleteCollectionsByName(FIXTURE_NAMES);
    }, 60_000);

    afterAll(async () => {
      if (!client) return;
      await client.deleteCollectionsByName(FIXTURE_NAMES);
    }, 60_000);

    // tickets + people are STRUCTURED on the cloud, with the bundled
    // schema posted in the create body. conversations is unstructured
    // (per-message rows linked by `content.ticketId`). This matches the
    // brief contract; cloud fix #1 makes the structured-with-caller-
    // schema-and-no-template-data path work. Row-insert against
    // structured collections additionally requires firebase-helpers#462
    // deployed (see the gated `… empty cloud + push local` block below).

    it("openit-tickets is created structured with the bundled tickets schema", async () => {
      if (!client) return;
      await client.createCollection({
        name: FIXTURE.tickets,
        type: "datastore",
        description: "IT ticket tracking",
        createdBy: config!.orgId,
        createdByName: "OpenIT (integration test)",
        triggerUrls: [],
        isStructured: true,
        schema: TICKETS_SCHEMA,
      });
      const list = await client.listOpenitDatastores();
      const t = list.find((c) => c.name === FIXTURE.tickets);
      expect(t).toBeDefined();
      expect(t!.isStructured).toBe(true);
      const ids = (t!.schema?.fields ?? []).map((f) => f.id);
      expect(ids).toEqual(expect.arrayContaining(["subject", "asker", "status"]));
    }, 60_000);

    it("openit-people is created structured with the bundled people schema", async () => {
      if (!client) return;
      await client.createCollection({
        name: FIXTURE.people,
        type: "datastore",
        description: "Contact/people directory",
        createdBy: config!.orgId,
        createdByName: "OpenIT (integration test)",
        triggerUrls: [],
        isStructured: true,
        schema: PEOPLE_SCHEMA,
      });
      const list = await client.listOpenitDatastores();
      const p = list.find((c) => c.name === FIXTURE.people);
      expect(p).toBeDefined();
      expect(p!.isStructured).toBe(true);
      const ids = (p!.schema?.fields ?? []).map((f) => f.id);
      expect(ids).toEqual(expect.arrayContaining(["firstName", "email"]));
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

    // The structured-row-push path requires firebase-helpers PR #462
    // (semantic-id row insert) deployed to the env under test. We
    // detect it at runtime: try to insert one row keyed by a semantic
    // id; if the cloud rejects with `Unknown column`, the deploy
    // hasn't happened yet — log + soft-skip the assertions that depend
    // on structured pushes (auto-create + unstructured push still
    // run). Once the deploy lands, the same test stops soft-skipping.

    async function semanticIdRowInsertSupported(client: PinkfishClient): Promise<boolean> {
      const probeName = uniqueName("pin5793-probe-fix6");
      let probe: { id: string } | null = null;
      try {
        const created = await client.createCollection({
          name: probeName, type: "datastore", description: "probe",
          createdBy: config!.orgId, createdByName: "OpenIT (probe)", triggerUrls: [],
          isStructured: true,
          schema: { fields: [{ id: "firstName", label: "First name", type: "string", required: true }], nextFieldId: 2 },
        });
        probe = created;
        await client.postDatastoreRow(created.id, "probe-1", { firstName: "Probe" });
        return true;
      } catch (err) {
        const msg = String(err);
        if (msg.includes("Unknown column")) return false;
        throw err;
      } finally {
        if (probe?.id) await client.deleteCollection(probe.id).catch(() => undefined);
      }
    }

    it("creates the 3 defaults + 1 custom and uploads rows for each", async () => {
      if (!client) return;

      // 1. Auto-create the 4 collections — tickets+people structured
      //    with bundled schemas, conversations + custom unstructured.
      //    Mirrors what `resolveProjectDatastores` does on first connect.
      const tickets = await client.createCollection({
        name: FIXTURE.tickets, type: "datastore", description: "tickets",
        createdBy: config!.orgId, createdByName: "OpenIT (itest)", triggerUrls: [],
        isStructured: true, schema: TICKETS_SCHEMA,
      });
      const people = await client.createCollection({
        name: FIXTURE.people, type: "datastore", description: "people",
        createdBy: config!.orgId, createdByName: "OpenIT (itest)", triggerUrls: [],
        isStructured: true, schema: PEOPLE_SCHEMA,
      });
      const conversations = await client.createCollection({
        name: FIXTURE.conversations, type: "datastore", description: "conv",
        createdBy: config!.orgId, createdByName: "OpenIT (itest)", triggerUrls: [],
        isStructured: false,
      });
      const projects = await client.createCollection({
        name: FIXTURE.customProjects, type: "datastore", description: "custom",
        createdBy: config!.orgId, createdByName: "OpenIT (itest)", triggerUrls: [],
        isStructured: false,
      });

      // 2. Auto-create assertions land regardless of cloud-fix #6 deploy.
      const list = await client.listOpenitDatastores();
      expect(list.map((c) => c.name)).toEqual(
        expect.arrayContaining([
          FIXTURE.tickets, FIXTURE.people, FIXTURE.conversations, FIXTURE.customProjects,
        ]),
      );
      const tStored = list.find((c) => c.name === FIXTURE.tickets);
      const pStored = list.find((c) => c.name === FIXTURE.people);
      expect(tStored?.isStructured).toBe(true);
      expect(pStored?.isStructured).toBe(true);

      // 3. Unstructured rows (conversations + custom) push regardless
      //    of cloud-fix-#6 deploy — they have no schema so no resolver
      //    issue.
      await client.postDatastoreRow(conversations.id, "msg-aa01", {
        ticketId: "sample-ticket-1", role: "asker", body: "Help!", timestamp: "2026-04-28T14:22:11Z",
      });
      await client.postDatastoreRow(conversations.id, "msg-bb01", {
        ticketId: "sample-ticket-2", role: "asker", body: "VPN broken", timestamp: "2026-04-28T16:10:00Z",
      });
      await client.postDatastoreRow(projects.id, "proj-alpha", {
        name: "Alpha", lead: "alice@example.com",
      });

      const convAfter = await client.listDatastoreItems(conversations.id);
      const projAfter = await client.listDatastoreItems(projects.id);
      expect(convAfter.items.length).toBe(2);
      expect(projAfter.items.length).toBe(1);
      for (const r of convAfter.items) {
        expect((r.content as any)?.ticketId).toMatch(/^sample-ticket-/);
      }

      // 4. Structured rows (tickets + people, semantic-id keyed
      //    content) — the production push shape. Soft-skip when the
      //    cloud row-insert fix isn't deployed yet.
      const fix6 = await semanticIdRowInsertSupported(client);
      if (!fix6) {
        console.log(
          "  ⏭  firebase-helpers#462 (semantic-id row insert) not yet deployed — skipping structured row assertions",
        );
        return;
      }

      await client.postDatastoreRow(tickets.id, "sample-ticket-1", {
        subject: "Sample — Cannot access email",
        description: "Cannot log in to email after password change.",
        asker: "alice@example.com", status: "open",
      });
      await client.postDatastoreRow(tickets.id, "sample-ticket-2", {
        subject: "Sample — VPN drops",
        description: "VPN keeps disconnecting in coffee shop wifi.",
        asker: "bob@example.com", status: "escalated",
      });
      await client.postDatastoreRow(people.id, "alice", {
        firstName: "Alice", lastName: "Sample", email: "alice@example.com",
        createdAt: "2026-04-26T09:00:00Z", updatedAt: "2026-04-28T14:22:11Z",
      });
      await client.postDatastoreRow(people.id, "bob", {
        firstName: "Bob", lastName: "Sample", email: "bob@example.com",
        createdAt: "2026-04-25T15:30:00Z", updatedAt: "2026-04-28T16:55:02Z",
      });

      const ticketsAfter = await client.listDatastoreItems(tickets.id);
      const peopleAfter = await client.listDatastoreItems(people.id);
      expect(ticketsAfter.items.length).toBe(2);
      expect(peopleAfter.items.length).toBe(2);
      const subjects = ticketsAfter.items.map((r) => (r.content as any)?.subject).filter(Boolean);
      expect(subjects).toEqual(
        expect.arrayContaining(["Sample — Cannot access email", "Sample — VPN drops"]),
      );
    }, 180_000);
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

    // Uses the unstructured `openit-conversations` collection so the
    // assertion runs regardless of firebase-helpers#462 deploy state.
    // The merge invariant ("local rows added without clobbering remote
    // rows") is engine-level, not flavor-specific.
    it("pushes 3 new rows on top of 2 pre-existing and lands 5 total", async () => {
      if (!client) return;

      const conversations = await client.createCollection({
        name: FIXTURE.conversations, type: "datastore", description: "conv-merge",
        createdBy: config!.orgId, createdByName: "OpenIT (itest)", triggerUrls: [],
        isStructured: false,
      });
      // Cloud-side state: 2 remote-only conversation rows (simulating a
      // sibling device that pushed first).
      await client.postDatastoreRow(conversations.id, "remote-only-msg-1", {
        ticketId: "remote-thread-A", role: "asker", body: "remote A", timestamp: "2026-04-28T14:00:00Z",
      });
      await client.postDatastoreRow(conversations.id, "remote-only-msg-2", {
        ticketId: "remote-thread-B", role: "asker", body: "remote B", timestamp: "2026-04-28T15:00:00Z",
      });

      // Local-side push: 3 new rows. None overlap by key.
      await client.postDatastoreRow(conversations.id, "local-msg-1", {
        ticketId: "local-thread-X", role: "asker", body: "local 1", timestamp: "2026-04-28T16:00:00Z",
      });
      await client.postDatastoreRow(conversations.id, "local-msg-2", {
        ticketId: "local-thread-X", role: "agent", body: "local 2", timestamp: "2026-04-28T16:01:00Z",
      });
      await client.postDatastoreRow(conversations.id, "local-msg-3", {
        ticketId: "local-thread-Y", role: "asker", body: "local 3", timestamp: "2026-04-28T17:00:00Z",
      });

      const after = await client.listDatastoreItems(conversations.id);
      const keys = (after.items.map((r) => r.key).filter(Boolean) as string[]).sort();
      expect(keys).toEqual([
        "local-msg-1", "local-msg-2", "local-msg-3",
        "remote-only-msg-1", "remote-only-msg-2",
      ]);
      // Remote-only rows weren't modified by the local push.
      const remoteA = after.items.find((r) => r.key === "remote-only-msg-1");
      expect((remoteA!.content as any)?.body).toBe("remote A");
    }, 180_000);
  });
});
