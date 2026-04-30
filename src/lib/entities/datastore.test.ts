/**
 * datastoreAdapter — Phase 3 of V2 sync (PIN-5793).
 *
 * Focused on the only datastore-side wrinkle introduced by Phase 3:
 *   1. local-folder-name routing strips the `openit-` prefix
 *      (`openit-tickets` → `databases/tickets/`).
 *   2. `openit-conversations` writes to a nested per-ticket layout
 *      (`databases/conversations/<ticketId>/<msgId>.json`) using the
 *      `content.ticketId` field as the folder anchor.
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

function row(key: string, content: unknown, updatedAt = "2026-04-30T00:00:00Z"): MemoryItem {
  return { id: `id-${key}`, key, content, updatedAt } as MemoryItem;
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
    const result = await adapter.listRemote("/repo");

    expect(result.items).toHaveLength(1);
    expect(result.items[0].workingTreePath).toBe("databases/tickets/CS-1.json");
    expect(result.items[0].manifestKey).toBe("openit-tickets/CS-1");
  });
});

describe("datastoreAdapter — openit-conversations nested layout", () => {
  it("routes a row by content.ticketId into databases/conversations/<ticketId>/", async () => {
    mockFetchItems.mockResolvedValueOnce({
      items: [
        row("msg-aa01", { ticketId: "T1", body: "hello" }),
        row("msg-bb01", { ticketId: "T2", body: "world" }),
      ],
      pagination: { hasNextPage: false },
    } as any);

    const adapter = datastoreAdapter({
      creds: FAKE_CREDS,
      collections: [conversationsCol()],
    });
    const result = await adapter.listRemote("/repo");

    expect(result.items.map((r) => r.workingTreePath)).toEqual([
      "databases/conversations/T1/msg-aa01.json",
      "databases/conversations/T2/msg-bb01.json",
    ]);
    // Manifest key stays globally unique on `<col>/<msgId>` — no ticket
    // folder in the key, since msgIds are globally unique.
    expect(result.items.map((r) => r.manifestKey)).toEqual([
      "openit-conversations/msg-aa01",
      "openit-conversations/msg-bb01",
    ]);
  });

  it("drops a conversation row that has no ticketId in content", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetchItems.mockResolvedValueOnce({
      items: [
        row("msg-aa01", { ticketId: "T1", body: "ok" }),
        row("msg-bad", { body: "missing ticketId" }),
      ],
      pagination: { hasNextPage: false },
    } as any);

    const adapter = datastoreAdapter({
      creds: FAKE_CREDS,
      collections: [conversationsCol()],
    });
    const result = await adapter.listRemote("/repo");

    // Only the well-formed row survives; the malformed one was warn-and-skipped.
    expect(result.items).toHaveLength(1);
    expect(result.items[0].manifestKey).toBe("openit-conversations/msg-aa01");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
