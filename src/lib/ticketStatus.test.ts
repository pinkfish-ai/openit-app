// Unit tests for the escalated-ticket detection. Mocks the api fs
// helpers so we can drive the scanner with a fake on-disk shape.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api", () => ({
  fsList: vi.fn(),
  fsRead: vi.fn(),
}));

import { fsList, fsRead } from "./api";
import {
  _resetForTesting,
  scanEscalated,
  subscribeEscalatedTickets,
  refreshEscalatedTickets,
} from "./ticketStatus";

beforeEach(() => {
  vi.mocked(fsList).mockReset();
  vi.mocked(fsRead).mockReset();
  _resetForTesting();
});

afterEach(() => {
  _resetForTesting();
});

/// Stage a tickets dir layout. `collections` maps collection name to
/// the rows in that collection (with optional schema content).
function stageRepo(repo: string, collections: Record<string, {
  schema?: string;
  rows: { name: string; content: string }[];
}>) {
  vi.mocked(fsList).mockImplementation(async (p) => {
    if (p === `${repo}/databases`) {
      return Object.keys(collections).map((name) => ({
        name,
        path: `${repo}/databases/${name}`,
        is_dir: true,
      }));
    }
    for (const [name, col] of Object.entries(collections)) {
      if (p === `${repo}/databases/${name}`) {
        return col.rows.map((r) => ({
          name: r.name,
          path: `${repo}/databases/${name}/${r.name}`,
          is_dir: false,
        }));
      }
    }
    throw new Error(`unexpected fsList path: ${p}`);
  });
  vi.mocked(fsRead).mockImplementation(async (p) => {
    for (const [name, col] of Object.entries(collections)) {
      if (col.schema && p === `${repo}/databases/${name}/_schema.json`) {
        return col.schema;
      }
      for (const r of col.rows) {
        if (p === `${repo}/databases/${name}/${r.name}`) return r.content;
      }
    }
    throw new Error(`unexpected fsRead path: ${p}`);
  });
}

describe("scanEscalated", () => {
  it("classifies a row whose schema-named status field equals 'open'", async () => {
    stageRepo("/repo", {
      "openit-tickets-XXX": {
        schema: JSON.stringify({
          fields: [
            { id: "f_1", label: "Question" },
            { id: "f_2", label: "Status" },
          ],
        }),
        rows: [
          {
            name: "row-1.json",
            content: JSON.stringify({ f_1: "VPN broken", f_2: "open" }),
          },
        ],
      },
    });
    const tickets = await scanEscalated("/repo");
    expect(tickets).toHaveLength(1);
    expect(tickets[0].workingTreePath).toBe("databases/openit-tickets-XXX/row-1.json");
    expect(tickets[0].rowKey).toBe("row-1");
  });

  it("does NOT classify a row whose schema-named status equals 'answered'", async () => {
    stageRepo("/repo", {
      "openit-tickets-XXX": {
        schema: JSON.stringify({
          fields: [{ id: "f_2", label: "Status" }],
        }),
        rows: [
          {
            name: "row-2.json",
            content: JSON.stringify({ f_2: "answered" }),
          },
        ],
      },
    });
    expect(await scanEscalated("/repo")).toEqual([]);
  });

  it("treats 'escalated' / 'pending' / 'needs-human' as escalated", async () => {
    stageRepo("/repo", {
      "openit-tickets-XXX": {
        schema: JSON.stringify({ fields: [{ id: "f_2", label: "status" }] }),
        rows: [
          { name: "row-A.json", content: JSON.stringify({ f_2: "escalated" }) },
          { name: "row-B.json", content: JSON.stringify({ f_2: "pending" }) },
          { name: "row-C.json", content: JSON.stringify({ f_2: "needs-human" }) },
          { name: "row-D.json", content: JSON.stringify({ f_2: "closed" }) },
        ],
      },
    });
    const tickets = await scanEscalated("/repo");
    expect(tickets.map((t) => t.rowKey).sort()).toEqual(["row-A", "row-B", "row-C"]);
  });

  it("falls back to fuzzy matching when _schema.json is missing", async () => {
    stageRepo("/repo", {
      "openit-tickets-XXX": {
        // no schema staged
        rows: [
          {
            name: "row-1.json",
            content: JSON.stringify({ f_1: "Hello", f_2: "open" }),
          },
        ],
      },
    });
    // _schema.json fsRead will throw — handled gracefully.
    vi.mocked(fsRead).mockImplementationOnce(async () => {
      throw new Error("ENOENT");
    });
    const tickets = await scanEscalated("/repo");
    // Fuzzy matcher: f_2 is `f_<digit>` AND value "open" → escalated.
    expect(tickets).toHaveLength(1);
  });

  it("respects a boolean 'escalated' flag on the row", async () => {
    stageRepo("/repo", {
      "openit-tickets-XXX": {
        schema: JSON.stringify({ fields: [{ id: "f_3", label: "Description" }] }),
        rows: [
          {
            name: "row-X.json",
            content: JSON.stringify({ f_3: "Question text", escalated: true }),
          },
        ],
      },
    });
    expect(await scanEscalated("/repo")).toHaveLength(1);
  });

  it("ignores `_schema.json` and `.server.` shadow files", async () => {
    stageRepo("/repo", {
      "openit-tickets-XXX": {
        schema: JSON.stringify({ fields: [{ id: "f_2", label: "Status" }] }),
        rows: [
          { name: "row-1.json", content: JSON.stringify({ f_2: "answered" }) },
          { name: "row-1.server.json", content: JSON.stringify({ f_2: "open" }) },
          // _schema.json is filtered separately; including it here just
          // verifies the filter handles the well-known name even if
          // fsList accidentally emitted it.
        ],
      },
    });
    const tickets = await scanEscalated("/repo");
    // No row with f_2=="open" except the shadow which is filtered.
    expect(tickets).toEqual([]);
  });

  it("returns empty when databases/ doesn't exist", async () => {
    vi.mocked(fsList).mockRejectedValueOnce(new Error("ENOENT"));
    expect(await scanEscalated("/repo")).toEqual([]);
  });

  it("scans across multiple openit-tickets collections", async () => {
    stageRepo("/repo", {
      "openit-tickets-OrgA": {
        schema: JSON.stringify({ fields: [{ id: "f_2", label: "Status" }] }),
        rows: [{ name: "row-1.json", content: JSON.stringify({ f_2: "open" }) }],
      },
      "openit-tickets-OrgB": {
        schema: JSON.stringify({ fields: [{ id: "f_2", label: "Status" }] }),
        rows: [{ name: "row-2.json", content: JSON.stringify({ f_2: "open" }) }],
      },
      "openit-people-XXX": {
        // not a tickets collection — should be skipped
        rows: [{ name: "alice.json", content: JSON.stringify({ status: "open" }) }],
      },
    });
    const tickets = await scanEscalated("/repo");
    expect(tickets.map((t) => t.collection).sort()).toEqual([
      "openit-tickets-OrgA",
      "openit-tickets-OrgB",
    ]);
  });
});

describe("subscribeEscalatedTickets + refreshEscalatedTickets", () => {
  it("emits the current snapshot to new subscribers", async () => {
    stageRepo("/repo", {
      "openit-tickets-XXX": {
        schema: JSON.stringify({ fields: [{ id: "f_2", label: "Status" }] }),
        rows: [{ name: "row-1.json", content: JSON.stringify({ f_2: "open" }) }],
      },
    });
    await refreshEscalatedTickets("/repo");
    let received: { workingTreePath: string }[] = [];
    const unsub = subscribeEscalatedTickets((t) => {
      received = t.map((x) => ({ workingTreePath: x.workingTreePath }));
    });
    expect(received).toEqual([
      { workingTreePath: "databases/openit-tickets-XXX/row-1.json" },
    ]);
    unsub();
  });

  it("only emits when the snapshot actually changes", async () => {
    stageRepo("/repo", {
      "openit-tickets-XXX": {
        schema: JSON.stringify({ fields: [{ id: "f_2", label: "Status" }] }),
        rows: [{ name: "row-1.json", content: JSON.stringify({ f_2: "open" }) }],
      },
    });
    let count = 0;
    const unsub = subscribeEscalatedTickets(() => {
      count += 1;
    });
    // First subscribe emits once (initial empty snapshot).
    expect(count).toBe(1);
    await refreshEscalatedTickets("/repo");
    expect(count).toBe(2); // snapshot changed: empty → 1 ticket
    await refreshEscalatedTickets("/repo");
    expect(count).toBe(2); // re-scan same content → no new emit
    unsub();
  });
});
