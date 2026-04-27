// Tests for the incoming-ticket scanner. The scanner walks
// `databases/tickets/` under the repo, reads each row JSON, and
// returns the rows with `status === "incoming"`. It backs the
// IncomingTicketBanner — wrong filtering means the banner spams or
// silently misses tickets.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api", () => ({
  fsList: vi.fn(),
  fsRead: vi.fn(),
}));

import { fsList, fsRead, type FileNode } from "./api";
import { scanIncomingTickets } from "./incomingTickets";

const mockedFsList = vi.mocked(fsList);
const mockedFsRead = vi.mocked(fsRead);

beforeEach(() => {
  mockedFsList.mockReset();
  mockedFsRead.mockReset();
});

function file(name: string, path: string): FileNode {
  return { name, path, is_dir: false };
}

describe("scanIncomingTickets", () => {
  it("returns the rows whose status is incoming", async () => {
    const repo = "/r";
    mockedFsList.mockResolvedValueOnce([
      file("a.json", "/r/databases/tickets/a.json"),
      file("b.json", "/r/databases/tickets/b.json"),
    ]);
    mockedFsRead
      .mockResolvedValueOnce(
        JSON.stringify({ status: "incoming", subject: "VPN", asker: "alice" }),
      )
      .mockResolvedValueOnce(JSON.stringify({ status: "open", subject: "other" }));

    const result = await scanIncomingTickets(repo);
    expect(result).toEqual([
      {
        path: "/r/databases/tickets/a.json",
        relPath: "databases/tickets/a.json",
        subject: "VPN",
        asker: "alice",
      },
    ]);
  });

  it("skips _schema.json and conflict-shadow files", async () => {
    const repo = "/r";
    mockedFsList.mockResolvedValueOnce([
      file("_schema.json", "/r/databases/tickets/_schema.json"),
      file("a.server.json", "/r/databases/tickets/a.server.json"),
      file("a.json", "/r/databases/tickets/a.json"),
    ]);
    mockedFsRead.mockResolvedValueOnce(
      JSON.stringify({ status: "incoming", subject: "ok" }),
    );

    const result = await scanIncomingTickets(repo);
    expect(result).toHaveLength(1);
    // fsRead must only have been called for a.json — not the schema or shadow.
    expect(mockedFsRead).toHaveBeenCalledTimes(1);
    expect(mockedFsRead).toHaveBeenCalledWith("/r/databases/tickets/a.json");
  });

  it("returns empty when databases/tickets/ does not exist", async () => {
    mockedFsList.mockRejectedValueOnce(new Error("ENOENT"));
    const result = await scanIncomingTickets("/r");
    expect(result).toEqual([]);
  });

  it("tolerates a malformed row JSON without aborting the scan", async () => {
    const repo = "/r";
    mockedFsList.mockResolvedValueOnce([
      file("bad.json", "/r/databases/tickets/bad.json"),
      file("ok.json", "/r/databases/tickets/ok.json"),
    ]);
    mockedFsRead
      .mockResolvedValueOnce("{not valid json")
      .mockResolvedValueOnce(JSON.stringify({ status: "incoming", subject: "ok" }));

    const result = await scanIncomingTickets(repo);
    expect(result.map((t) => t.subject)).toEqual(["ok"]);
  });

  it("treats missing subject/asker as empty strings", async () => {
    const repo = "/r";
    mockedFsList.mockResolvedValueOnce([
      file("a.json", "/r/databases/tickets/a.json"),
    ]);
    mockedFsRead.mockResolvedValueOnce(JSON.stringify({ status: "incoming" }));

    const result = await scanIncomingTickets(repo);
    expect(result[0]).toMatchObject({ subject: "", asker: "" });
  });

  it("returns rows sorted by path so banner ordering is stable", async () => {
    const repo = "/r";
    mockedFsList.mockResolvedValueOnce([
      file("z.json", "/r/databases/tickets/z.json"),
      file("a.json", "/r/databases/tickets/a.json"),
    ]);
    mockedFsRead
      .mockResolvedValueOnce(JSON.stringify({ status: "incoming", subject: "Z" }))
      .mockResolvedValueOnce(JSON.stringify({ status: "incoming", subject: "A" }));

    const result = await scanIncomingTickets(repo);
    expect(result.map((t) => t.subject)).toEqual(["A", "Z"]);
  });
});
