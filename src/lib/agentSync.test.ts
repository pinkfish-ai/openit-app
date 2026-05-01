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
  entityListLocal,
  entityWriteFile,
  fsRead,
  gitStatusShort,
} from "./api";
import {
  patchUserAgent,
  postUserAgent,
} from "./entities/agent";
import { pushAllToAgents } from "./agentSync";
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
  it("skips clean working tree (no dirty agents/* files)", async () => {
    vi.mocked(gitStatusShort).mockResolvedValue([]);
    const onLine = vi.fn();

    const out = await pushAllToAgents({ creds, repo: "/r", onLine });

    expect(out).toEqual({ pushed: 0, failed: 0 });
    expect(postUserAgent).not.toHaveBeenCalled();
    expect(patchUserAgent).not.toHaveBeenCalled();
  });

  it("skips shadow files (`.server.json`)", async () => {
    vi.mocked(gitStatusShort).mockResolvedValue([
      { path: "agents/triage.server.json", status: " M", staged: false },
    ] as never);
    const onLine = vi.fn();

    const out = await pushAllToAgents({ creds, repo: "/r", onLine });

    expect(out).toEqual({ pushed: 0, failed: 0 });
    expect(postUserAgent).not.toHaveBeenCalled();
  });

  it("skips non-json files under agents/", async () => {
    vi.mocked(gitStatusShort).mockResolvedValue([
      { path: "agents/README.md", status: " M", staged: false },
    ] as never);

    const out = await pushAllToAgents({ creds, repo: "/r", onLine: vi.fn() });

    expect(out).toEqual({ pushed: 0, failed: 0 });
  });

  it("ignores files outside agents/", async () => {
    vi.mocked(gitStatusShort).mockResolvedValue([
      { path: "knowledge-bases/default/note.md", status: " M", staged: false },
    ] as never);

    const out = await pushAllToAgents({ creds, repo: "/r", onLine: vi.fn() });

    expect(out).toEqual({ pushed: 0, failed: 0 });
  });
});

describe("pushAllToAgents — POST flow (no id)", () => {
  it("POSTs with the openit-prefixed name, writes back server id, bumps manifest mtime to post-write value", async () => {
    vi.mocked(gitStatusShort).mockResolvedValue([
      {
        path: "agents/triage.json",
        status: " M",
        staged: false,
      },
    ] as never);
    // Local file uses the unprefixed form; the adapter adds the prefix
    // when constructing the cloud body.
    vi.mocked(fsRead).mockResolvedValue(
      JSON.stringify({
        id: "",
        name: "triage",
        description: "first responder",
        instructions: "be helpful",
      }),
    );
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
    // Cloud body carries the prefix; local disk does not.
    expect(postUserAgent).toHaveBeenCalledWith(creds, {
      name: "openit-triage",
      description: "first responder",
      instructions: "be helpful",
    });
    // The disk file is rewritten with the server id but keeps the local
    // unprefixed name.
    expect(entityWriteFile).toHaveBeenCalledWith(
      "/r",
      "agents",
      "triage.json",
      expect.stringContaining("ua_new123"),
    );
    const writeCall = vi
      .mocked(entityWriteFile)
      .mock.calls.find((call) => call[2] === "triage.json");
    expect(writeCall![3]).toContain('"name": "triage"');
    expect(writeCall![3]).not.toContain('"name": "openit-triage"');
    // entity_state_save fires with the new manifest entry.
    const saveCall = vi
      .mocked(invoke)
      .mock.calls.find(([c]) => c === "entity_state_save");
    expect(saveCall).toBeTruthy();
    const savedState = (saveCall![1] as { state: { files: Record<string, { pulled_at_mtime_ms: number }> } }).state;
    expect(savedState.files["triage.json"].pulled_at_mtime_ms).toBe(9_999_999);
  });
});

describe("pushAllToAgents — PATCH flow (id present)", () => {
  it("PATCHes with the openit-prefixed name and never POSTs", async () => {
    vi.mocked(gitStatusShort).mockResolvedValue([
      {
        path: "agents/triage.json",
        status: " M",
        staged: false,
      },
    ] as never);
    vi.mocked(fsRead).mockResolvedValue(
      JSON.stringify({
        id: "ua_existing",
        name: "triage",
        description: "d",
        instructions: "i",
      }),
    );
    vi.mocked(patchUserAgent).mockResolvedValue({
      id: "ua_existing",
      name: "openit-triage",
      versionDate: "2026-04-30T02:00:00Z",
    } as never);
    vi.mocked(entityListLocal).mockResolvedValue([
      { filename: "triage.json", mtime_ms: 5000, size: 80 } as never,
    ]);

    const out = await pushAllToAgents({ creds, repo: "/r", onLine: vi.fn() });

    expect(out).toEqual({ pushed: 1, failed: 0 });
    expect(patchUserAgent).toHaveBeenCalledWith(creds, "ua_existing", {
      name: "openit-triage",
      description: "d",
      instructions: "i",
    });
    expect(postUserAgent).not.toHaveBeenCalled();
  });
});

describe("pushAllToAgents — OutOfSync recovery", () => {
  it("on PATCH 409 → re-pulls via pullEntity and counts the file as failed", async () => {
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
