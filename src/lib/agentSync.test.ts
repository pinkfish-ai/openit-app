// V1 push tests for the agent sync wrapper. Mocks every Tauri / fetch
// touchpoint and asserts the orchestration shape: skip-clean, shadow
// filtering, POST-vs-PATCH branching, post-write mtime baseline bump,
// the `openit-` prefix transform at the sync boundary, and the
// OutOfSync re-pull recovery path.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("./api", () => ({
  entityDeleteFile: vi.fn(),
  entityListLocal: vi.fn(),
  entityWriteFile: vi.fn(),
  fsRead: vi.fn(),
  gitStatusShort: vi.fn(),
}));

vi.mock("./entities/agent", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "./entities/agent",
  );
  return {
    ...actual,
    patchUserAgent: vi.fn(),
    postUserAgent: vi.fn(),
    listUserAgentsWithMeta: vi.fn(),
    agentAdapter: vi.fn(() => ({
      prefix: "agent",
      loadManifest: vi.fn(),
      saveManifest: vi.fn(),
      listRemote: vi.fn(),
      listLocal: vi.fn(),
    })),
  };
});

vi.mock("./syncEngine", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("./syncEngine");
  return {
    ...actual,
    pullEntity: vi.fn(),
    commitTouched: vi.fn(),
    // withRepoLock has to actually run the callback for the push to
    // execute. The real implementation queues; for tests, just await.
    withRepoLock: <T>(_repo: string, _prefix: string, fn: () => Promise<T>) =>
      fn(),
    startReadOnlyEntitySync: vi.fn(),
    clearConflictsForPrefix: vi.fn(),
  };
});

import { invoke } from "@tauri-apps/api/core";
import {
  entityDeleteFile,
  entityListLocal,
  entityWriteFile,
  fsRead,
  gitStatusShort,
} from "./api";
import {
  patchUserAgent,
  postUserAgent,
} from "./entities/agent";
import { migrateFlatTriage, pushAllToAgents } from "./agentSync";
import { OutOfSync, pullEntity } from "./syncEngine";

const creds = { tokenUrl: "https://x", orgId: "org" } as never;

beforeEach(() => {
  vi.resetAllMocks();
  // Default: empty manifest. Tests override.
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === "entity_state_load") return { files: {} } as never;
    if (cmd === "entity_state_save") return undefined as never;
    return undefined as never;
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("pushAllToAgents — dirty detection", () => {
  it("skips clean working tree (no agent files on disk, no manifest entries)", async () => {
    vi.mocked(entityListLocal).mockResolvedValue([]);
    vi.mocked(gitStatusShort).mockResolvedValue([]);
    const onLine = vi.fn();

    const out = await pushAllToAgents({ creds, repo: "/r", onLine });

    expect(out).toEqual({ pushed: 0, failed: 0 });
    expect(postUserAgent).not.toHaveBeenCalled();
    expect(patchUserAgent).not.toHaveBeenCalled();
  });

  it("skips shadow files (`.server.json`) even when present on disk", async () => {
    vi.mocked(entityListLocal).mockResolvedValue([
      { filename: "triage.server.json", mtime_ms: 1000, size: 50 } as never,
    ]);
    vi.mocked(gitStatusShort).mockResolvedValue([]);

    const out = await pushAllToAgents({ creds, repo: "/r", onLine: vi.fn() });

    expect(out).toEqual({ pushed: 0, failed: 0 });
    expect(postUserAgent).not.toHaveBeenCalled();
  });

  it("skips non-json files under agents/", async () => {
    vi.mocked(entityListLocal).mockResolvedValue([
      { filename: "README.md", mtime_ms: 1000, size: 50 } as never,
    ]);
    vi.mocked(gitStatusShort).mockResolvedValue([]);

    const out = await pushAllToAgents({ creds, repo: "/r", onLine: vi.fn() });

    expect(out).toEqual({ pushed: 0, failed: 0 });
  });

  it("detects committed-after-last-pull file as dirty (mtime > pulled_at_mtime_ms)", async () => {
    // Simulate: file is on disk with a recent mtime, manifest tracked
    // it earlier, git status reports nothing (file was committed after
    // the last sync). Without the mtime check, push would no-op.
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "entity_state_load") {
        return {
          files: {
            "triage.json": {
              remote_version: "2026-04-30T01:00:00Z",
              pulled_at_mtime_ms: 1000,
            },
          },
        } as never;
      }
      if (cmd === "entity_state_save") return undefined as never;
      return undefined as never;
    });
    vi.mocked(entityListLocal).mockResolvedValue([
      { filename: "triage.json", mtime_ms: 9000, size: 100 } as never,
    ]);
    vi.mocked(gitStatusShort).mockResolvedValue([]);
    vi.mocked(fsRead).mockResolvedValue(
      JSON.stringify({
        id: "ua_x",
        name: "triage",
        description: "",
        instructions: "edited",
      }),
    );
    vi.mocked(patchUserAgent).mockResolvedValue({
      id: "ua_x",
      name: "openit-triage",
      versionDate: "2026-04-30T02:00:00Z",
    } as never);

    const out = await pushAllToAgents({ creds, repo: "/r", onLine: vi.fn() });

    expect(out).toEqual({ pushed: 1, failed: 0 });
    expect(patchUserAgent).toHaveBeenCalledTimes(1);
  });
});

// Helper for the push tests: route fsRead by suffix so the .json file
// returns its disk shape and the three .md blocks return their per-file
// content. Mirrors how the runtime pulls each block separately for
// instruction assembly.
function mockFsRead(opts: {
  triageJson: string;
  common?: string;
  cloud?: string;
  local?: string;
}): void {
  vi.mocked(fsRead).mockImplementation(async (path: string) => {
    if (path.endsWith("/triage.json")) return opts.triageJson;
    if (path.endsWith("/common.md")) return opts.common ?? "";
    if (path.endsWith("/cloud.md")) return opts.cloud ?? "";
    if (path.endsWith("/local.md")) return opts.local ?? "";
    throw new Error(`unexpected fsRead: ${path}`);
  });
}

describe("pushAllToAgents — POST flow (no id)", () => {
  it("POSTs with the openit-prefixed name + assembled instructions, writes back server id, bumps manifest mtime to post-write value, fires release", async () => {
    vi.mocked(gitStatusShort).mockResolvedValue([
      {
        path: "agents/triage/triage.json",
        status: " M",
        staged: false,
      },
    ] as never);
    // Local file uses the unprefixed form; the adapter adds the prefix
    // when constructing the cloud body. Instructions are absent on the
    // disk file (V2) — they assemble from common + cloud at push time.
    mockFsRead({
      triageJson: JSON.stringify({
        id: "",
        name: "triage",
        description: "first responder",
      }),
      common: "be helpful",
      cloud: "use MCP",
    });
    const releaseFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      text: async () => "",
    });
    // releaseUserAgent uses makeSkillsFetch via the entities/agent
    // module — that import is already covered by the agent mock at
    // the top, but we need the real fn since it's not mocked. Replace
    // with a controllable spy.
    const agentMod = await import("./entities/agent");
    vi.spyOn(agentMod, "releaseUserAgent").mockImplementation(releaseFetch);
    vi.spyOn(agentMod, "resolveResourceRefs").mockResolvedValue({});
    vi.mocked(postUserAgent).mockResolvedValue({
      id: "ua_new123",
      name: "openit-triage",
      versionDate: "2026-04-30T01:00:00Z",
    } as never);
    vi.mocked(entityListLocal).mockResolvedValue([
      // The post-write listing — mtime is later than anything else; the
      // manifest baseline has to capture this, not Date.now() at push
      // time, otherwise the next poll re-flags the file.
      { filename: "triage.json", mtime_ms: 9_999_999, size: 100 } as never,
    ]);

    const out = await pushAllToAgents({ creds, repo: "/r", onLine: vi.fn() });

    expect(out).toEqual({ pushed: 1, failed: 0 });
    // Cloud body carries the prefix and the assembled instructions.
    expect(postUserAgent).toHaveBeenCalledWith(creds, {
      name: "openit-triage",
      description: "first responder",
      instructions: "be helpful\n\nuse MCP",
    });
    // The disk file is rewritten with the server id but keeps the local
    // unprefixed name. Folder layout — agents/triage subdir.
    expect(entityWriteFile).toHaveBeenCalledWith(
      "/r",
      "agents/triage",
      "triage.json",
      expect.stringContaining("ua_new123"),
    );
    const writeCall = vi
      .mocked(entityWriteFile)
      .mock.calls.find((call) => call[2] === "triage.json");
    expect(writeCall![3]).toContain('"name": "triage"');
    expect(writeCall![3]).not.toContain('"name": "openit-triage"');
    // Release fired post-upsert.
    expect(releaseFetch).toHaveBeenCalledWith(creds, "ua_new123");
    // entity_state_save fires with the new manifest entry, post-write
    // mtime, the pushed_instructions_hash, and the remote_id.
    const saveCalls = vi
      .mocked(invoke)
      .mock.calls.filter(([c]) => c === "entity_state_save");
    const lastSave = saveCalls[saveCalls.length - 1];
    expect(lastSave).toBeTruthy();
    const savedState = (lastSave![1] as { state: { files: Record<string, { pulled_at_mtime_ms: number; pushed_instructions_hash?: string; remote_id?: string }> } }).state;
    expect(savedState.files["triage.json"].pulled_at_mtime_ms).toBe(9_999_999);
    expect(savedState.files["triage.json"].pushed_instructions_hash).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(savedState.files["triage.json"].remote_id).toBe("ua_new123");
  });
});

describe("pushAllToAgents — PATCH flow (id present)", () => {
  it("PATCHes with the openit-prefixed name and assembled instructions, never POSTs", async () => {
    vi.mocked(gitStatusShort).mockResolvedValue([
      {
        path: "agents/triage/triage.json",
        status: " M",
        staged: false,
      },
    ] as never);
    mockFsRead({
      triageJson: JSON.stringify({
        id: "ua_existing",
        name: "triage",
        description: "d",
      }),
      common: "alpha",
      cloud: "beta",
    });
    vi.mocked(patchUserAgent).mockResolvedValue({
      id: "ua_existing",
      name: "openit-triage",
      versionDate: "2026-04-30T02:00:00Z",
    } as never);
    vi.mocked(entityListLocal).mockResolvedValue([
      { filename: "triage.json", mtime_ms: 5000, size: 80 } as never,
    ]);
    const agentMod = await import("./entities/agent");
    vi.spyOn(agentMod, "releaseUserAgent").mockResolvedValue();
    vi.spyOn(agentMod, "resolveResourceRefs").mockResolvedValue({});

    const out = await pushAllToAgents({ creds, repo: "/r", onLine: vi.fn() });

    expect(out).toEqual({ pushed: 1, failed: 0 });
    expect(patchUserAgent).toHaveBeenCalledWith(creds, "ua_existing", {
      name: "openit-triage",
      description: "d",
      instructions: "alpha\n\nbeta",
    });
    expect(postUserAgent).not.toHaveBeenCalled();
  });
});

describe("pushAllToAgents — body construction (omit-when-absent)", () => {
  it("omits absent V2 fields from the body but includes them when present on disk", async () => {
    vi.mocked(gitStatusShort).mockResolvedValue([
      {
        path: "agents/triage/triage.json",
        status: " M",
        staged: false,
      },
    ] as never);
    mockFsRead({
      triageJson: JSON.stringify({
        id: "ua_x",
        name: "triage",
        description: "d",
        selectedModel: "haiku",
        promptExamples: ["a", "b"],
      }),
      common: "c",
      cloud: "d",
    });
    vi.mocked(patchUserAgent).mockResolvedValue({
      id: "ua_x",
      versionDate: "2026-04-30T02:00:00Z",
    } as never);
    vi.mocked(entityListLocal).mockResolvedValue([
      { filename: "triage.json", mtime_ms: 5000, size: 80 } as never,
    ]);
    const agentMod = await import("./entities/agent");
    vi.spyOn(agentMod, "releaseUserAgent").mockResolvedValue();
    vi.spyOn(agentMod, "resolveResourceRefs").mockResolvedValue({});

    await pushAllToAgents({ creds, repo: "/r", onLine: vi.fn() });

    const [, , body] = vi.mocked(patchUserAgent).mock.calls[0];
    expect(body.selectedModel).toBe("haiku");
    expect(body.promptExamples).toEqual(["a", "b"]);
    // isShared / introMessage / resources / servers absent on disk → omit
    expect(Object.keys(body)).not.toContain("isShared");
    expect(Object.keys(body)).not.toContain("introMessage");
    expect(Object.keys(body)).not.toContain("knowledgeBases");
    expect(Object.keys(body)).not.toContain("datastores");
    expect(Object.keys(body)).not.toContain("filestores");
    expect(Object.keys(body)).not.toContain("servers");
  });
});

describe("pushAllToAgents — release retry", () => {
  it("flags release_pending in manifest when release call fails after upsert", async () => {
    vi.mocked(gitStatusShort).mockResolvedValue([
      { path: "agents/triage/triage.json", status: " M", staged: false } as never,
    ]);
    mockFsRead({
      triageJson: JSON.stringify({ id: "ua_x", name: "triage", description: "d" }),
    });
    vi.mocked(patchUserAgent).mockResolvedValue({
      id: "ua_x",
      versionDate: "2026-04-30T02:00:00Z",
    } as never);
    vi.mocked(entityListLocal).mockResolvedValue([
      { filename: "triage.json", mtime_ms: 5000, size: 80 } as never,
    ]);
    const agentMod = await import("./entities/agent");
    vi.spyOn(agentMod, "releaseUserAgent").mockRejectedValue(
      new Error("HTTP 503: upstream"),
    );
    vi.spyOn(agentMod, "resolveResourceRefs").mockResolvedValue({});

    const onLine = vi.fn();
    const out = await pushAllToAgents({ creds, repo: "/r", onLine });

    // Upsert succeeded; release failure doesn't decrement pushed count.
    expect(out).toEqual({ pushed: 1, failed: 0 });
    const saveCalls = vi
      .mocked(invoke)
      .mock.calls.filter(([c]) => c === "entity_state_save");
    const lastSave = saveCalls[saveCalls.length - 1];
    const saved = (lastSave![1] as { state: { files: Record<string, { release_pending?: boolean }> } }).state;
    expect(saved.files["triage.json"].release_pending).toBe(true);
    expect(onLine.mock.calls.some(([l]) => /release failed/.test(l))).toBe(true);
  });

  it("retries pending release before the dirty-list early-return; clears the flag on success", async () => {
    // No dirty files, but manifest has a release_pending entry.
    vi.mocked(gitStatusShort).mockResolvedValue([]);
    vi.mocked(entityListLocal).mockResolvedValue([
      { filename: "triage.json", mtime_ms: 1000, size: 80 } as never,
    ]);
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "entity_state_load") {
        return {
          files: {
            "triage.json": {
              remote_version: "x",
              pulled_at_mtime_ms: 5000, // mtime 1000 < 5000 → not dirty
              release_pending: true,
              remote_id: "ua_existing",
            },
          },
        } as never;
      }
      return undefined as never;
    });
    const agentMod = await import("./entities/agent");
    const releaseSpy = vi.spyOn(agentMod, "releaseUserAgent").mockResolvedValue();

    const onLine = vi.fn();
    const out = await pushAllToAgents({ creds, repo: "/r", onLine });

    expect(out).toEqual({ pushed: 0, failed: 0 });
    expect(releaseSpy).toHaveBeenCalledWith(creds, "ua_existing");
    expect(onLine.mock.calls.some(([l]) => /retried release/.test(l))).toBe(true);
  });
});

describe("migrateFlatTriage", () => {
  // The shim probes disk via fs_read; configure the invoke mock so the
  // probes read the right paths and the migration writes call back into
  // entity_write_file.
  function setupFs(opts: {
    flatExists: boolean;
    folderExists: boolean;
    flatContent?: string;
  }): {
    writes: Array<{ subdir: string; filename: string; content: string }>;
    deletes: Array<{ subdir: string; filename: string }>;
  } {
    const writes: Array<{
      subdir: string;
      filename: string;
      content: string;
    }> = [];
    const deletes: Array<{ subdir: string; filename: string }> = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "fs_read") {
        const { path } = args as { path: string };
        if (path.endsWith("/agents/triage.json")) {
          if (!opts.flatExists) throw new Error("ENOENT");
          return (opts.flatContent ?? "{}") as never;
        }
        if (path.endsWith("/agents/triage/triage.json")) {
          if (!opts.folderExists) throw new Error("ENOENT");
          return "{}" as never;
        }
        throw new Error(`unexpected fs_read: ${path}`);
      }
      return undefined as never;
    });
    vi.mocked(fsRead).mockImplementation(async (path: string) => {
      if (path.endsWith("/agents/triage.json")) return opts.flatContent ?? "{}";
      throw new Error(`unexpected fsRead: ${path}`);
    });
    vi.mocked(entityWriteFile).mockImplementation(
      async (_repo, subdir, filename, content) => {
        writes.push({ subdir, filename, content });
      },
    );
    vi.mocked(entityDeleteFile).mockImplementation(
      async (_repo, subdir, filename) => {
        deletes.push({ subdir, filename });
      },
    );
    return { writes, deletes };
  }

  it("moves flat agents/triage.json into agents/triage/ folder, preserving instructions verbatim in common.md", async () => {
    const flatContent = JSON.stringify({
      id: "ua_x",
      name: "triage",
      description: "first responder",
      instructions: "be helpful and be specific",
      selectedModel: "haiku",
    });
    const { writes, deletes } = setupFs({
      flatExists: true,
      folderExists: false,
      flatContent,
    });

    await migrateFlatTriage("/r");

    // triage.json: structured fields only (instructions stripped).
    const jsonWrite = writes.find(
      (w) => w.subdir === "agents/triage" && w.filename === "triage.json",
    );
    expect(jsonWrite).toBeTruthy();
    const written = JSON.parse(jsonWrite!.content);
    expect(written).toEqual({
      id: "ua_x",
      name: "triage",
      description: "first responder",
      selectedModel: "haiku",
    });
    expect(written.instructions).toBeUndefined();

    // common.md gets the verbatim instructions string.
    const mdWrite = writes.find(
      (w) => w.subdir === "agents/triage" && w.filename === "common.md",
    );
    expect(mdWrite?.content).toBe("be helpful and be specific");

    // Flat file deleted.
    expect(deletes).toContainEqual({
      subdir: "agents",
      filename: "triage.json",
    });
  });

  it("no-ops when only the folder layout exists", async () => {
    const { writes, deletes } = setupFs({
      flatExists: false,
      folderExists: true,
    });

    await migrateFlatTriage("/r");

    expect(writes).toEqual([]);
    expect(deletes).toEqual([]);
  });

  it("no-ops when both layouts exist (folder wins)", async () => {
    const { writes, deletes } = setupFs({
      flatExists: true,
      folderExists: true,
      flatContent: JSON.stringify({ name: "triage", instructions: "x" }),
    });

    await migrateFlatTriage("/r");

    expect(writes).toEqual([]);
    expect(deletes).toEqual([]);
  });

  it("skips common.md write when instructions is empty/missing but still moves structured fields and deletes flat", async () => {
    const flatContent = JSON.stringify({ id: "ua_x", name: "triage" });
    const { writes, deletes } = setupFs({
      flatExists: true,
      folderExists: false,
      flatContent,
    });

    await migrateFlatTriage("/r");

    const mdWrite = writes.find((w) => w.filename === "common.md");
    expect(mdWrite).toBeUndefined();
    const jsonWrite = writes.find((w) => w.filename === "triage.json");
    expect(jsonWrite).toBeTruthy();
    expect(deletes).toContainEqual({
      subdir: "agents",
      filename: "triage.json",
    });
  });
});

describe("pushAllToAgents — OutOfSync recovery", () => {
  it("on PATCH 409 → re-pulls via pullEntity and counts the file as failed", async () => {
    vi.mocked(entityListLocal).mockResolvedValue([
      { filename: "triage.json", mtime_ms: 5000, size: 80 } as never,
    ]);
    vi.mocked(gitStatusShort).mockResolvedValue([
      {
        path: "agents/triage.json",
        status: " M",
        staged: false,
      },
    ] as never);
    vi.mocked(fsRead).mockResolvedValue(
      JSON.stringify({
        id: "ua_x",
        name: "triage",
        description: "",
        instructions: "edit",
      }),
    );
    vi.mocked(patchUserAgent).mockRejectedValue(new OutOfSync());
    vi.mocked(pullEntity).mockResolvedValue({
      pulled: 1,
      remoteCount: 1,
      conflicts: [],
      paginationFailed: false,
    } as never);

    const onLine = vi.fn();
    const out = await pushAllToAgents({ creds, repo: "/r", onLine });

    expect(out).toEqual({ pushed: 0, failed: 1 });
    expect(pullEntity).toHaveBeenCalledTimes(1);
    expect(onLine.mock.calls.some(([l]) => /out of sync/.test(l))).toBe(true);
  });
});
