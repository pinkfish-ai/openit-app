/**
 * Conversations sync — composite (key, sortField) round-trip integration test.
 *
 * Confirms the cloud-side contract that the upcoming openit-app change
 * depends on: `openit-conversations` rows are addressed compositely as
 * `(key=ticketId, sortField=msgId)`, mirroring the on-disk
 * `databases/conversations/<ticketId>/<msgId>.json` layout.
 *
 * What's verified against the real API (firebase-helpers `dev*`):
 *   1. POST with both key+sortField round-trips through GET — both
 *      legs of the composite come back populated.
 *   2. Two rows with the same `sortField` but different `key`s coexist
 *      as distinct rows (no collision). This is the core property:
 *      `databases/conversations/T1/msg-X.json` and
 *      `databases/conversations/T2/msg-X.json` push as two cloud rows,
 *      not one with first-writer-wins.
 *   3. POST without `sortField` lets the cloud auto-stamp it with
 *      `Date.now().toString()`. Documents the *current* (PIN-5793) shape
 *      so the diff to PIN-#### is explicit, AND so a future regression
 *      that breaks the auto-stamp branch is loud.
 *   4. `?key=<x>` filter on the list endpoint returns only matching
 *      rows. Enables future per-ticket queries; not load-bearing for
 *      v1 sync but cheap to confirm now.
 *   5. Routing-by-key works without `content.ticketId`. The pull side
 *      will derive subdir from `row.key` directly — content can omit
 *      `ticketId` entirely and the row is still pullable. This is
 *      the property that lets us drop `extractTicketId` and the
 *      missing-ticketId warn-and-skip path.
 *
 * Skipped without `integration_tests/test-config.json` present.
 *
 * What's NOT covered here:
 *   - openit-app's `pushAllToDatastoresImpl` / `entities/datastore.ts`
 *     are unit-tested separately. This file is purely a cloud-contract
 *     check — same pattern as `datastore-sync.test.ts`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { loadConfig } from "./utils/config";
import { PinkfishClient } from "./utils/pinkfish-api";

const config = loadConfig();
const skip = !config;

let client: PinkfishClient | null = null;

const FIXTURE_NAME = "openit-conversations-composite-itest";

describe.skipIf(skip)("Conversations composite (key, sortField) — real integration", () => {
  beforeAll(async () => {
    if (!config) return;
    client = new PinkfishClient(config);
    await client.deleteCollectionsByName([FIXTURE_NAME]);
  }, 60_000);

  afterAll(async () => {
    if (!client) return;
    await client.deleteCollectionsByName([FIXTURE_NAME]);
  }, 60_000);

  it("round-trips composite (key, sortField) through POST → GET", async () => {
    if (!client) return;
    const col = await client.createCollection({
      name: FIXTURE_NAME,
      type: "datastore",
      description: "composite key round-trip",
      createdBy: config!.orgId,
      createdByName: "OpenIT (composite-itest)",
      triggerUrls: [],
      isStructured: false,
    });

    await client.postDatastoreRow(
      col.id,
      "sample-ticket-1",
      {
        id: "msg-1745848931000-aa01",
        ticketId: "sample-ticket-1",
        role: "asker",
        sender: "alice@example.com",
        timestamp: "2026-04-28T14:22:11Z",
        body: "round-trip body",
      },
      "msg-1745848931000-aa01",
    );

    const after = await client.listDatastoreItems(col.id);
    const row = after.items.find((r) => r.key === "sample-ticket-1");
    expect(row).toBeDefined();
    expect(row!.sortField).toBe("msg-1745848931000-aa01");
    expect((row!.content as Record<string, unknown>)?.body).toBe("round-trip body");
  }, 120_000);

  it("treats (key=T1, sortField=msg-X) and (key=T2, sortField=msg-X) as distinct rows", async () => {
    if (!client) return;
    // Reuses the collection from the round-trip test — these rows have
    // distinct (key, sortField) pairs from above so no collision.
    const col = (await client.listOpenitDatastores()).find(
      (c) => c.name === FIXTURE_NAME,
    );
    expect(col).toBeDefined();

    const sharedSortField = "msg-shared-1745900000000-zz01";
    await client.postDatastoreRow(
      col!.id,
      "ticket-A",
      { ticketId: "ticket-A", role: "asker", body: "from A" },
      sharedSortField,
    );
    await client.postDatastoreRow(
      col!.id,
      "ticket-B",
      { ticketId: "ticket-B", role: "asker", body: "from B" },
      sharedSortField,
    );

    const all = await client.listDatastoreItems(col!.id);
    const sharing = all.items.filter((r) => r.sortField === sharedSortField);
    expect(sharing.length).toBe(2);
    const keys = sharing.map((r) => r.key).sort();
    expect(keys).toEqual(["ticket-A", "ticket-B"]);

    // Bodies didn't bleed across rows — the composite really is the
    // primary key, not just (key) with sortField as a tag.
    const a = sharing.find((r) => r.key === "ticket-A");
    const b = sharing.find((r) => r.key === "ticket-B");
    expect((a!.content as Record<string, unknown>)?.body).toBe("from A");
    expect((b!.content as Record<string, unknown>)?.body).toBe("from B");
  }, 120_000);

  it("auto-stamps sortField with Date.now() when caller omits it (current PIN-5793 shape)", async () => {
    if (!client) return;
    const col = (await client.listOpenitDatastores()).find(
      (c) => c.name === FIXTURE_NAME,
    );
    expect(col).toBeDefined();

    const beforeMs = Date.now();
    await client.postDatastoreRow(col!.id, "auto-stamp-key", {
      body: "no sortField sent",
    });
    const afterMs = Date.now();

    const list = await client.listDatastoreItems(col!.id, { key: "auto-stamp-key" });
    expect(list.items.length).toBeGreaterThan(0);
    const row = list.items.find((r) => r.key === "auto-stamp-key");
    expect(row).toBeDefined();
    expect(row!.sortField).toBeTruthy();
    // Cloud sets `sortField = Date.now().toString()` — should be a 13-digit
    // ms-since-epoch within our request window. (firebase-helpers
    // owner.ts:174-176, 308-311.)
    const stamp = Number(row!.sortField);
    expect(Number.isFinite(stamp)).toBe(true);
    expect(stamp).toBeGreaterThanOrEqual(beforeMs - 1000);
    expect(stamp).toBeLessThanOrEqual(afterMs + 1000);
  }, 120_000);

  it("filters list to a single ticket via ?key=<ticketId>", async () => {
    if (!client) return;
    const col = (await client.listOpenitDatastores()).find(
      (c) => c.name === FIXTURE_NAME,
    );
    expect(col).toBeDefined();

    // Two rows under ticket-A (created above + a second one), one under
    // ticket-B. Filter on ticket-A should return exactly two.
    await client.postDatastoreRow(
      col!.id,
      "ticket-A",
      { ticketId: "ticket-A", body: "second turn" },
      "msg-second-1745900100000-zz02",
    );

    const onlyA = await client.listDatastoreItems(col!.id, { key: "ticket-A" });
    expect(onlyA.items.length).toBeGreaterThanOrEqual(2);
    expect(onlyA.items.every((r) => r.key === "ticket-A")).toBe(true);

    const onlyB = await client.listDatastoreItems(col!.id, { key: "ticket-B" });
    expect(onlyB.items.length).toBeGreaterThanOrEqual(1);
    expect(onlyB.items.every((r) => r.key === "ticket-B")).toBe(true);
  }, 120_000);

  it("pulls a row whose content omits ticketId — routing comes from key, not content", async () => {
    if (!client) return;
    const col = (await client.listOpenitDatastores()).find(
      (c) => c.name === FIXTURE_NAME,
    );
    expect(col).toBeDefined();

    // Push a minimal-content row: no `ticketId` field anywhere in
    // content. Today's pull would `console.warn` and drop. After the
    // PIN-#### change, the pull side derives the subdir from
    // `row.key` directly, so the row should still be pullable —
    // proven here by the row being addressable on read.
    await client.postDatastoreRow(
      col!.id,
      "ticket-no-ticketid-in-content",
      { body: "content has no ticketId field", role: "asker" },
      "msg-bare-content-1745900200000-zz03",
    );

    const list = await client.listDatastoreItems(col!.id, {
      key: "ticket-no-ticketid-in-content",
    });
    const row = list.items.find(
      (r) => r.sortField === "msg-bare-content-1745900200000-zz03",
    );
    expect(row).toBeDefined();
    expect(row!.key).toBe("ticket-no-ticketid-in-content");
    const content = row!.content as Record<string, unknown>;
    expect(content?.ticketId).toBeUndefined();
    expect(content?.body).toBe("content has no ticketId field");
  }, 120_000);

  it("deletes by composite (key, sortField) — leaves the sibling row intact", async () => {
    if (!client) return;
    const col = (await client.listOpenitDatastores()).find(
      (c) => c.name === FIXTURE_NAME,
    );
    expect(col).toBeDefined();

    // Earlier test created two rows with sortField = msg-shared-…
    // Delete just the ticket-A copy and confirm ticket-B's row survives.
    const sharedSortField = "msg-shared-1745900000000-zz01";
    await client.deleteDatastoreRowByCompositeKey(col!.id, "ticket-A", sharedSortField);

    const onlyB = await client.listDatastoreItems(col!.id, { key: "ticket-B" });
    const survivor = onlyB.items.find((r) => r.sortField === sharedSortField);
    expect(survivor).toBeDefined();
    expect((survivor!.content as Record<string, unknown>)?.body).toBe("from B");

    const onlyA = await client.listDatastoreItems(col!.id, { key: "ticket-A" });
    const goneA = onlyA.items.find((r) => r.sortField === sharedSortField);
    expect(goneA).toBeUndefined();
  }, 120_000);
});
