/**
 * datastoreAdapter unit tests.
 *
 * Two flavors covered:
 *   1. Flat collections (`openit-tickets` and friends) — local subdir
 *      strips the `openit-` prefix; manifestKey is `<colName>/<key>`.
 *   2. Nested conversations — local subdir is one level deep
 *      (`databases/conversations/<ticketId>/<msgId>.json`); routing is
 *      derived from the cloud row's `(key, sortField)` composite, NOT
 *      from `content.ticketId`. Two folders sharing a msgId stay
 *      distinct because the manifestKey carries the sortField too.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api", () => ({
  datastoreStateLoad: vi.fn(),
  datastoreStateSave: vi.fn(),
  entityDeleteFile: vi.fn(),
  entityListLocal: vi.fn(),
  entityWriteFile: vi.fn(),
  fsList: vi.fn(),
}));
vi.mock("./datastoreApi", () => ({
  fetchDatastoreItems: vi.fn(),
}));

import { fetchDatastoreItems } from "./datastoreApi";
import { entityListLocal, fsList } from "../api";
import { datastoreAdapter } from "./datastore";
import type { DataCollection, MemoryItem } from "../skillsApi";

const mockFetchItems = vi.mocked(fetchDatastoreItems);
const mockFsList = vi.mocked(fsList);
const mockEntityListLocal = vi.mocked(entityListLocal);
const FAKE_CREDS = { orgId: "org-1", tokenUrl: "https://app-api.example/oauth/token" } as any;

function ticketsCol(): DataCollection {
  return {
    id: "ds-tickets",
    name: "openit-tickets",
    type: "datastore",
    isStructured: true,
  } as DataCollection;
}
function conversationsCol(): DataCollection {
  return {
    id: "ds-conv",
    name: "openit-conversations",
    type: "datastore",
    isStructured: false,
  } as DataCollection;
}

function row(
  key: string,
  sortField: string,
  content: unknown,
  updatedAt = "2026-04-30T00:00:00Z",
): MemoryItem {
  return {
    id: `id-${key}-${sortField}`,
    key,
    sortField,
    content,
    updatedAt,
  } as MemoryItem;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("datastoreAdapter — flat collection routing", () => {
  it("openit-tickets row writes to databases/tickets/<key>.json with simple manifestKey", async () => {
    mockFetchItems.mockResolvedValueOnce({
      items: [row("CS-1", "CS-1", { subject: "Reset" })],
      pagination: { hasNextPage: false },
    } as any);

    const adapter = datastoreAdapter({
      creds: FAKE_CREDS,
      collections: [ticketsCol()],
    });
    const result = await adapter.listRemote("/repo", {
      collection_id: null,
      collection_name: null,
      files: {},
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].workingTreePath).toBe("databases/tickets/CS-1.json");
    expect(result.items[0].manifestKey).toBe("openit-tickets/CS-1");
  });
});

describe("datastoreAdapter — openit-conversations composite-keyed pull", () => {
  it("routes via (row.key, row.sortField) into databases/conversations/<key>/<sortField>.json", async () => {
    mockFetchItems.mockResolvedValueOnce({
      items: [
        row("T1", "msg-aa01", { body: "hello" }),
        row("T2", "msg-bb01", { body: "world" }),
      ],
      pagination: { hasNextPage: false },
    } as any);

    const adapter = datastoreAdapter({
      creds: FAKE_CREDS,
      collections: [conversationsCol()],
    });
    const result = await adapter.listRemote("/repo", {
      collection_id: null,
      collection_name: null,
      files: {},
    });

    expect(result.items.map((r) => r.workingTreePath)).toEqual([
      "databases/conversations/T1/msg-aa01.json",
      "databases/conversations/T2/msg-bb01.json",
    ]);
    expect(result.items.map((r) => r.manifestKey)).toEqual([
      "openit-conversations/T1/msg-aa01",
      "openit-conversations/T2/msg-bb01",
    ]);
  });

  it("treats two rows with the same sortField but different keys as distinct items", async () => {
    // Cross-ticket msgId reuse — the property the composite key exists
    // to enable. Both rows must produce distinct manifestKeys and
    // distinct on-disk paths.
    mockFetchItems.mockResolvedValueOnce({
      items: [
        row("T1", "msg-shared", { body: "from T1" }),
        row("T2", "msg-shared", { body: "from T2" }),
      ],
      pagination: { hasNextPage: false },
    } as any);

    const adapter = datastoreAdapter({
      creds: FAKE_CREDS,
      collections: [conversationsCol()],
    });
    const result = await adapter.listRemote("/repo", {
      collection_id: null,
      collection_name: null,
      files: {},
    });

    expect(result.items).toHaveLength(2);
    const manifestKeys = new Set(result.items.map((r) => r.manifestKey));
    expect(manifestKeys.size).toBe(2);
    expect(manifestKeys).toEqual(
      new Set([
        "openit-conversations/T1/msg-shared",
        "openit-conversations/T2/msg-shared",
      ]),
    );
  });

  it("routes a row whose content has no ticketId — routing is keyed off the row, not the content", async () => {
    // The pre-PIN-#### code dropped these with a console.warn. After
    // the composite-key change they pull cleanly because the routing
    // information lives in `row.key` / `row.sortField`, not in content.
    mockFetchItems.mockResolvedValueOnce({
      items: [row("T1", "msg-aa01", { body: "no ticketId in content" })],
      pagination: { hasNextPage: false },
    } as any);

    const adapter = datastoreAdapter({
      creds: FAKE_CREDS,
      collections: [conversationsCol()],
    });
    const result = await adapter.listRemote("/repo", {
      collection_id: null,
      collection_name: null,
      files: {},
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].workingTreePath).toBe(
      "databases/conversations/T1/msg-aa01.json",
    );
  });

  it("warn-skips a row with empty sortField (malformed cloud response)", async () => {
    // sortField is required on the read model (firebase-helpers
    // MemoryItem.sortField). An empty string would file the row at
    // `databases/conversations/T1/.json`, which is gibberish — drop
    // and warn instead.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetchItems.mockResolvedValueOnce({
      items: [
        row("T1", "msg-good", { body: "ok" }),
        row("T2", "", { body: "malformed" }),
      ],
      pagination: { hasNextPage: false },
    } as any);

    const adapter = datastoreAdapter({
      creds: FAKE_CREDS,
      collections: [conversationsCol()],
    });
    const result = await adapter.listRemote("/repo", {
      collection_id: null,
      collection_name: null,
      files: {},
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].manifestKey).toBe("openit-conversations/T1/msg-good");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("datastoreAdapter — listLocal emits composite manifestKey for conversations", () => {
  it("conversations local file at <ticketId>/<msgId>.json maps to openit-conversations/<ticketId>/<msgId>", async () => {
    // Outer fsList sees one ticket folder.
    mockFsList.mockResolvedValueOnce([
      { name: "T1", path: "/repo/databases/conversations/T1", is_dir: true } as any,
    ]);
    // Inner entityListLocal sees one message file in that folder.
    mockEntityListLocal.mockResolvedValueOnce([
      { filename: "msg-aa01.json", mtime_ms: 1700000000000 } as any,
    ]);

    const adapter = datastoreAdapter({
      creds: FAKE_CREDS,
      collections: [conversationsCol()],
    });
    const local = await adapter.listLocal("/repo");

    expect(local).toHaveLength(1);
    expect(local[0].manifestKey).toBe("openit-conversations/T1/msg-aa01");
    expect(local[0].workingTreePath).toBe(
      "databases/conversations/T1/msg-aa01.json",
    );
    expect(local[0].isShadow).toBe(false);
  });

  it("two ticket folders sharing msg-X.json produce two distinct local items", async () => {
    // The other half of the cross-ticket dup-msgId property: local
    // listing must produce two entries that won't alias when matched
    // against the remote listing.
    mockFsList.mockResolvedValueOnce([
      { name: "T1", path: "/repo/databases/conversations/T1", is_dir: true } as any,
      { name: "T2", path: "/repo/databases/conversations/T2", is_dir: true } as any,
    ]);
    mockEntityListLocal
      .mockResolvedValueOnce([
        { filename: "msg-X.json", mtime_ms: 1700000000000 } as any,
      ])
      .mockResolvedValueOnce([
        { filename: "msg-X.json", mtime_ms: 1700000001000 } as any,
      ]);

    const adapter = datastoreAdapter({
      creds: FAKE_CREDS,
      collections: [conversationsCol()],
    });
    const local = await adapter.listLocal("/repo");

    expect(local).toHaveLength(2);
    const manifestKeys = new Set(local.map((l) => l.manifestKey));
    expect(manifestKeys).toEqual(
      new Set([
        "openit-conversations/T1/msg-X",
        "openit-conversations/T2/msg-X",
      ]),
    );
  });
});
