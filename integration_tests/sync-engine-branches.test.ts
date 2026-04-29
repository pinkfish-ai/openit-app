/**
 * Sync engine branch coverage.
 *
 * The pull pipeline has four shape-cases per remote file:
 *
 *   1.  !tracked && !localFile   → brand new, fetch + record
 *   1b. tracked  && !localFile   → tracked but missing, RE-FETCH (the bug)
 *   2.  !tracked && localFile    → bootstrap-adopt
 *   3.  tracked  && localFile    → diff (remoteChanged / localChanged / both)
 *
 * Pre-fix, case 1b silently fell through and the engine did nothing. So
 * once the manifest had a stale entry (e.g. from a failed write where
 * the directory didn't exist), the file would never re-download. This
 * suite locks the new branch in place + exercises every other case so a
 * future refactor can't regress to the same shape.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  pullEntity,
  type EntityAdapter,
  type RemoteItem,
  type LocalItem,
  type Manifest,
} from "../src/lib/syncEngine";

vi.mock("../src/lib/api", () => ({
  fsRead: vi.fn(),
  gitCommitPaths: vi.fn().mockResolvedValue(undefined),
}));

interface AdapterHarness {
  adapter: EntityAdapter;
  manifest: Manifest;
  fetchCalls: string[];
  shadowCalls: string[];
}

function makeHarness(args: {
  manifest?: Manifest;
  remote?: RemoteItem[];
  local?: LocalItem[];
}): AdapterHarness {
  const manifest: Manifest = args.manifest ?? {
    collection_id: "test",
    collection_name: "test",
    files: {},
  };
  const fetchCalls: string[] = [];
  const shadowCalls: string[] = [];

  const adapter: EntityAdapter = {
    prefix: "test/prefix",
    loadManifest: async () => manifest,
    saveManifest: async (_repo, m) => {
      // mutate the captured manifest so the test can inspect it
      manifest.files = { ...m.files };
    },
    listRemote: async () => ({
      items: (args.remote ?? []).map((r) => ({
        ...r,
        fetchAndWrite: async (repo: string) => {
          fetchCalls.push(`${repo}:${r.manifestKey}`);
          return r.fetchAndWrite ? r.fetchAndWrite(repo) : undefined;
        },
        writeShadow: async (repo: string) => {
          shadowCalls.push(`${repo}:${r.manifestKey}`);
          return r.writeShadow ? r.writeShadow(repo) : undefined;
        },
      })),
      paginationFailed: false,
    }),
    listLocal: async () => args.local ?? [],
  };

  return { adapter, manifest, fetchCalls, shadowCalls };
}

function remote(
  manifestKey: string,
  updatedAt = "2026-04-29T00:00:00Z",
): RemoteItem {
  return {
    manifestKey,
    workingTreePath: `test/prefix/${manifestKey}`,
    updatedAt,
    fetchAndWrite: vi.fn().mockResolvedValue(undefined),
    writeShadow: vi.fn().mockResolvedValue(undefined),
  };
}

function local(manifestKey: string, mtime_ms = 1000): LocalItem {
  return {
    manifestKey,
    workingTreePath: `test/prefix/${manifestKey}`,
    mtime_ms,
    isShadow: false,
  };
}

describe("syncEngine — pull branch coverage", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("case 1: !tracked && !localFile (brand new)", () => {
    it("fetches and records when the file is brand new", async () => {
      const h = makeHarness({
        manifest: { collection_id: "x", collection_name: "x", files: {} },
        remote: [remote("new.txt")],
        local: [],
      });
      const result = await pullEntity(h.adapter, "/repo");
      expect(result.pulled).toBe(1);
      expect(h.fetchCalls).toContain("/repo:new.txt");
      expect(h.manifest.files["new.txt"]).toBeDefined();
    });
  });

  describe("case 1b: tracked && !localFile (THE BUG FIX)", () => {
    it("re-fetches a tracked file that's missing from disk", async () => {
      const h = makeHarness({
        manifest: {
          collection_id: "x",
          collection_name: "x",
          files: {
            "ghost.txt": {
              remote_version: "2026-04-28T00:00:00Z",
              pulled_at_mtime_ms: 100,
            },
          },
        },
        remote: [remote("ghost.txt")],
        local: [], // file is GONE from disk
      });
      const result = await pullEntity(h.adapter, "/repo");

      // Pre-fix: pulled=0, fetchCalls=[], file stays gone forever.
      // Post-fix: re-fetched and re-recorded.
      expect(result.pulled).toBe(1);
      expect(h.fetchCalls).toEqual(["/repo:ghost.txt"]);
      expect(h.manifest.files["ghost.txt"]).toBeDefined();
    });

    it("re-fetches all missing tracked files in one pull", async () => {
      const h = makeHarness({
        manifest: {
          collection_id: "x",
          collection_name: "x",
          files: {
            "a.txt": { remote_version: "v1", pulled_at_mtime_ms: 100 },
            "b.txt": { remote_version: "v1", pulled_at_mtime_ms: 100 },
            "c.txt": { remote_version: "v1", pulled_at_mtime_ms: 100 },
          },
        },
        remote: [remote("a.txt"), remote("b.txt"), remote("c.txt")],
        local: [], // all gone
      });
      const result = await pullEntity(h.adapter, "/repo");
      expect(result.pulled).toBe(3);
      expect(h.fetchCalls.sort()).toEqual([
        "/repo:a.txt",
        "/repo:b.txt",
        "/repo:c.txt",
      ]);
    });

    it("doesn't increment pulled count if re-fetch throws", async () => {
      const failingRemote = remote("flaky.txt");
      failingRemote.fetchAndWrite = vi
        .fn()
        .mockRejectedValue(new Error("network down"));
      const h = makeHarness({
        manifest: {
          collection_id: "x",
          collection_name: "x",
          files: {
            "flaky.txt": { remote_version: "v1", pulled_at_mtime_ms: 100 },
          },
        },
        remote: [failingRemote],
        local: [],
      });
      const result = await pullEntity(h.adapter, "/repo");
      expect(result.pulled).toBe(0);
      // Manifest entry stays put — we'll retry next poll.
      expect(h.manifest.files["flaky.txt"]).toBeDefined();
    });
  });

  describe("case 2: !tracked && localFile (bootstrap-adopt)", () => {
    it("adopts on-disk file into manifest without re-fetching", async () => {
      const h = makeHarness({
        manifest: { collection_id: "x", collection_name: "x", files: {} },
        remote: [remote("existing.txt")],
        local: [local("existing.txt", 5000)],
      });
      const result = await pullEntity(h.adapter, "/repo");
      // No download — file is already on disk.
      expect(h.fetchCalls).toEqual([]);
      // But manifest gets seeded with the local mtime as baseline.
      expect(h.manifest.files["existing.txt"]).toBeDefined();
      expect(h.manifest.files["existing.txt"].pulled_at_mtime_ms).toBe(5000);
      // pulled count stays 0 — adoption isn't a pull.
      expect(result.pulled).toBe(0);
    });
  });

  describe("case 3: tracked && localFile (diff)", () => {
    it("does nothing when neither side changed", async () => {
      const h = makeHarness({
        manifest: {
          collection_id: "x",
          collection_name: "x",
          files: {
            "stable.txt": {
              remote_version: "v1",
              pulled_at_mtime_ms: 5000,
            },
          },
        },
        remote: [remote("stable.txt", "v1")], // same version
        local: [local("stable.txt", 5000)], // same mtime
      });
      const result = await pullEntity(h.adapter, "/repo");
      expect(result.pulled).toBe(0);
      expect(h.fetchCalls).toEqual([]);
      expect(h.shadowCalls).toEqual([]);
      expect(result.conflicts).toEqual([]);
    });

    it("re-fetches when only remote changed", async () => {
      const h = makeHarness({
        manifest: {
          collection_id: "x",
          collection_name: "x",
          files: {
            "remote-changed.txt": {
              remote_version: "v1",
              pulled_at_mtime_ms: 5000,
            },
          },
        },
        remote: [remote("remote-changed.txt", "v2")],
        local: [local("remote-changed.txt", 5000)],
      });
      const result = await pullEntity(h.adapter, "/repo");
      expect(result.pulled).toBe(1);
      expect(h.fetchCalls).toContain("/repo:remote-changed.txt");
    });

    it("writes shadow + records conflict when both sides changed", async () => {
      const h = makeHarness({
        manifest: {
          collection_id: "x",
          collection_name: "x",
          files: {
            "conflict.md": {
              remote_version: "v1",
              pulled_at_mtime_ms: 5000,
            },
          },
        },
        remote: [remote("conflict.md", "v2")],
        local: [local("conflict.md", 9000)], // mtime > pulled_at_mtime_ms
      });
      const result = await pullEntity(h.adapter, "/repo");
      expect(result.pulled).toBe(0);
      expect(h.shadowCalls).toContain("/repo:conflict.md");
      expect(result.conflicts.map((c) => c.manifestKey)).toContain(
        "conflict.md",
      );
    });
  });

  describe("multi-collection isolation", () => {
    it("two adapters with the same filename don't see each other's files", async () => {
      // Manifest A: tracks a file
      const harnessA = makeHarness({
        manifest: {
          collection_id: "A",
          collection_name: "A",
          files: {
            "shared.txt": { remote_version: "v1", pulled_at_mtime_ms: 5000 },
          },
        },
        remote: [remote("shared.txt", "v1")],
        local: [local("shared.txt", 5000)],
      });

      // Manifest B: same filename but DIFFERENT collection — must not
      // be confused with A's state. With shared manifest (pre-fix) both
      // adapters wrote to the same files map; one would clobber the
      // other's pulled_at_mtime_ms baseline.
      const harnessB = makeHarness({
        manifest: { collection_id: "B", collection_name: "B", files: {} },
        remote: [remote("shared.txt")],
        local: [], // brand new for B
      });

      await pullEntity(harnessA.adapter, "/repo");
      await pullEntity(harnessB.adapter, "/repo");

      expect(harnessA.fetchCalls).toEqual([]); // A had it already
      expect(harnessB.fetchCalls).toEqual(["/repo:shared.txt"]); // B fetched
      expect(harnessA.manifest.files["shared.txt"].pulled_at_mtime_ms).toBe(
        5000,
      );
      expect(harnessB.manifest.files["shared.txt"]).toBeDefined();
    });
  });
});
