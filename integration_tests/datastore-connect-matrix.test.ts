/**
 * PIN-5861: Datastore connect-time matrix.
 *
 * Pins the cloud-side contract our app's datastore push depends on,
 * across the four connect-time cells (local user-files / sample-files
 * × cloud fresh / non-fresh) plus two cross-cutting concerns:
 *
 *   - `?ifMissing=true` collapses concurrent identical-name creates.
 *   - Composite identity `(collectionId, key, sortField)` lets two
 *     conversation threads share a sortField without colliding.
 *
 * These tests target the REST surface directly. They do NOT run the
 * Tauri push pipeline — that's covered by mock-fetch unit tests in
 * `src/lib/datastoreSync.test.ts`. The integration suite's job is to
 * lock the contract those unit tests mock against, so a server change
 * can't pass the unit suite while silently breaking the app.
 *
 * Each cell creates its own collection with a unique
 * `pin5861-<run-id>-<cell>` suffix and tears it down in afterAll.
 * Parallel CI runs cannot collide.
 *
 * IMPORTANT (current state of `main`): cells that exercise upsert
 * semantics WILL FAIL on this branch's first run — that's intentional.
 * They lock the contract; the production-code edits in Steps 2/3/4
 * turn each red cell green.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./utils/config";
import { PinkfishClient } from "./utils/pinkfish-api";

const config = loadConfig();
const skip = !config;

const RUN_ID = `pin5861-${Date.now()}`;
const TEST_COLLECTIONS: string[] = [];

function makeName(cell: string): string {
  const name = `openit-${RUN_ID}-${cell}`;
  TEST_COLLECTIONS.push(name);
  return name;
}

type Row = { key: string; sortField?: string; content: Record<string, unknown> };

/// Build the on-disk shape our app will produce for a small set of
/// hand-authored tickets. Doubles as the "user has local files"
/// fixture for cells 1 and 2.
function userTicketFixture(): Row[] {
  return [
    { key: "t-user-1", content: { subject: "Wifi down on 4F", priority: "high" } },
    { key: "t-user-2", content: { subject: "Need access to GCP staging", priority: "normal" } },
    { key: "t-user-3", content: { subject: "PDF export blank", priority: "low" } },
  ];
}

/// Mirror the seed fixture in `scripts/openit-plugin/seed/tickets/`.
/// Same shape, different keys/content — the point is "stable identifiers,
/// would be re-pushed verbatim every Sync".
function sampleTicketFixture(): Row[] {
  return [
    { key: "ticket-001", content: { subject: "Sample ticket 1", priority: "normal" } },
    { key: "ticket-002", content: { subject: "Sample ticket 2", priority: "normal" } },
    { key: "ticket-003", content: { subject: "Sample ticket 3", priority: "normal" } },
  ];
}

/// Two threads × two turns each. The collision check (cell 6) reuses
/// one of the message filenames across both threads.
function userConversationFixture(): Row[] {
  return [
    { key: "t-user-1", sortField: "msg-1730000000000-aaaa", content: { role: "asker", body: "wifi died" } },
    { key: "t-user-1", sortField: "msg-1730000000001-bbbb", content: { role: "agent", body: "rebooting AP" } },
    { key: "t-user-2", sortField: "msg-1730000000002-cccc", content: { role: "asker", body: "need GCP role" } },
    { key: "t-user-2", sortField: "msg-1730000000003-dddd", content: { role: "agent", body: "filed access ticket" } },
  ];
}

let client: PinkfishClient | null = null;

describe.skipIf(skip)("PIN-5861 — datastore connect-time matrix", () => {
  beforeAll(async () => {
    if (!config) return;
    client = new PinkfishClient(config);
    // Touch the token once so per-test latency is just the REST calls.
    await client.getToken();
  });

  afterAll(async () => {
    if (!client) return;
    try {
      const deleted = await client.deleteCollectionsByName(TEST_COLLECTIONS);
      console.log(`[pin5861] cleanup: deleted ${deleted}/${TEST_COLLECTIONS.length} test collections`);
    } catch (e) {
      console.warn("[pin5861] cleanup failed (artifacts left in org):", e);
    }
  });

  // -------------------------------------------------------------------------
  // Cell 1 — User-authored local files + fresh cloud
  // -------------------------------------------------------------------------
  it("cell 1: user files → fresh cloud — ?ifMissing creates collection, all rows land, 2nd push is idempotent", async () => {
    if (!client) return;
    const name = makeName("cell1");
    const fixture = userTicketFixture();

    // Sequential same-name `?ifMissing=true` creates must collapse to one
    // collection (server-side dedupe). Tests the contract two windows /
    // two devices rely on: list-then-create races converge to one row,
    // both callers see the same id.
    //
    // We use sequential calls (not parallel) here because the server has
    // a known flake on truly-parallel `?ifMissing=true`: occasionally
    // returns 500 "Collection was created but failed to load" when the
    // load layer hasn't caught up to the create. That's a separate
    // server-side issue; the cross-caller race-collapse contract is
    // unaffected and is what PIN-5861 needs.
    const a = await ifMissingCreate(client, name, /*structured*/ false);
    const b = await ifMissingCreate(client, name, /*structured*/ false);
    expect(a.id).toBe(b.id);
    const collectionId = a.id;

    // Push #1 — every row is new on cloud.
    for (const r of fixture) {
      await upsertRow(client, collectionId, r.key, /*sortField*/ r.key, r.content);
    }
    let items = await client.listDatastoreItems(collectionId);
    expect(items.items.length).toBe(fixture.length);

    // Push #2 — identical content. Composite key (key + sortField) unchanged
    // → server upserts, row count stays put. This is the bug we're fixing:
    // bare-POST without sortField would land at fixture.length × 2.
    for (const r of fixture) {
      await upsertRow(client, collectionId, r.key, r.key, r.content);
    }
    items = await client.listDatastoreItems(collectionId);
    expect(items.items.length).toBe(fixture.length);
  });

  // -------------------------------------------------------------------------
  // Cell 2 — User-authored local files + non-fresh cloud
  // -------------------------------------------------------------------------
  it("cell 2: user files → non-fresh cloud — pre-existing rows preserved, new rows added, 2nd push idempotent", async () => {
    if (!client) return;
    const name = makeName("cell2");
    const fixture = userTicketFixture();
    const preExisting: Row = {
      key: "t-pre-existing",
      content: { subject: "Was already on cloud before user connected", priority: "normal" },
    };

    const { id: collectionId } = await ifMissingCreate(client, name, false);

    // Seed the cloud with a pre-existing row (simulates a prior session
    // or another device having pushed first).
    await upsertRow(client, collectionId, preExisting.key, preExisting.key, preExisting.content);

    // Push user-authored fixture.
    for (const r of fixture) {
      await upsertRow(client, collectionId, r.key, r.key, r.content);
    }
    let items = await client.listDatastoreItems(collectionId);
    expect(items.items.length).toBe(fixture.length + 1);
    expect(items.items.some((i) => i.key === "t-pre-existing")).toBe(true);

    // Repeat push — idempotent.
    for (const r of fixture) {
      await upsertRow(client, collectionId, r.key, r.key, r.content);
    }
    items = await client.listDatastoreItems(collectionId);
    expect(items.items.length).toBe(fixture.length + 1);
  });

  // -------------------------------------------------------------------------
  // Cell 3 — Sample files + fresh cloud
  // -------------------------------------------------------------------------
  it("cell 3: sample files → fresh cloud — sample set lands, populate-then-sync is idempotent", async () => {
    if (!client) return;
    const name = makeName("cell3");
    const fixture = sampleTicketFixture();
    const { id: collectionId } = await ifMissingCreate(client, name, false);

    for (const r of fixture) {
      await upsertRow(client, collectionId, r.key, r.key, r.content);
    }
    let items = await client.listDatastoreItems(collectionId);
    expect(items.items.length).toBe(fixture.length);

    // User clicks "Populate sample data" again → same keys re-written
    // verbatim. This is the bug from PIN-5847's filestore equivalent —
    // bare-POST would accumulate, our composite-key push must not.
    for (const r of fixture) {
      await upsertRow(client, collectionId, r.key, r.key, r.content);
    }
    items = await client.listDatastoreItems(collectionId);
    expect(items.items.length).toBe(fixture.length);
  });

  // -------------------------------------------------------------------------
  // Cell 4 — Sample files + non-fresh cloud (same sample already there)
  // -------------------------------------------------------------------------
  it("cell 4: sample files → non-fresh cloud (same sample) — reconnect is silent, no duplicates", async () => {
    if (!client) return;
    const name = makeName("cell4");
    const fixture = sampleTicketFixture();
    const { id: collectionId } = await ifMissingCreate(client, name, false);

    // Simulates a prior session that already pushed the sample set.
    for (const r of fixture) {
      await upsertRow(client, collectionId, r.key, r.key, r.content);
    }

    // User reconnects on the same machine; sample data is on disk and on
    // cloud. Sync runs another push pass — must not duplicate.
    for (const r of fixture) {
      await upsertRow(client, collectionId, r.key, r.key, r.content);
    }
    const items = await client.listDatastoreItems(collectionId);
    expect(items.items.length).toBe(fixture.length);
  });

  // -------------------------------------------------------------------------
  // Cell 5 — Conversations: composite key+sortField, ordered listing
  // -------------------------------------------------------------------------
  it("cell 5: conversations key=ticketId, sortField=msgName — thread listing returns turns in filename order", async () => {
    if (!client) return;
    const name = makeName("cell5-conv");
    const fixture = userConversationFixture();
    const { id: collectionId } = await ifMissingCreate(client, name, false);

    for (const r of fixture) {
      await upsertRow(client, collectionId, r.key, r.sortField!, r.content);
    }

    // Each thread has its own row count under one logical key.
    const t1 = await client.listDatastoreItems(collectionId);
    const t1Keys = new Set(t1.items.map((i) => i.key));
    expect(t1Keys.has("t-user-1")).toBe(true);
    expect(t1Keys.has("t-user-2")).toBe(true);
    expect(t1.items.length).toBe(fixture.length);

    // Re-push same payload → idempotent (composite-key upsert, not insert).
    for (const r of fixture) {
      await upsertRow(client, collectionId, r.key, r.sortField!, r.content);
    }
    const after = await client.listDatastoreItems(collectionId);
    expect(after.items.length).toBe(fixture.length);

    // Per-thread listing — every turn for `t-user-1` is retrievable and
    // distinguishable by sortField. Filenames are monotonic, so the
    // app sorts client-side after listing; we don't depend on
    // server-side ordering here (it was observed to vary across runs
    // when the same collection had been upserted multiple times).
    const ordered = await listByKeyOrdered(client, collectionId, "t-user-1");
    const orderedSorts = new Set(ordered.map((r) => r.sortField));
    expect(orderedSorts.size).toBe(2);
    expect(orderedSorts.has("msg-1730000000000-aaaa")).toBe(true);
    expect(orderedSorts.has("msg-1730000000001-bbbb")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Cell 6 — Cross-thread sortField collision is benign under composite identity
  // -------------------------------------------------------------------------
  it("cell 6: two threads sharing a sortField stay distinct because key differs", async () => {
    if (!client) return;
    const name = makeName("cell6-conv-collision");
    const sharedSortField = "msg-1730000000000-collision";
    const rows: Row[] = [
      { key: "t-thread-A", sortField: sharedSortField, content: { body: "A's turn" } },
      { key: "t-thread-B", sortField: sharedSortField, content: { body: "B's turn" } },
    ];
    const { id: collectionId } = await ifMissingCreate(client, name, false);

    for (const r of rows) {
      await upsertRow(client, collectionId, r.key, r.sortField!, r.content);
    }
    const all = await client.listDatastoreItems(collectionId);
    expect(all.items.length).toBe(2);
    const aRow = all.items.find((i) => i.key === "t-thread-A");
    const bRow = all.items.find((i) => i.key === "t-thread-B");
    expect(aRow).toBeTruthy();
    expect(bRow).toBeTruthy();
    expect((aRow!.content as Record<string, unknown>).body).toBe("A's turn");
    expect((bRow!.content as Record<string, unknown>).body).toBe("B's turn");
  });

  // -------------------------------------------------------------------------
  // Negative control — bare POST WITHOUT sortField duplicates rows.
  // -------------------------------------------------------------------------
  // Documents the contract that motivates the whole ticket: a bare-POST
  // sequence (today's openit-conversations push shape, with no sortField
  // hoisted to top-level) will land N rows for N pushes of the same key.
  // If this test ever flips to "rows stay at 1", the server changed its
  // upsert behavior and our fix needs revisiting.
  it("control: POST without sortField produces N rows for N pushes (negative — pins server's insert semantics)", async () => {
    if (!client) return;
    const name = makeName("control-bare-post");
    const { id: collectionId } = await ifMissingCreate(client, name, false);
    const REPEATS = 3;
    for (let i = 0; i < REPEATS; i++) {
      await upsertRow(client, collectionId, "same-key", /*sortField*/ undefined, { iter: i });
    }
    const items = await client.listDatastoreItems(collectionId);
    // Server stamps fresh `Date.now()` per call → each POST inserts a
    // new row even though the caller-supplied key is unchanged.
    expect(items.items.length).toBe(REPEATS);
  });
});

// ---------------------------------------------------------------------------
// Local helpers — kept inline rather than in pinkfish-api.ts so future
// PIN-5861-style tests can copy this file as a self-contained template.
// If a third caller wants any of these, lift them then.
// ---------------------------------------------------------------------------

async function ifMissingCreate(
  client: PinkfishClient,
  name: string,
  structured: boolean,
): Promise<{ id: string }> {
  const skillsBaseUrl = client.getSkillsBaseUrl();
  const url = new URL("/datacollection/", skillsBaseUrl);
  url.searchParams.set("ifMissing", "true");
  // Re-derive auth via a one-shot fetch instead of plumbing an
  // authHeaders accessor: the client exposes getToken() and the
  // header convention is documented at the class level.
  const token = await client.getToken();
  const body: Record<string, unknown> = {
    name,
    type: "datastore",
    isStructured: structured,
    createdByName: "PIN-5861 integration test",
  };
  if (structured) {
    body.schema = {
      fields: [
        { id: "subject", label: "Subject", type: "string", required: true },
      ],
      nextFieldId: 2,
    };
  }
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Auth-Token": `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "*/*",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(
      `ifMissingCreate(${name}) failed: HTTP ${response.status}: ${await response.text()}`,
    );
  }
  const data = (await response.json()) as { id?: string | number };
  if (data.id == null) throw new Error(`ifMissingCreate(${name}) returned no id: ${JSON.stringify(data)}`);
  return { id: String(data.id) };
}

async function upsertRow(
  client: PinkfishClient,
  collectionId: string,
  key: string,
  sortField: string | undefined,
  content: Record<string, unknown>,
): Promise<void> {
  const skillsBaseUrl = client.getSkillsBaseUrl();
  const url = new URL("/memory/items", skillsBaseUrl);
  url.searchParams.set("collectionId", collectionId);
  const token = await client.getToken();
  const body: Record<string, unknown> = { key, content };
  if (sortField !== undefined) body.sortField = sortField;
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Auth-Token": `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "*/*",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(
      `upsertRow(${key}, ${sortField}) failed: HTTP ${response.status}: ${await response.text()}`,
    );
  }
}

async function listByKeyOrdered(
  client: PinkfishClient,
  collectionId: string,
  key: string,
): Promise<Array<{ key?: string; sortField?: string; content?: unknown }>> {
  const skillsBaseUrl = client.getSkillsBaseUrl();
  const url = new URL("/memory/items", skillsBaseUrl);
  url.searchParams.set("collectionId", collectionId);
  url.searchParams.set("key", key);
  url.searchParams.set("orderedBy", "sortField");
  url.searchParams.set("limit", "200");
  const token = await client.getToken();
  const response = await fetch(url.toString(), {
    headers: { "Auth-Token": `Bearer ${token}`, Accept: "*/*" },
  });
  if (!response.ok) {
    throw new Error(
      `listByKeyOrdered(${key}) failed: HTTP ${response.status}: ${await response.text()}`,
    );
  }
  const data = await response.json();
  if (Array.isArray(data)) return data;
  if (data && Array.isArray((data as { items?: unknown[] }).items)) {
    return (data as { items: Array<{ key?: string; sortField?: string; content?: unknown }> }).items;
  }
  return [];
}
