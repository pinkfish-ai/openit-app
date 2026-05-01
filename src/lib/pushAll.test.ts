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
  entityListLocal: vi.fn(),
}));

vi.mock("./syncEngine", () => ({
  hasConflictsForPrefix: vi.fn(),
  getConflictsForPrefix: vi.fn(),
  // classifyAsShadow is a pure function in the real engine. Re-export
  // a faithful implementation here so manifestMatchesDisk's filtering
  // matches production behaviour without needing the full module.
  classifyAsShadow: (filename: string, siblings: Set<string>): boolean => {
    if (!filename.includes(".server.")) return false;
    const i = filename.indexOf(".server.");
    const canonical = `${filename.slice(0, i)}.${filename.slice(i + ".server.".length)}`;
    return siblings.has(canonical);
  },
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
import { gitStatusShort, datastoreStateLoad, entityListLocal } from "./api";
import { getConflictsForPrefix, hasConflictsForPrefix } from "./syncEngine";
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
  vi.mocked(getConflictsForPrefix).mockReturnValue([]);
  // Default disk listing matches the seed manifest below so
  // `manifestMatchesDisk` returns true → skip-clean fires unless an
  // individual test overrides this. Fields beyond `filename` aren't
  // read by the helper, so the cast is fine.
  vi.mocked(entityListLocal).mockResolvedValue([
    { filename: "seed.md", mtime_ms: 1, isShadow: false } as never,
  ]);

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
    last_pull_at_ms: 1000, // pulled at least once → skip-clean precondition met
  } as never);

  // Manifest established (`last_pull_at_ms` set) — skip-clean
  // precondition. Files non-empty too just so the steady-state covers
  // a typical "pulled and got items" shape; the load-bearing field
  // is the timestamp, not the file count.
  vi.mocked(loadCollectionManifest).mockResolvedValue({
    collection_id: "any",
    collection_name: "any",
    files: { "seed.md": { remote_version: "v1", pulled_at_mtime_ms: 1 } },
    last_pull_at_ms: 1000,
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

    // KB + filestore are clean; their pre-push pull short-circuits.
    // Datastore always pulls (no skip-clean for datastore — its
    // on-disk layout doesn't map cleanly to a single-call
    // manifest-vs-disk check, and the cost is one RTT).
    expect(pullAllKbNow).not.toHaveBeenCalled();
    expect(filestorePullOnce).not.toHaveBeenCalled();
    expect(pushAllToKb).not.toHaveBeenCalled();
    expect(pushAllToFilestore).not.toHaveBeenCalled();
    expect(pullDatastoresOnce).toHaveBeenCalledTimes(1);

    // User sees a transparent "skipped" line per scope so the sync pane
    // doesn't go silent.
    expect(lines).toContain("▸ sync: kb skipped (clean)");
    expect(lines).toContain("▸ sync: filestore (openit-scripts) skipped (clean)");
    expect(lines).toContain("▸ sync: filestore (openit-skills) skipped (clean)");
    expect(lines[lines.length - 1]).toBe("▸ sync: done");
  });

  it("REGRESSION: kb file committed-but-unsynced unblocks skip-clean (invoice.pdf scenario)", async () => {
    // The user-visible bug from PIN-5865: drop a file into
    // knowledge-bases/default, commit it, click Sync. `git status`
    // shows clean (committed), `last_pull_at_ms` is set (we've pulled
    // before), no conflicts → my earlier skip-clean fired and the
    // new file never reached the cloud. The fix: also check that
    // every on-disk file has a matching manifest entry.
    vi.mocked(entityListLocal).mockResolvedValue([
      { filename: "seed.md", mtime_ms: 1, isShadow: false } as never,
      // Brand-new file on disk — committed locally but never pushed.
      // Manifest doesn't know about it yet.
      { filename: "invoice.pdf", mtime_ms: 2, isShadow: false } as never,
    ]);
    // git status reports clean (file is committed).
    vi.mocked(gitStatusShort).mockResolvedValue([] as never);

    await pushAllEntities("/repo", () => {});

    // Skip-clean must NOT fire. Pull and push must run so the new
    // file actually reaches the cloud.
    expect(pullAllKbNow).toHaveBeenCalledTimes(1);
    expect(pushAllToKb).toHaveBeenCalled();
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

  it("freshly-resolved collection that has never pulled still pulls (bootstrap path)", async () => {
    // Working tree clean, no conflicts — but the manifest has no
    // `last_pull_at_ms`, meaning the engine hasn't completed a pull
    // for this collection yet. Skip-clean must NOT fire; we have to
    // talk to remote at least once before we can trust skip-clean.
    // Files emptiness is irrelevant on its own; the timestamp is the
    // bootstrap sentinel.
    vi.mocked(loadCollectionManifest).mockResolvedValue({
      collection_id: "kb-default",
      collection_name: "default",
      files: {},
      last_pull_at_ms: null, // never pulled
    } as never);

    await pushAllEntities("/repo", () => {});

    expect(pullAllKbNow).toHaveBeenCalledTimes(1);
  });

  it("empty-on-both-ends collection skips after a single empty pull (no perpetual re-pull)", async () => {
    // The openit-attachments-before-any-attachment case. Manifest has
    // `last_pull_at_ms` set (engine pulled, got 0 items, stamped the
    // timestamp anyway) and `files` is empty. Disk is also empty —
    // matching the manifest. Working tree clean. Skip-clean must
    // fire — pulling again would be pure RTT waste.
    vi.mocked(loadCollectionManifest).mockResolvedValue({
      collection_id: "kb-default",
      collection_name: "default",
      files: {},
      last_pull_at_ms: 1700_000_000_000,
    } as never);
    vi.mocked(entityListLocal).mockResolvedValue([]);

    await pushAllEntities("/repo", () => {});

    expect(pullAllKbNow).not.toHaveBeenCalled();
  });

  it("conflict aggregate non-empty unblocks the pull even when working tree is clean", async () => {
    // The kb adapter prefix IS the per-collection working-tree dir,
    // not the literal class name "kb". The default mock uses
    // collection.name = "default" → dir = "knowledge-bases/default".
    vi.mocked(hasConflictsForPrefix).mockImplementation(
      (prefix: string) => prefix === "knowledge-bases/default",
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

  it("BugBot fix: filestore collection B's conflicts do NOT block A's push (per-collection conflict isolation)", async () => {
    // Both collections have dirty paths so neither skips. After
    // pull, collection B has conflicts but A is clean. With the old
    // cross-collection conflicts union from `getFilestoreSyncStatus`,
    // A's safety check would see B's conflicts and falsely block.
    // The fix: A queries `getConflictsForPrefix("filestores/scripts")`
    // which only returns A's own slot.
    vi.mocked(gitStatusShort).mockResolvedValue([
      { path: "filestores/scripts/dirty.sh", status: " M" },
      { path: "filestores/skills/dirty.sh", status: " M" },
    ] as never);

    vi.mocked(getConflictsForPrefix).mockImplementation((prefix: string) => {
      if (prefix === "filestores/skills") {
        return [
          {
            prefix: "filestores/skills",
            manifestKey: "skills/conflicting.txt",
            workingTreePath: "filestores/skills/conflicting.txt",
            reason: "local-and-remote-changed" as const,
          },
        ];
      }
      return [];
    });

    await pushAllEntities("/repo", () => {});

    // A pushed (its own conflict slot is empty). B did NOT push (its
    // own conflict slot is non-empty).
    const aPushed = vi.mocked(pushAllToFilestore).mock.calls.some(
      (call) => call[0].collection.name === "openit-scripts",
    );
    const bPushed = vi.mocked(pushAllToFilestore).mock.calls.some(
      (call) => call[0].collection.name === "openit-skills",
    );
    expect(aPushed).toBe(true);
    expect(bPushed).toBe(false);
  });

  it("filestore collections run concurrently — slow A does not block B", async () => {
    // Both collections must be dirty so skip-clean doesn't fire for
    // either (otherwise they'd both short-circuit and never reach the
    // pull stage where the slow-A behavior is observable).
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
