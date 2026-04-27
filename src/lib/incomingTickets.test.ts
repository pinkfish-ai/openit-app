// Tests for the incoming-ticket scanner. The scanner walks every
// `databases/openit-tickets-*/` dir under the repo, reads each row
// JSON, and returns the rows with `status === "incoming"`. It backs
// the IncomingTicketBanner — wrong filtering means the banner spams
// or silently misses tickets.

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

function dir(name: string, path: string): FileNode {
  return { name, path, is_dir: true };
}

describe("scanIncomingTickets", () => {
  it("returns the rows whose status is incoming", async () => {
    const repo = "/r";
    mockedFsList
      .mockResolvedValueOnce([
        dir("openit-tickets-local", "/r/databases/openit-tickets-local"),
      ])
      .mockResolvedValueOnce([
        file("a.json", "/r/databases/openit-tickets-local/a.json"),
        file("b.json", "/r/databases/openit-tickets-local/b.json"),
      ]);
    mockedFsRead
      .mockResolvedValueOnce(
        JSON.stringify({ status: "incoming", subject: "VPN", asker: "alice" }),
      )
      .mockResolvedValueOnce(JSON.stringify({ status: "open", subject: "other" }));

    const result = await scanIncomingTickets(repo);
    expect(result).toEqual([
      {
        path: "/r/databases/openit-tickets-local/a.json",
        relPath: "databases/openit-tickets-local/a.json",
        subject: "VPN",
        asker: "alice",
      },
    ]);
  });

  it("skips _schema.json and conflict-shadow files", async () => {
    const repo = "/r";
    mockedFsList
      .mockResolvedValueOnce([
        dir("openit-tickets-local", "/r/databases/openit-tickets-local"),
      ])
      .mockResolvedValueOnce([
        file("_schema.json", "/r/databases/openit-tickets-local/_schema.json"),
        file("a.server.json", "/r/databases/openit-tickets-local/a.server.json"),
        file("a.json", "/r/databases/openit-tickets-local/a.json"),
      ]);
    mockedFsRead.mockResolvedValueOnce(
      JSON.stringify({ status: "incoming", subject: "ok" }),
    );

    const result = await scanIncomingTickets(repo);
    expect(result).toHaveLength(1);
    // fsRead must only have been called for a.json — not for the schema or shadow.
    expect(mockedFsRead).toHaveBeenCalledTimes(1);
    expect(mockedFsRead).toHaveBeenCalledWith("/r/databases/openit-tickets-local/a.json");
  });

  it("ignores non-ticket sibling collections", async () => {
    const repo = "/r";
    mockedFsList
      .mockResolvedValueOnce([
        dir("openit-people-local", "/r/databases/openit-people-local"),
        dir("openit-tickets-local", "/r/databases/openit-tickets-local"),
      ])
      .mockResolvedValueOnce([file("a.json", "/r/databases/openit-tickets-local/a.json")]);
    mockedFsRead.mockResolvedValueOnce(
      JSON.stringify({ status: "incoming", subject: "ok" }),
    );

    const result = await scanIncomingTickets(repo);
    expect(result).toHaveLength(1);
    // fsList should have been called for the repo's databases/ and once for the
    // tickets dir — NOT for openit-people-local.
    expect(mockedFsList).toHaveBeenCalledTimes(2);
    expect(mockedFsList).toHaveBeenNthCalledWith(2, "/r/databases/openit-tickets-local");
  });

  it("scans multiple ticket collections", async () => {
    const repo = "/r";
    mockedFsList
      .mockResolvedValueOnce([
        dir("openit-tickets-local", "/r/databases/openit-tickets-local"),
        dir("openit-tickets-other", "/r/databases/openit-tickets-other"),
      ])
      .mockResolvedValueOnce([file("a.json", "/r/databases/openit-tickets-local/a.json")])
      .mockResolvedValueOnce([file("b.json", "/r/databases/openit-tickets-other/b.json")]);
    mockedFsRead
      .mockResolvedValueOnce(JSON.stringify({ status: "incoming", subject: "A" }))
      .mockResolvedValueOnce(JSON.stringify({ status: "incoming", subject: "B" }));

    const result = await scanIncomingTickets(repo);
    expect(result.map((t) => t.subject)).toEqual(["A", "B"]);
  });

  it("returns empty when databases/ does not exist", async () => {
    mockedFsList.mockRejectedValueOnce(new Error("ENOENT"));
    const result = await scanIncomingTickets("/r");
    expect(result).toEqual([]);
  });

  it("tolerates a malformed row JSON without aborting the scan", async () => {
    const repo = "/r";
    mockedFsList
      .mockResolvedValueOnce([
        dir("openit-tickets-local", "/r/databases/openit-tickets-local"),
      ])
      .mockResolvedValueOnce([
        file("bad.json", "/r/databases/openit-tickets-local/bad.json"),
        file("ok.json", "/r/databases/openit-tickets-local/ok.json"),
      ]);
    mockedFsRead
      .mockResolvedValueOnce("{not valid json")
      .mockResolvedValueOnce(JSON.stringify({ status: "incoming", subject: "ok" }));

    const result = await scanIncomingTickets(repo);
    expect(result.map((t) => t.subject)).toEqual(["ok"]);
  });

  it("treats missing subject/asker as empty strings", async () => {
    const repo = "/r";
    mockedFsList
      .mockResolvedValueOnce([
        dir("openit-tickets-local", "/r/databases/openit-tickets-local"),
      ])
      .mockResolvedValueOnce([file("a.json", "/r/databases/openit-tickets-local/a.json")]);
    mockedFsRead.mockResolvedValueOnce(JSON.stringify({ status: "incoming" }));

    const result = await scanIncomingTickets(repo);
    expect(result[0]).toMatchObject({ subject: "", asker: "" });
  });

  it("returns rows sorted by path so banner ordering is stable", async () => {
    const repo = "/r";
    mockedFsList
      .mockResolvedValueOnce([
        dir("openit-tickets-local", "/r/databases/openit-tickets-local"),
      ])
      .mockResolvedValueOnce([
        file("z.json", "/r/databases/openit-tickets-local/z.json"),
        file("a.json", "/r/databases/openit-tickets-local/a.json"),
      ]);
    mockedFsRead
      .mockResolvedValueOnce(JSON.stringify({ status: "incoming", subject: "Z" }))
      .mockResolvedValueOnce(JSON.stringify({ status: "incoming", subject: "A" }));

    const result = await scanIncomingTickets(repo);
    expect(result.map((t) => t.subject)).toEqual(["A", "Z"]);
  });
});
