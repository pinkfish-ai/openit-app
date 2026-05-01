// Orchestrator tests for pushAllEntities. The function delegates to
// per-entity push/pull helpers; this suite mocks each helper and asserts
// the orchestration shape — skip-clean preconditions, parallelism,
// per-task error isolation, and that no remote round-trips fire when a
// scope is fully synced. PIN-5865.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// All deep modules pushAll touches are stubbed out. Each test rewires
// the relevant mocks via vi.mocked(...).mockImplementation. We never
// hit a real Tauri command, network, or filesystem.
vi.mock("./kbSync", () => ({
  getSyncStatus: vi.fn(),
  kbHasServerShadowFiles: vi.fn(),
  pullAllKbNow: vi.fn(),
  pushAllToKb: vi.fn(),
  startKbSync: vi.fn(),
}));

vi.mock("./filestoreSync", () => ({
  pushAllToFilestore: vi.fn(),
  getFilestoreSyncStatus: vi.fn(),
  pullOnce: vi.fn(),
  startFilestoreSync: vi.fn(),
}));

vi.mock("./datastoreSync", () => ({
  pushAllToDatastores: vi.fn(),
  pullDatastoresOnce: vi.fn(),
}));

vi.mock("./pinkfishAuth", () => ({
  loadCreds: vi.fn(),
}));

vi.mock("./api", () => ({
  gitStatusShort: vi.fn(),
  datastoreStateLoad: vi.fn(),
}));

vi.mock("./syncEngine", () => ({
  hasConflictsForPrefix: vi.fn(),
}));

vi.mock("./nestedManifest", () => ({
  loadCollectionManifest: vi.fn(),
}));

vi.mock("./kb", () => ({
  displayKbName: (name: string) =>
    name.startsWith("openit-") ? name.slice("openit-".length) : name,
}));

import { pushAllEntities } from "./pushAll";
import {
  getSyncStatus,
  kbHasServerShadowFiles,
  pullAllKbNow,
  pushAllToKb,
  startKbSync,
} from "./kbSync";
import {
  pushAllToFilestore,
  getFilestoreSyncStatus,
  pullOnce as filestorePullOnce,
  startFilestoreSync,
} from "./filestoreSync";
import { pushAllToDatastores, pullDatastoresOnce } from "./datastoreSync";
import { loadCreds } from "./pinkfishAuth";
import { gitStatusShort, datastoreStateLoad } from "./api";
import { hasConflictsForPrefix } from "./syncEngine";
import { loadCollectionManifest } from "./nestedManifest";

// Default state every test inherits before customising. Steady-state
// fully-synced shape: creds present, no dirty paths, no conflicts,
// every manifest non-empty, every collection registered.
function setSteadyState() {
  vi.mocked(loadCreds).mockResolvedValue({
    tokenUrl: "https://stage.pinkfish.ai",
    orgId: "org-test",
  } as never);
  vi.mocked(gitStatusShort).mockResolvedValue([]);
  vi.mocked(hasConflictsForPrefix).mockReturnValue(false);

  vi.mocked(getSyncStatus).mockReturnValue({
    collections: [{ id: "kb-default", name: "default" }],
    conflicts: [],
  } as never);
  vi.mocked(kbHasServerShadowFiles).mockResolvedValue(false);
  vi.mocked(pullAllKbNow).mockResolvedValue(undefined as never);
  vi.mocked(pushAllToKb).mockResolvedValue({ pushed: 0, failed: 0 } as never);
  vi.mocked(startKbSync).mockResolvedValue(undefined as never);

  vi.mocked(getFilestoreSyncStatus).mockReturnValue({
    collections: [
      { id: "fs-scripts", name: "openit-scripts" },
      { id: "fs-skills", name: "openit-skills" },
    ],
    conflicts: [],
  } as never);
  vi.mocked(filestorePullOnce).mockResolvedValue({
    ok: true,
    downloaded: 0,
  } as never);
  vi.mocked(pushAllToFilestore).mockResolvedValue({
    pushed: 0,
    failed: 0,
  } as never);
  vi.mocked(startFilestoreSync).mockResolvedValue(undefined as never);

  vi.mocked(pullDatastoresOnce).mockResolvedValue({
    ok: true,
    pulled: 0,
    conflicts: [],
  } as never);
  vi.mocked(pushAllToDatastores).mockResolvedValue({
    pushed: 0,
    failed: 0,
  } as never);
  vi.mocked(datastoreStateLoad).mockResolvedValue({
    files: { "openit-people/personA": { remote_version: "v1" } },
  } as never);

  // Manifest non-empty for every collection (skip-clean precondition).
  vi.mocked(loadCollectionManifest).mockResolvedValue({
    collection_id: "any",
    collection_name: "any",
    files: { "seed.md": { remote_version: "v1", pulled_at_mtime_ms: 1 } },
  } as never);
}

beforeEach(() => {
  vi.resetAllMocks();
  setSteadyState();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("pushAllEntities — skip-clean (PIN-5865)", () => {
  it("no-op click against fully-synced state issues zero remote round-trips for clean scopes", async () => {
    const lines: string[] = [];
    await pushAllEntities("/repo", (l) => lines.push(l));

    // Critical: no list-remote / pre-push pull calls fired anywhere.
    expect(pullAllKbNow).not.toHaveBeenCalled();
    expect(filestorePullOnce).not.toHaveBeenCalled();
    expect(pullDatastoresOnce).not.toHaveBeenCalled();

    // No push calls either — there's nothing to push.
    expect(pushAllToKb).not.toHaveBeenCalled();
    expect(pushAllToFilestore).not.toHaveBeenCalled();
    expect(pushAllToDatastores).not.toHaveBeenCalled();

    // User sees a transparent "skipped" line per scope so the sync pane
    // doesn't go silent.
    expect(lines).toContain("▸ sync: kb skipped (clean)");
    expect(lines).toContain("▸ sync: filestore (openit-scripts) skipped (clean)");
    expect(lines).toContain("▸ sync: filestore (openit-skills) skipped (clean)");
    expect(lines).toContain("▸ sync: datastores skipped (clean)");
    expect(lines[lines.length - 1]).toBe("▸ sync: done");
  });

  it("kb skip is class-level: any single dirty kb collection unblocks the whole class pull", async () => {
    vi.mocked(getSyncStatus).mockReturnValue({
      collections: [
        { id: "kb-default", name: "default" },
        { id: "kb-extra", name: "extra" },
      ],
      conflicts: [],
    } as never);
    // Only `extra` has dirty files; `default` is clean. Skip-clean
    // requires ALL kb collections to be clean for the class to skip.
    vi.mocked(gitStatusShort).mockResolvedValue([
      { path: "knowledge-bases/extra/new.md", status: "??" },
    ] as never);

    const lines: string[] = [];
    await pushAllEntities("/repo", (l) => lines.push(l));

    expect(pullAllKbNow).toHaveBeenCalledTimes(1);
    expect(pushAllToKb).toHaveBeenCalledTimes(2); // both collections push (KB push loop is sequential per-collection)
    expect(lines).not.toContain("▸ sync: kb skipped (clean)");
  });

  it("filestore skip is per-collection: dirty A pulls+pushes while clean B skips", async () => {
    vi.mocked(gitStatusShort).mockResolvedValue([
      { path: "filestores/scripts/changed.sh", status: " M" },
    ] as never);

    const lines: string[] = [];
    await pushAllEntities("/repo", (l) => lines.push(l));

    expect(filestorePullOnce).toHaveBeenCalledTimes(1);
    expect(filestorePullOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: expect.objectContaining({ name: "openit-scripts" }),
      }),
    );
    expect(pushAllToFilestore).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: expect.objectContaining({ name: "openit-scripts" }),
      }),
    );
    expect(lines).toContain("▸ sync: filestore (openit-skills) skipped (clean)");
    expect(lines).not.toContain(
      "▸ sync: filestore (openit-scripts) skipped (clean)",
    );
  });

  it("freshly-resolved collection with empty manifest still pulls (bootstrap path)", async () => {
    // Working tree clean, no conflicts — but the manifest for the kb
    // collection is empty (never been pulled). Skip-clean must NOT
    // fire; we still need to pull at least once to populate disk.
    vi.mocked(loadCollectionManifest).mockResolvedValue({
      collection_id: "kb-default",
      collection_name: "default",
      files: {}, // empty
    } as never);

    await pushAllEntities("/repo", () => {});

    expect(pullAllKbNow).toHaveBeenCalledTimes(1);
  });

  it("conflict aggregate non-empty unblocks the pull even when working tree is clean", async () => {
    vi.mocked(hasConflictsForPrefix).mockImplementation(
      (prefix: string) => prefix === "kb",
    );

    await pushAllEntities("/repo", () => {});

    expect(pullAllKbNow).toHaveBeenCalledTimes(1);
  });

  it("dirty datastore unblocks datastore pre-push pull", async () => {
    vi.mocked(gitStatusShort).mockResolvedValue([
      { path: "databases/openit-people/personA.json", status: " M" },
    ] as never);

    await pushAllEntities("/repo", () => {});

    expect(pullDatastoresOnce).toHaveBeenCalledTimes(1);
    expect(pushAllToDatastores).toHaveBeenCalledTimes(1);
  });
});

describe("pushAllEntities — parallelism (PIN-5865)", () => {
  it("a slow class does not block siblings — filestore + datastore complete before kb", async () => {
    // All three classes have work; KB's pre-push pull is artificially
    // slow. Without parallelism, kb's 200ms latency would gate the
    // whole click. We assert filestore + datastore COMPLETE timestamps
    // come BEFORE kb's.
    vi.mocked(gitStatusShort).mockResolvedValue([
      { path: "knowledge-bases/default/dirty.md", status: " M" },
      { path: "filestores/scripts/dirty.sh", status: " M" },
      { path: "databases/openit-people/dirty.json", status: " M" },
    ] as never);

    let kbFinishedAt = 0;
    let fsFinishedAt = 0;
    let dsFinishedAt = 0;

    vi.mocked(pullAllKbNow).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 60));
      return undefined as never;
    });
    vi.mocked(pushAllToKb).mockImplementation(async () => {
      kbFinishedAt = Date.now();
      return { pushed: 0, failed: 0 } as never;
    });
    vi.mocked(filestorePullOnce).mockImplementation(async () => {
      return { ok: true, downloaded: 0 } as never;
    });
    vi.mocked(pushAllToFilestore).mockImplementation(async () => {
      fsFinishedAt = Date.now();
      return { pushed: 0, failed: 0 } as never;
    });
    vi.mocked(pullDatastoresOnce).mockImplementation(async () => {
      return { ok: true, pulled: 0, conflicts: [] } as never;
    });
    vi.mocked(pushAllToDatastores).mockImplementation(async () => {
      dsFinishedAt = Date.now();
      return { pushed: 0, failed: 0 } as never;
    });

    await pushAllEntities("/repo", () => {});

    expect(fsFinishedAt).toBeGreaterThan(0);
    expect(dsFinishedAt).toBeGreaterThan(0);
    expect(kbFinishedAt).toBeGreaterThan(fsFinishedAt);
    expect(kbFinishedAt).toBeGreaterThan(dsFinishedAt);
  });

  it("filestore collections run concurrently — slow A does not block B", async () => {
    vi.mocked(gitStatusShort).mockResolvedValue([
      { path: "filestores/scripts/dirty.sh", status: " M" },
      { path: "filestores/skills/dirty.sh", status: " M" },
    ] as never);

    let scriptsFinishedAt = 0;
    let skillsFinishedAt = 0;
    vi.mocked(filestorePullOnce).mockImplementation(async (args) => {
      if (args.collection.name === "openit-scripts") {
        await new Promise((r) => setTimeout(r, 60));
      }
      return { ok: true, downloaded: 0, total: 0 };
    });
    vi.mocked(pushAllToFilestore).mockImplementation(async (args) => {
      if (args.collection.name === "openit-scripts") scriptsFinishedAt = Date.now();
      if (args.collection.name === "openit-skills") skillsFinishedAt = Date.now();
      return { pushed: 0, failed: 0 };
    });

    await pushAllEntities("/repo", () => {});

    expect(skillsFinishedAt).toBeGreaterThan(0);
    expect(scriptsFinishedAt).toBeGreaterThan(skillsFinishedAt);
  });
});

describe("pushAllEntities — error isolation (PIN-5865)", () => {
  it("a thrown kb push surfaces via onLine but does NOT block filestore + datastore", async () => {
    vi.mocked(gitStatusShort).mockResolvedValue([
      { path: "knowledge-bases/default/dirty.md", status: " M" },
      { path: "filestores/scripts/dirty.sh", status: " M" },
      { path: "databases/openit-people/dirty.json", status: " M" },
    ] as never);
    vi.mocked(pushAllToKb).mockRejectedValue(new Error("kb upload exploded"));

    const lines: string[] = [];
    await pushAllEntities("/repo", (l) => lines.push(l));

    // Filestore + datastore both completed normally.
    expect(pushAllToFilestore).toHaveBeenCalled();
    expect(pushAllToDatastores).toHaveBeenCalled();

    // The kb error landed in the sync pane.
    expect(
      lines.some((l) => l.startsWith("✗ sync: kb push") && l.includes("kb upload exploded")),
    ).toBe(true);

    // The orchestrator still emitted the terminal "done" line.
    expect(lines[lines.length - 1]).toBe("▸ sync: done");
  });

  it("auth failure short-circuits without touching any per-class helper", async () => {
    vi.mocked(loadCreds).mockResolvedValue(null as never);

    const lines: string[] = [];
    await pushAllEntities("/repo", (l) => lines.push(l));

    expect(pullAllKbNow).not.toHaveBeenCalled();
    expect(filestorePullOnce).not.toHaveBeenCalled();
    expect(pullDatastoresOnce).not.toHaveBeenCalled();
    expect(lines).toEqual(["✗ sync: not authenticated"]);
  });
});
