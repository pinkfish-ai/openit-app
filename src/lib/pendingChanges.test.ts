// Unit tests for the local-only "is anything pending push?" helpers.
// Mocks the api module so we can assert the helpers' decision logic
// without spinning up Tauri commands.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api", () => ({
  kbStateLoad: vi.fn(),
  kbListLocal: vi.fn(),
  fsStoreStateLoad: vi.fn(),
  fsStoreListLocal: vi.fn(),
  datastoreStateLoad: vi.fn(),
  datastoreListLocal: vi.fn(),
}));

import {
  datastoreListLocal,
  datastoreStateLoad,
  fsStoreListLocal,
  fsStoreStateLoad,
  kbListLocal,
  kbStateLoad,
} from "./api";
import {
  datastoreHasPendingChanges,
  filestoreHasPendingChanges,
  kbHasPendingChanges,
} from "./pendingChanges";

beforeEach(() => {
  vi.mocked(kbStateLoad).mockReset();
  vi.mocked(kbListLocal).mockReset();
  vi.mocked(fsStoreStateLoad).mockReset();
  vi.mocked(fsStoreListLocal).mockReset();
  vi.mocked(datastoreStateLoad).mockReset();
  vi.mocked(datastoreListLocal).mockReset();
});

// ---------------------------------------------------------------------------
// kbHasPendingChanges + filestoreHasPendingChanges share the same
// "flat-entity" logic. We exhaustively test KB; the filestore tests
// just confirm the same decisions surface from the filestore wiring.
// ---------------------------------------------------------------------------

describe("kbHasPendingChanges", () => {
  it("returns false when manifest matches disk (steady state)", async () => {
    vi.mocked(kbStateLoad).mockResolvedValue({
      collection_id: null,
      collection_name: null,
      files: {
        "intro.md": { remote_version: "v1", pulled_at_mtime_ms: 1000 },
      },
    });
    vi.mocked(kbListLocal).mockResolvedValue([
      { filename: "intro.md", mtime_ms: 1000, size: 10 },
    ]);
    expect(await kbHasPendingChanges("/repo")).toBe(false);
  });

  it("returns true when a tracked file's mtime advanced past pulled_at", async () => {
    vi.mocked(kbStateLoad).mockResolvedValue({
      collection_id: null,
      collection_name: null,
      files: {
        "intro.md": { remote_version: "v1", pulled_at_mtime_ms: 1000 },
      },
    });
    vi.mocked(kbListLocal).mockResolvedValue([
      { filename: "intro.md", mtime_ms: 2000, size: 10 },
    ]);
    expect(await kbHasPendingChanges("/repo")).toBe(true);
  });

  it("returns true when a local file has no manifest entry (user-created)", async () => {
    vi.mocked(kbStateLoad).mockResolvedValue({
      collection_id: null,
      collection_name: null,
      files: {},
    });
    vi.mocked(kbListLocal).mockResolvedValue([
      { filename: "new-doc.md", mtime_ms: 1000, size: 10 },
    ]);
    expect(await kbHasPendingChanges("/repo")).toBe(true);
  });

  it("returns true when a tracked entry has conflict_remote_version (active conflict)", async () => {
    vi.mocked(kbStateLoad).mockResolvedValue({
      collection_id: null,
      collection_name: null,
      files: {
        "intro.md": {
          remote_version: "v1",
          pulled_at_mtime_ms: 1000,
          conflict_remote_version: "v2",
        },
      },
    });
    // Even with no mtime divergence on disk, the conflict marker counts.
    vi.mocked(kbListLocal).mockResolvedValue([
      { filename: "intro.md", mtime_ms: 1000, size: 10 },
    ]);
    expect(await kbHasPendingChanges("/repo")).toBe(true);
  });

  it("ignores .server. shadow files when classifying pending changes", async () => {
    vi.mocked(kbStateLoad).mockResolvedValue({
      collection_id: null,
      collection_name: null,
      files: {
        "intro.md": { remote_version: "v1", pulled_at_mtime_ms: 1000 },
      },
    });
    // Shadow has no manifest entry, but it's a sibling of intro.md
    // → classifyAsShadow filters it out. Without this guard, every
    //   active conflict would falsely report pending via the new-file
    //   path AND the conflict_remote_version path simultaneously.
    vi.mocked(kbListLocal).mockResolvedValue([
      { filename: "intro.md", mtime_ms: 1000, size: 10 },
      { filename: "intro.server.md", mtime_ms: 1500, size: 10 },
    ]);
    expect(await kbHasPendingChanges("/repo")).toBe(false);
  });

  it("does NOT count manifest-only entries (deletions) as pending — push doesn't reconcile them", async () => {
    vi.mocked(kbStateLoad).mockResolvedValue({
      collection_id: null,
      collection_name: null,
      files: {
        "deleted.md": { remote_version: "v1", pulled_at_mtime_ms: 1000 },
      },
    });
    vi.mocked(kbListLocal).mockResolvedValue([]);
    expect(await kbHasPendingChanges("/repo")).toBe(false);
  });

  it("returns false on an empty repo", async () => {
    vi.mocked(kbStateLoad).mockResolvedValue({
      collection_id: null,
      collection_name: null,
      files: {},
    });
    vi.mocked(kbListLocal).mockResolvedValue([]);
    expect(await kbHasPendingChanges("/repo")).toBe(false);
  });
});

describe("filestoreHasPendingChanges", () => {
  it("uses the same 'flat-entity' logic as kbHasPendingChanges", async () => {
    vi.mocked(fsStoreStateLoad).mockResolvedValue({
      collection_id: null,
      collection_name: null,
      files: {
        "doc.pdf": { remote_version: "v1", pulled_at_mtime_ms: 1000 },
      },
    });
    vi.mocked(fsStoreListLocal).mockResolvedValue([
      { filename: "doc.pdf", mtime_ms: 2000, size: 100 },
    ]);
    expect(await filestoreHasPendingChanges("/repo")).toBe(true);
  });

  it("returns false when nothing has changed", async () => {
    vi.mocked(fsStoreStateLoad).mockResolvedValue({
      collection_id: null,
      collection_name: null,
      files: {
        "doc.pdf": { remote_version: "v1", pulled_at_mtime_ms: 1000 },
      },
    });
    vi.mocked(fsStoreListLocal).mockResolvedValue([
      { filename: "doc.pdf", mtime_ms: 1000, size: 100 },
    ]);
    expect(await filestoreHasPendingChanges("/repo")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// datastoreHasPendingChanges — per-collection variant. Manifest keys
// are namespaced as `<colName>/<key>` and local files live at
// `databases/<colName>/<key>.json`. The helper iterates collection
// names from the manifest, then `datastoreListLocal` per collection.
// ---------------------------------------------------------------------------

describe("datastoreHasPendingChanges", () => {
  it("returns false when no row in any collection has diverged", async () => {
    vi.mocked(datastoreStateLoad).mockResolvedValue({
      collection_id: null,
      collection_name: null,
      files: {
        "openit-people/row-A": { remote_version: "v1", pulled_at_mtime_ms: 1000 },
        "openit-tickets/row-B": { remote_version: "v1", pulled_at_mtime_ms: 2000 },
      },
    });
    vi.mocked(datastoreListLocal).mockImplementation(async (_repo, col) => {
      if (col === "openit-people") {
        return [{ filename: "row-A.json", mtime_ms: 1000, size: 50 }];
      }
      if (col === "openit-tickets") {
        return [{ filename: "row-B.json", mtime_ms: 2000, size: 50 }];
      }
      return [];
    });
    expect(await datastoreHasPendingChanges("/repo")).toBe(false);
  });

  it("returns true when an active conflict_remote_version exists anywhere in the manifest", async () => {
    vi.mocked(datastoreStateLoad).mockResolvedValue({
      collection_id: null,
      collection_name: null,
      files: {
        "openit-people/row-A": {
          remote_version: "v1",
          pulled_at_mtime_ms: 1000,
          conflict_remote_version: "v2",
        },
      },
    });
    // No collection iteration needed — the helper short-circuits.
    expect(await datastoreHasPendingChanges("/repo")).toBe(true);
    expect(datastoreListLocal).not.toHaveBeenCalled();
  });

  it("returns true when a row's mtime advanced in just one collection (others quiet)", async () => {
    vi.mocked(datastoreStateLoad).mockResolvedValue({
      collection_id: null,
      collection_name: null,
      files: {
        "openit-people/row-A": { remote_version: "v1", pulled_at_mtime_ms: 1000 },
        "openit-tickets/row-B": { remote_version: "v1", pulled_at_mtime_ms: 2000 },
      },
    });
    vi.mocked(datastoreListLocal).mockImplementation(async (_repo, col) => {
      if (col === "openit-people") {
        // This row was edited.
        return [{ filename: "row-A.json", mtime_ms: 9999, size: 50 }];
      }
      if (col === "openit-tickets") {
        return [{ filename: "row-B.json", mtime_ms: 2000, size: 50 }];
      }
      return [];
    });
    expect(await datastoreHasPendingChanges("/repo")).toBe(true);
  });

  it("returns true when a local row has no manifest entry (new row)", async () => {
    vi.mocked(datastoreStateLoad).mockResolvedValue({
      collection_id: null,
      collection_name: null,
      files: {
        // Existing row in openit-people; nothing for row-NEW.json yet.
        "openit-people/row-A": { remote_version: "v1", pulled_at_mtime_ms: 1000 },
      },
    });
    vi.mocked(datastoreListLocal).mockResolvedValue([
      { filename: "row-A.json", mtime_ms: 1000, size: 50 },
      { filename: "row-NEW.json", mtime_ms: 2000, size: 50 },
    ]);
    expect(await datastoreHasPendingChanges("/repo")).toBe(true);
  });

  it("returns false when manifest is empty", async () => {
    vi.mocked(datastoreStateLoad).mockResolvedValue({
      collection_id: null,
      collection_name: null,
      files: {},
    });
    expect(await datastoreHasPendingChanges("/repo")).toBe(false);
    // No collections → no per-collection list calls.
    expect(datastoreListLocal).not.toHaveBeenCalled();
  });
});
