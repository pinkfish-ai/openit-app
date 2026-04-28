import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { CATALOG } from "./mcpCatalog";
import { installServer, listInstalled, uninstallServer } from "./mcpInstall";

const mockedInvoke = vi.mocked(invoke);

beforeEach(() => {
  mockedInvoke.mockReset();
});

describe("listInstalled", () => {
  it("returns empty set when .mcp.json is missing", async () => {
    mockedInvoke.mockRejectedValueOnce(new Error("ENOENT"));
    const result = await listInstalled("/tmp/proj");
    expect(result.size).toBe(0);
  });

  it("returns empty set when .mcp.json is malformed", async () => {
    mockedInvoke.mockResolvedValueOnce("{not-json");
    const result = await listInstalled("/tmp/proj");
    expect(result.size).toBe(0);
  });

  it("returns only catalog ids that appear in mcpServers", async () => {
    mockedInvoke.mockResolvedValueOnce(
      JSON.stringify({
        mcpServers: {
          github: { type: "http", url: "https://api.githubcopilot.com/mcp/" },
          unknown: { command: "x", args: [] },
        },
      }),
    );
    const result = await listInstalled("/tmp/proj");
    expect(result.has("github")).toBe(true);
    expect(result.has("unknown")).toBe(false);
  });

  it("strips trailing slashes from project root before reading", async () => {
    mockedInvoke.mockResolvedValueOnce('{"mcpServers": {}}');
    await listInstalled("/tmp/proj/");
    expect(mockedInvoke).toHaveBeenCalledWith("fs_read", {
      path: "/tmp/proj/.mcp.json",
    });
  });
});

describe("installServer", () => {
  it("invokes claude_mcp_add with the entry's url for every catalog entry", async () => {
    for (const entry of CATALOG) {
      mockedInvoke.mockReset();
      mockedInvoke.mockResolvedValueOnce(undefined);
      await installServer("/tmp/proj", entry);
      const [cmd, args] = mockedInvoke.mock.calls[0];
      expect(cmd).toBe("claude_mcp_add");
      const payload = (args as { args: Record<string, unknown> }).args;
      expect(payload.transport).toBe("http");
      expect(payload.url).toBe(entry.url);
      expect(payload.name).toBe(entry.id);
      expect(payload.project_root).toBe("/tmp/proj");
    }
  });
});

describe("uninstallServer", () => {
  it("invokes claude_mcp_remove with the entry's id and project root", async () => {
    mockedInvoke.mockResolvedValueOnce(undefined);
    const entry = CATALOG[0];
    await uninstallServer("/tmp/proj", entry);
    expect(mockedInvoke).toHaveBeenCalledWith("claude_mcp_remove", {
      args: { project_root: "/tmp/proj", name: entry.id },
    });
  });
});
