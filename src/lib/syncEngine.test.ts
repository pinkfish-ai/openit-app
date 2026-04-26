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
  // Content-equality check in bootstrap-adoption reads the local file
  // via fsRead. Tests that exercise that branch override this mock per
  // case to return whatever local content they want.
  fsRead: vi.fn().mockRejectedValue(new Error("fsRead not stubbed")),
}));

import { gitCommitPaths, fsRead } from "./api";
import {
  classifyAsShadow,
  contentsEquivalent,
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
  /// Optional adapter-side inline content (e.g. datastore rows). When
  /// provided, the engine's bootstrap-adoption branch will read local
  /// content and compare against this — mismatch surfaces as a conflict.
  inlineContent?: string;
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
        ...(r.inlineContent !== undefined
          ? { inlineContent: async () => r.inlineContent! }
          : {}),
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
  vi.mocked(fsRead).mockReset();
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
    // Engine recorded the conflict-time remote version on the entry
    // so the resolve script can replay it back as the new
    // remote_version when the user picks LOCAL. Without this, the
    // push after resolve would re-detect divergence and refuse.
    expect(h.savedManifest?.files.personXYZ.conflict_remote_version).toBe(
      REMOTE_VERSION_AFTER_B_EDIT,
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

  it("bootstrap-adoption with inlineContent + matching local → adopts cleanly (no conflict, manifest seeded)", async () => {
    // When the adapter exposes inlineContent (datastore rows), the engine
    // compares local file bytes to remote bytes before adopting. Match →
    // safe to seed the manifest as the new baseline.
    const REMOTE_VERSION = "2026-04-26T10:00:00Z";
    const ON_DISK_MTIME = 5000;
    const SAME_CONTENT = '{"name":"alpha","email":"a@x.com"}';

    vi.mocked(fsRead).mockResolvedValueOnce(SAME_CONTENT);

    const h = buildHarness({
      prefix: "test-prefix",
      initialManifest: { collection_id: null, collection_name: null, files: {} },
      remote: [
        {
          manifestKey: "alpha",
          workingTreePath: "databases/openit-people/alpha.json",
          updatedAt: REMOTE_VERSION,
          inlineContent: SAME_CONTENT,
        },
      ],
      local: [
        {
          manifestKey: "alpha",
          workingTreePath: "databases/openit-people/alpha.json",
          mtime_ms: ON_DISK_MTIME,
          isShadow: false,
        },
      ],
    });

    const result = await pullEntity(h.adapter, "/repo");

    expect(result.conflicts).toHaveLength(0);
    expect(h.shadowedKeys).toEqual([]);
    expect(h.fetchedKeys).toEqual([]);
    expect(h.savedManifest?.files.alpha).toEqual({
      remote_version: REMOTE_VERSION,
      pulled_at_mtime_ms: ON_DISK_MTIME,
    });
    expect(fsRead).toHaveBeenCalledTimes(1);
  });

  it("bootstrap-adoption with inlineContent + diverging local → conflict, shadow written, manifest NOT seeded", async () => {
    // Regression test for the post-resolve drift scenario the user
    // explicitly called out: "if local doesn't match remote there should
    // be a conflict. period."
    //
    // Flow: a previous conflict was resolved by Claude (manifest entry
    // deleted), Claude wrote merged content to disk. On the next poll,
    // remote still has the pre-merge content. The bootstrap-adoption
    // branch fires (no manifest entry, file on disk). With the
    // content-equality check, mismatch → write shadow + record conflict
    // and leave manifest unseeded so the conflict persists until the
    // user pushes.
    const REMOTE_VERSION = "2026-04-26T10:00:00Z";
    const ON_DISK_MTIME = 5000;
    const REMOTE_CONTENT = '{"name":"alpha","email":"old@x.com"}';
    const LOCAL_CONTENT = '{"name":"alpha","email":"merged@x.com"}';

    vi.mocked(fsRead).mockResolvedValueOnce(LOCAL_CONTENT);

    const h = buildHarness({
      prefix: "test-prefix",
      initialManifest: { collection_id: null, collection_name: null, files: {} },
      remote: [
        {
          manifestKey: "alpha",
          workingTreePath: "databases/openit-people/alpha.json",
          updatedAt: REMOTE_VERSION,
          inlineContent: REMOTE_CONTENT,
        },
      ],
      local: [
        {
          manifestKey: "alpha",
          workingTreePath: "databases/openit-people/alpha.json",
          mtime_ms: ON_DISK_MTIME,
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

    // Mismatch surfaced as a conflict.
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].manifestKey).toBe("alpha");
    expect(result.conflicts[0].reason).toBe("local-and-remote-changed");

    // Shadow written, canonical untouched.
    expect(h.shadowedKeys).toEqual(["alpha"]);
    expect(h.fetchedKeys).toEqual([]);

    // Manifest entry created with conflict_remote_version recorded —
    // the resolve script reads this back to encode "I've reconciled
    // against this remote version, push my local content". Without
    // it, deleting the manifest on resolve would re-fire bootstrap-
    // adopt's content-equality check on the next poll and re-create
    // the conflict when the user picked LOCAL.
    expect(h.savedManifest?.files.alpha).toEqual({
      remote_version: "",
      pulled_at_mtime_ms: 0,
      conflict_remote_version: REMOTE_VERSION,
    });

    // Aggregate observed it.
    expect(aggregateSnapshot).toHaveLength(1);
    expect(aggregateSnapshot[0].workingTreePath).toBe(
      "databases/openit-people/alpha.json",
    );
  });

  it("bootstrap-adoption with inlineContent + pre-existing shadow → conflict recorded, shadow NOT re-written", async () => {
    // Idempotency for the bootstrap-adoption conflict path: if the
    // shadow is already on disk from a prior poll, the engine must
    // record the conflict but skip writeShadow to avoid mtime-thrashing.
    const REMOTE_VERSION = "2026-04-26T10:00:00Z";
    const REMOTE_CONTENT = '{"v":"remote"}';
    const LOCAL_CONTENT = '{"v":"local"}';

    vi.mocked(fsRead).mockResolvedValueOnce(LOCAL_CONTENT);

    const h = buildHarness({
      prefix: "test-prefix",
      initialManifest: { collection_id: null, collection_name: null, files: {} },
      remote: [
        {
          manifestKey: "alpha",
          workingTreePath: "databases/openit-people/alpha.json",
          updatedAt: REMOTE_VERSION,
          inlineContent: REMOTE_CONTENT,
        },
      ],
      local: [
        {
          manifestKey: "alpha",
          workingTreePath: "databases/openit-people/alpha.json",
          mtime_ms: 5000,
          isShadow: false,
        },
        {
          manifestKey: "alpha",
          workingTreePath: "databases/openit-people/alpha.server.json",
          mtime_ms: 4000,
          isShadow: true,
        },
      ],
    });

    const result = await pullEntity(h.adapter, "/repo");

    expect(result.conflicts).toHaveLength(1);
    // Shadow already exists → engine must NOT re-write it.
    expect(h.shadowedKeys).toEqual([]);
    // The conflict marker on the manifest entry is still written —
    // the resolve script needs `conflict_remote_version` regardless
    // of whether the shadow itself was already on disk.
    expect(h.savedManifest?.files.alpha).toEqual({
      remote_version: "",
      pulled_at_mtime_ms: 0,
      conflict_remote_version: REMOTE_VERSION,
    });
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

  it("conflict shadow re-written when remote advances during the conflict (stale-shadow protection)", async () => {
    // Regression test for the stale-shadow hole in the resolve flow:
    //   - T0: conflict detected, shadow written with V1, manifest gets
    //     conflict_remote_version=V1.
    //   - T1: user hasn't resolved yet. Remote advances to V2. Engine
    //     re-fires the both-changed branch.
    //   - Without this protection, idempotency skipped writeShadow
    //     because the file exists, but conflict_remote_version got
    //     bumped to V2. User then merged against V1 content, the
    //     resolve script encoded V2 as the new remote_version, push
    //     uploaded V1+local-merge — silently overwriting V2's changes.
    //   - With this protection: when the recorded
    //     conflict_remote_version differs from r.updatedAt, we re-write
    //     the shadow so it carries V2's content, matching what the
    //     resolve script will encode.
    const TRACKED_VERSION = "v0";
    const TRACKED_MTIME = 1000;
    const REMOTE_V2 = "v2";

    const h = buildHarness({
      prefix: "test-prefix",
      initialManifest: {
        collection_id: null,
        collection_name: null,
        files: {
          personXYZ: {
            remote_version: TRACKED_VERSION,
            pulled_at_mtime_ms: TRACKED_MTIME,
            // Engine wrote V1 to the shadow on the previous poll;
            // remote has since advanced to V2 (this poll).
            conflict_remote_version: "v1",
          },
        },
      },
      remote: [
        {
          manifestKey: "personXYZ",
          workingTreePath: "databases/openit-people/personXYZ.json",
          updatedAt: REMOTE_V2,
        },
      ],
      local: [
        {
          manifestKey: "personXYZ",
          workingTreePath: "databases/openit-people/personXYZ.json",
          mtime_ms: 2000,
          isShadow: false,
        },
        {
          // Stale shadow on disk from the V1 detection.
          manifestKey: "personXYZ",
          workingTreePath: "databases/openit-people/personXYZ.server.json",
          mtime_ms: 1500,
          isShadow: true,
        },
      ],
    });

    const result = await pullEntity(h.adapter, "/repo");

    expect(result.conflicts).toHaveLength(1);
    // Shadow re-written with V2 content (was V1). This is the fix.
    expect(h.shadowedKeys).toEqual(["personXYZ"]);
    // Manifest's conflict_remote_version now reflects V2 too.
    expect(h.savedManifest?.files.personXYZ.conflict_remote_version).toBe(REMOTE_V2);
    // remote_version / pulled_at_mtime_ms preserved at pre-conflict values.
    expect(h.savedManifest?.files.personXYZ.remote_version).toBe(TRACKED_VERSION);
    expect(h.savedManifest?.files.personXYZ.pulled_at_mtime_ms).toBe(TRACKED_MTIME);
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

// ---------------------------------------------------------------------------
// contentsEquivalent — what the bootstrap-adoption content check uses
// instead of `===`. Without these normalizations, harmless drift like a
// trailing newline or differing key order would manufacture false-positive
// conflicts that the user can't actually resolve. (BugBot iter on PR #17.)
// ---------------------------------------------------------------------------

describe("syncEngine.contentsEquivalent", () => {
  it("byte-identical content is equivalent", () => {
    expect(contentsEquivalent('{"a":1}', '{"a":1}')).toBe(true);
  });

  it("treats trailing-newline drift on JSON as equivalent", () => {
    expect(contentsEquivalent('{"a":1}\n', '{"a":1}')).toBe(true);
  });

  it("treats CRLF vs LF on JSON as equivalent", () => {
    const lf = '{\n  "a": 1\n}';
    const crlf = '{\r\n  "a": 1\r\n}';
    expect(contentsEquivalent(lf, crlf)).toBe(true);
  });

  it("treats different key ordering on JSON as equivalent", () => {
    expect(contentsEquivalent('{"a":1,"b":2}', '{"b":2,"a":1}')).toBe(true);
  });

  it("treats different whitespace formatting on JSON as equivalent", () => {
    const compact = '{"a":1,"nested":{"x":2}}';
    const pretty = '{\n  "a": 1,\n  "nested": {\n    "x": 2\n  }\n}';
    expect(contentsEquivalent(compact, pretty)).toBe(true);
  });

  it("falls back to trimmed compare for non-JSON content", () => {
    expect(contentsEquivalent("hello world\n", "hello world")).toBe(true);
    expect(contentsEquivalent("hello\r\nworld", "hello\nworld")).toBe(true);
  });

  it("genuinely-different JSON is not equivalent", () => {
    expect(contentsEquivalent('{"a":1}', '{"a":2}')).toBe(false);
  });

  it("genuinely-different non-JSON is not equivalent", () => {
    expect(contentsEquivalent("hello", "goodbye")).toBe(false);
  });
});

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
