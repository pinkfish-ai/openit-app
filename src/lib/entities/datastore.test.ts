/**
 * datastoreAdapter — Phase 3 of V2 sync (PIN-5793) + PIN-5861 contract
 * alignment.
 *
 * Focused on the datastore-side wrinkles:
 *   1. local-folder-name routing strips the `openit-` prefix
 *      (`openit-tickets` → `databases/tickets/`).
 *   2. `openit-conversations` writes to a nested per-ticket layout
 *      (`databases/conversations/<ticketId>/<msgBase>.json`).
 *      Cloud row identity is composite `(key=ticketId, sortField=msgBase)`,
 *      mirrored on disk so two threads sharing a msgBase are still
 *      distinct rows. ManifestKey for conversations is
 *      `<colName>/<ticketId>/<sortField>` — collision-free across threads.
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
import { datastoreAdapter } from "./datastore";
import type { DataCollection, MemoryItem } from "../skillsApi";

const mockFetchItems = vi.mocked(fetchDatastoreItems);
const FAKE_CREDS = { orgId: "org-1", tokenUrl: "https://app-api.example/oauth/token" } as any;

function ticketsCol(): DataCollection {
  return { id: "ds-tickets", name: "openit-tickets", type: "datastore", isStructured: true } as DataCollection;
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
  content: unknown,
  opts: { sortField?: string; updatedAt?: string } = {},
): MemoryItem {
  return {
    id: `id-${key}-${opts.sortField ?? ""}`,
    key,
    sortField: opts.sortField,
    content,
    updatedAt: opts.updatedAt ?? "2026-04-30T00:00:00Z",
  } as MemoryItem;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("datastoreAdapter — local routing strips openit- prefix", () => {
  it("openit-tickets row writes to databases/tickets/<key>.json", async () => {
    mockFetchItems.mockResolvedValueOnce({
      items: [row("CS-1", { subject: "Reset" })],
      pagination: { hasNextPage: false },
    } as any);

    const adapter = datastoreAdapter({ creds: FAKE_CREDS, collections: [ticketsCol()] });
    const result = await adapter.listRemote("/repo", { collection_id: null, collection_name: null, files: {} });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].workingTreePath).toBe("databases/tickets/CS-1.json");
    expect(result.items[0].manifestKey).toBe("openit-tickets/CS-1");
  });
});

describe("datastoreAdapter — openit-conversations nested layout", () => {
  it("routes a row by (key=ticketId, sortField=msgBase) into databases/conversations/<ticketId>/<msgBase>.json", async () => {
    mockFetchItems.mockResolvedValueOnce({
      items: [
        row("T1", { body: "hello" }, { sortField: "msg-aa01" }),
        row("T2", { body: "world" }, { sortField: "msg-bb01" }),
      ],
      pagination: { hasNextPage: false },
    } as any);

    const adapter = datastoreAdapter({
      creds: FAKE_CREDS,
      collections: [conversationsCol()],
    });
    const result = await adapter.listRemote("/repo", { collection_id: null, collection_name: null, files: {} });

    expect(result.items.map((r) => r.workingTreePath)).toEqual([
      "databases/conversations/T1/msg-aa01.json",
      "databases/conversations/T2/msg-bb01.json",
    ]);
    // Manifest key carries both halves of the composite — collision-free
    // even when two threads share a msgBase.
    expect(result.items.map((r) => r.manifestKey)).toEqual([
      "openit-conversations/T1/msg-aa01",
      "openit-conversations/T2/msg-bb01",
    ]);
  });

  it("two threads sharing a sortField produce distinct manifest keys", async () => {
    mockFetchItems.mockResolvedValueOnce({
      items: [
        row("T1", { body: "A" }, { sortField: "msg-shared" }),
        row("T2", { body: "B" }, { sortField: "msg-shared" }),
      ],
      pagination: { hasNextPage: false },
    } as any);

    const adapter = datastoreAdapter({
      creds: FAKE_CREDS,
      collections: [conversationsCol()],
    });
    const result = await adapter.listRemote("/repo", { collection_id: null, collection_name: null, files: {} });

    const mKeys = result.items.map((r) => r.manifestKey);
    expect(mKeys).toEqual([
      "openit-conversations/T1/msg-shared",
      "openit-conversations/T2/msg-shared",
    ]);
    expect(new Set(mKeys).size).toBe(2);
  });

  it("drops a conversation row that has no sortField (no per-turn anchor)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetchItems.mockResolvedValueOnce({
      items: [
        row("T1", { body: "ok" }, { sortField: "msg-aa01" }),
        row("T2", { body: "missing sortField" }),
      ],
      pagination: { hasNextPage: false },
    } as any);

    const adapter = datastoreAdapter({
      creds: FAKE_CREDS,
      collections: [conversationsCol()],
    });
    const result = await adapter.listRemote("/repo", { collection_id: null, collection_name: null, files: {} });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].manifestKey).toBe("openit-conversations/T1/msg-aa01");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
