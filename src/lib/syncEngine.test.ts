// Engine-level tests for the pull pipeline. These encode the canonical
// scenarios that BugBot caught manually during R1's iterations — locking
// them in so future refactors can't silently regress the invariants.
//
// Strategy: drive `pullEntity` with a fake EntityAdapter whose
// listRemote / listLocal / loadManifest return canned data. Assert on:
//   - what fetchAndWrite / writeShadow were called with
//   - the manifest the adapter saved
//   - the conflicts/pulled counts on the result
//   - whether `git_commit_paths` was invoked (and with which paths)
//
// Tauri commands aren't called by the engine itself (only by adapters),
// so the only mock the engine needs is `gitCommitPaths` from `./api`.

import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./api", () => ({
  gitCommitPaths: vi.fn().mockResolvedValue(true),
}));

import { gitCommitPaths } from "./api";
import {
  classifyAsShadow,
  pullEntity,
  subscribeConflicts,
  clearConflictsForPrefix,
  type AggregatedConflict,
  type EntityAdapter,
  type LocalItem,
  type Manifest,
  type RemoteItem,
} from "./syncEngine";

// ---------------------------------------------------------------------------
// Adapter test harness — small builder so each test can express its
// scenario in a couple of lines.
// ---------------------------------------------------------------------------

type FakeRow = {
  manifestKey: string;
  workingTreePath: string;
  updatedAt: string;
};

type Harness = {
  adapter: EntityAdapter;
  /// What the engine's `fetchAndWrite` calls hit. Inspect to verify the
  /// canonical was rewritten (or NOT rewritten when a conflict).
  fetchedKeys: string[];
  /// What `writeShadow` calls hit. Should be non-empty IFF a conflict fired.
  shadowedKeys: string[];
  /// Manifest the engine saved at the end of the pull.
  savedManifest: Manifest | null;
};

function buildHarness(args: {
  prefix: string;
  initialManifest: Manifest;
  remote: FakeRow[];
  local: LocalItem[];
  paginationFailed?: boolean;
}): Harness {
  const harness: Harness = {
    fetchedKeys: [],
    shadowedKeys: [],
    savedManifest: null,
    adapter: undefined as unknown as EntityAdapter,
  };
  // Mutable manifest the adapter loads / saves; engine modifies in place.
  let manifest: Manifest = JSON.parse(JSON.stringify(args.initialManifest));
  harness.adapter = {
    prefix: args.prefix,
    loadManifest: async () => manifest,
    saveManifest: async (_repo, m) => {
      manifest = m;
      harness.savedManifest = JSON.parse(JSON.stringify(m));
    },
    listRemote: async () => ({
      items: args.remote.map<RemoteItem>((r) => ({
        manifestKey: r.manifestKey,
        workingTreePath: r.workingTreePath,
        updatedAt: r.updatedAt,
        fetchAndWrite: async () => {
          harness.fetchedKeys.push(r.manifestKey);
        },
        writeShadow: async () => {
          harness.shadowedKeys.push(r.manifestKey);
        },
      })),
      paginationFailed: args.paginationFailed ?? false,
    }),
    listLocal: async () => args.local,
  };
  return harness;
}

// Each test gets a fresh conflict aggregate + mock state so module-level
// engine state can't leak between cases.
beforeEach(() => {
  vi.mocked(gitCommitPaths).mockClear();
  clearConflictsForPrefix("test-prefix");
});

// ---------------------------------------------------------------------------
// The canonical scenarios.
// ---------------------------------------------------------------------------

describe("syncEngine.pullEntity", () => {
  it("two-user conflict: both sides edited since last sync → shadow + conflict, manifest NOT advanced", async () => {
    // This is the regression test for the issue user A reported:
    //   - User A edits personXYZ locally (mtime bumps).
    //   - User B edits the same row on Pinkfish (remote.updatedAt advances).
    //   - User A pulls.
    // Expected: engine writes the .server. shadow with B's content,
    // records the conflict in the result + the aggregate, and DOES NOT
    // overwrite A's canonical or advance the manifest's remote_version.
    // The unchanged manifest is what makes the subsequent push detect the
    // conflict (push gate keys off conflicts.length > 0 from a pre-pull).
    const TRACKED_VERSION = "2026-04-26T10:00:00Z";
    const TRACKED_MTIME = 1000;
    const LOCAL_MTIME_AFTER_EDIT = 2000;
    const REMOTE_VERSION_AFTER_B_EDIT = "2026-04-26T11:00:00Z";

    const initialManifest: Manifest = {
      collection_id: "people-collection",
      collection_name: "openit-people",
      files: {
        personXYZ: {
          remote_version: TRACKED_VERSION,
          pulled_at_mtime_ms: TRACKED_MTIME,
        },
      },
    };

    const h = buildHarness({
      prefix: "test-prefix",
      initialManifest,
      remote: [
        {
          manifestKey: "personXYZ",
          workingTreePath: "databases/openit-people/personXYZ.json",
          updatedAt: REMOTE_VERSION_AFTER_B_EDIT,
        },
      ],
      local: [
        {
          manifestKey: "personXYZ",
          workingTreePath: "databases/openit-people/personXYZ.json",
          mtime_ms: LOCAL_MTIME_AFTER_EDIT,
          isShadow: false,
        },
      ],
    });

    let aggregateSnapshot: AggregatedConflict[] = [];
    const unsub = subscribeConflicts((c) => {
      aggregateSnapshot = c;
    });

    const result = await pullEntity(h.adapter, "/repo");
    unsub();

    // Engine recorded the conflict.
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].manifestKey).toBe("personXYZ");
    expect(result.conflicts[0].reason).toBe("local-and-remote-changed");

    // Shadow was written, canonical was NOT.
    expect(h.shadowedKeys).toEqual(["personXYZ"]);
    expect(h.fetchedKeys).toEqual([]);

    // Manifest's remote_version did NOT advance — this is what makes the
    // pre-push pull gate work. If we let this advance, the next push
    // would think it had already reconciled and silently overwrite B.
    expect(h.savedManifest?.files.personXYZ.remote_version).toBe(
      TRACKED_VERSION,
    );

    // Conflict aggregate observed the same conflict via subscribeConflicts.
    expect(aggregateSnapshot).toHaveLength(1);
    expect(aggregateSnapshot[0].prefix).toBe("test-prefix");
    expect(aggregateSnapshot[0].workingTreePath).toBe(
      "databases/openit-people/personXYZ.json",
    );

    // No auto-commit because nothing canonical was written. (The shadow
    // is gitignored; engine never adds it to the touched array.)
    expect(gitCommitPaths).not.toHaveBeenCalled();
  });

  it("remote-only change → fast-forward pull, canonical rewritten, manifest advances, auto-commit fires", async () => {
    const TRACKED_VERSION = "2026-04-26T10:00:00Z";
    const TRACKED_MTIME = 1000;
    const REMOTE_NEW_VERSION = "2026-04-26T11:00:00Z";

    const h = buildHarness({
      prefix: "test-prefix",
      initialManifest: {
        collection_id: null,
        collection_name: null,
        files: {
          intro: {
            remote_version: TRACKED_VERSION,
            pulled_at_mtime_ms: TRACKED_MTIME,
          },
        },
      },
      remote: [
        {
          manifestKey: "intro",
          workingTreePath: "knowledge-base/intro.md",
          updatedAt: REMOTE_NEW_VERSION,
        },
      ],
      local: [
        {
          manifestKey: "intro",
          workingTreePath: "knowledge-base/intro.md",
          // mtime hasn't moved past TRACKED_MTIME → user hasn't touched it.
          mtime_ms: TRACKED_MTIME,
          isShadow: false,
        },
      ],
    });

    const result = await pullEntity(h.adapter, "/repo");

    expect(result.conflicts).toHaveLength(0);
    expect(result.pulled).toBe(1);
    // Canonical rewritten with remote content.
    expect(h.fetchedKeys).toEqual(["intro"]);
    expect(h.shadowedKeys).toEqual([]);
    // Manifest advanced.
    expect(h.savedManifest?.files.intro.remote_version).toBe(REMOTE_NEW_VERSION);
    // Auto-commit fired with the canonical path (no shadows).
    expect(gitCommitPaths).toHaveBeenCalledTimes(1);
    const [, paths] = vi.mocked(gitCommitPaths).mock.calls[0];
    expect(paths).toEqual(["knowledge-base/intro.md"]);
  });

  it("bootstrap-adoption: file on disk, not in manifest → seed manifest, do NOT rewrite or commit", async () => {
    // This case fires after a connect-modal `*ToDisk` step seeds files
    // on disk before the engine has a manifest entry for them. Engine
    // must claim the existing on-disk content as the new baseline and
    // NOT re-download (would mtime-thrash and look like local edits).
    const REMOTE_VERSION = "2026-04-26T10:00:00Z";
    const ON_DISK_MTIME = 5000;

    const h = buildHarness({
      prefix: "test-prefix",
      initialManifest: { collection_id: null, collection_name: null, files: {} },
      remote: [
        {
          manifestKey: "alpha",
          workingTreePath: "agents/alpha.json",
          updatedAt: REMOTE_VERSION,
        },
      ],
      local: [
        {
          manifestKey: "alpha",
          workingTreePath: "agents/alpha.json",
          mtime_ms: ON_DISK_MTIME,
          isShadow: false,
        },
      ],
    });

    const result = await pullEntity(h.adapter, "/repo");

    expect(result.conflicts).toHaveLength(0);
    expect(result.pulled).toBe(0); // no fetch, just adoption
    expect(h.fetchedKeys).toEqual([]);
    expect(h.shadowedKeys).toEqual([]);
    // Manifest seeded with the existing file's mtime.
    expect(h.savedManifest?.files.alpha).toEqual({
      remote_version: REMOTE_VERSION,
      pulled_at_mtime_ms: ON_DISK_MTIME,
    });
    // No commit — nothing was written.
    expect(gitCommitPaths).not.toHaveBeenCalled();
  });

  it("server-delete: tracked but not in remote → drops manifest entry (default behavior, no adapter override)", async () => {
    const h = buildHarness({
      prefix: "test-prefix",
      initialManifest: {
        collection_id: null,
        collection_name: null,
        files: {
          ghost: {
            remote_version: "v1",
            pulled_at_mtime_ms: 1000,
          },
        },
      },
      remote: [], // ghost is gone from server
      local: [], // and not on disk locally either
    });

    const result = await pullEntity(h.adapter, "/repo");

    expect(result.conflicts).toHaveLength(0);
    expect(result.pulled).toBe(0);
    // Manifest no longer tracks the ghost.
    expect(h.savedManifest?.files.ghost).toBeUndefined();
  });

  it("conflict idempotency: existing shadow on disk → engine does NOT re-write it on next poll", async () => {
    // Without this guard, every 60s poll while a conflict is unresolved
    // would re-download + re-write the shadow file, mtime-thrashing the
    // working tree and burning bandwidth. Caught by BugBot iter 4 of
    // PR #9 ("Conflict shadow rewritten unconditionally every poll").
    const h = buildHarness({
      prefix: "test-prefix",
      initialManifest: {
        collection_id: null,
        collection_name: null,
        files: {
          personXYZ: {
            remote_version: "v-old",
            pulled_at_mtime_ms: 1000,
          },
        },
      },
      remote: [
        {
          manifestKey: "personXYZ",
          workingTreePath: "databases/people/personXYZ.json",
          updatedAt: "v-new", // remote moved
        },
      ],
      local: [
        {
          // Canonical with bumped mtime — local also moved.
          manifestKey: "personXYZ",
          workingTreePath: "databases/people/personXYZ.json",
          mtime_ms: 2000,
          isShadow: false,
        },
        {
          // Shadow already on disk from a prior pull — engine should
          // see it via the localShadowKeys set and skip writeShadow.
          manifestKey: "personXYZ",
          workingTreePath: "databases/people/personXYZ.server.json",
          mtime_ms: 1500,
          isShadow: true,
        },
      ],
    });

    const result = await pullEntity(h.adapter, "/repo");

    // Conflict is still recorded each poll (so the banner stays up).
    expect(result.conflicts).toHaveLength(1);
    // But the shadow was NOT re-written.
    expect(h.shadowedKeys).toEqual([]);
    expect(h.fetchedKeys).toEqual([]);
  });

  it("paginationFailed → server-delete pass skipped, manifest entries preserved", async () => {
    // If listRemote bails before consuming the full remote list (e.g.
    // a 100k safety cap, network failure mid-paginate), engine MUST
    // NOT delete tracked items it didn't see. Otherwise items past the
    // cutoff get wrongly classified as server-deleted. PR #9 iter 1.
    const h = buildHarness({
      prefix: "test-prefix",
      initialManifest: {
        collection_id: null,
        collection_name: null,
        files: {
          item_seen: { remote_version: "v1", pulled_at_mtime_ms: 1000 },
          item_past_cutoff: { remote_version: "v1", pulled_at_mtime_ms: 1000 },
        },
      },
      // Remote response is incomplete — only item_seen made it back.
      remote: [
        {
          manifestKey: "item_seen",
          workingTreePath: "files/item_seen.json",
          updatedAt: "v1",
        },
      ],
      local: [],
      paginationFailed: true,
    });

    const result = await pullEntity(h.adapter, "/repo");

    expect(result.paginationFailed).toBe(true);
    // Both manifest entries SURVIVE — the truncated remote can't be
    // trusted as authoritative for "what's been deleted server-side".
    expect(h.savedManifest?.files.item_seen).toBeDefined();
    expect(h.savedManifest?.files.item_past_cutoff).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Pure-function tests for the shadow classifier. Misclassification of
// legitimate filenames containing `.server.` (e.g. `nginx.server.conf`)
// caused real regressions in R1 iters 9 + 15. The fix was sibling-aware
// classification — locking it down here.
// ---------------------------------------------------------------------------

describe("syncEngine.classifyAsShadow", () => {
  it("classifies as shadow only when the canonical sibling exists in the set", () => {
    // Real shadow: runbook.md is on disk too → runbook.server.md is a shadow.
    const withSibling = new Set(["runbook.md", "runbook.server.md"]);
    expect(classifyAsShadow("runbook.server.md", withSibling)).toBe(true);

    // No sibling: nginx.server.conf is its own canonical file, not a shadow.
    const noSibling = new Set(["nginx.server.conf"]);
    expect(classifyAsShadow("nginx.server.conf", noSibling)).toBe(false);

    // Non-shadow filename always returns false.
    expect(classifyAsShadow("plain.md", new Set(["plain.md"]))).toBe(false);

    // Double-shadow case: both `a.server.conf` and `a.server.server.conf`
    // on disk → the latter's canonical (`a.server.conf`) is in the set,
    // so it's a shadow. R1 iter 15 fixed this.
    const doubleShadow = new Set(["a.server.conf", "a.server.server.conf"]);
    expect(classifyAsShadow("a.server.server.conf", doubleShadow)).toBe(true);
    expect(classifyAsShadow("a.server.conf", doubleShadow)).toBe(false); // canonical
  });
});
