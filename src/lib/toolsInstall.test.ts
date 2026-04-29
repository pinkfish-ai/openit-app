import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("../shell/activeSession", () => ({
  writeToActiveSession: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { writeToActiveSession } from "../shell/activeSession";
import { CATALOG, findEntry } from "./toolsCatalog";
import {
  buildAgentInstallPrompt,
  buildAgentUninstallPrompt,
  installTool,
  listInstalled,
  removeHintOnly,
  requestAgentInstall,
  requestAgentUninstall,
  uninstallTool,
  UninstallError,
} from "./toolsInstall";

const mockedInvoke = vi.mocked(invoke);
const mockedWrite = vi.mocked(writeToActiveSession);

beforeEach(() => {
  mockedInvoke.mockReset();
  mockedWrite.mockReset();
});

describe("listInstalled", () => {
  it("returns the set of catalog ids whose binary tools_is_installed reports true", async () => {
    mockedInvoke.mockImplementation(async (cmd, args) => {
      if (cmd !== "tools_is_installed") return false;
      const binary = (args as { binary?: string } | undefined)?.binary;
      return binary === "gh" || binary === "aws";
    });
    const result = await listInstalled();
    expect(result.has("gh")).toBe(true);
    expect(result.has("aws")).toBe(true);
    expect(result.has("op")).toBe(false);
  });

  it("treats invoke failures as not-installed", async () => {
    mockedInvoke.mockRejectedValue(new Error("boom"));
    const result = await listInstalled();
    expect(result.size).toBe(0);
  });
});

describe("installTool (macOS programmatic path)", () => {
  it("invokes tools_install with the entry's brew_pkg, id, and CLAUDE.md hint", async () => {
    mockedInvoke.mockResolvedValueOnce(undefined);
    const entry = findEntry("gh")!;
    await installTool("/tmp/proj", entry);
    expect(mockedInvoke).toHaveBeenCalledWith("tools_install", {
      args: {
        project_root: "/tmp/proj",
        brew_pkg: entry.brewPkg,
        entry_id: entry.id,
        claude_md_line: entry.claudeMdHint,
      },
    });
  });

  it("propagates the brew stderr on failure", async () => {
    mockedInvoke.mockRejectedValueOnce(
      new Error("brew install gh failed (exit 1): No formula found"),
    );
    const entry = findEntry("gh")!;
    await expect(installTool("/tmp/proj", entry)).rejects.toThrow(/No formula found/);
  });
});

describe("uninstallTool", () => {
  it("calls tools_uninstall with the entry's brew_pkg and id", async () => {
    mockedInvoke.mockResolvedValueOnce(undefined);
    const entry = CATALOG[0];
    await uninstallTool("/tmp/proj", entry);
    expect(mockedInvoke).toHaveBeenCalledWith("tools_uninstall", {
      args: {
        project_root: "/tmp/proj",
        brew_pkg: entry.brewPkg,
        entry_id: entry.id,
      },
    });
  });

  it("wraps brew failures in UninstallError", async () => {
    mockedInvoke.mockRejectedValueOnce(new Error("brew uninstall failed"));
    const entry = CATALOG[0];
    try {
      await uninstallTool("/tmp/proj", entry);
      expect.fail("expected UninstallError");
    } catch (e) {
      expect(e).toBeInstanceOf(UninstallError);
    }
  });
});

describe("removeHintOnly", () => {
  it("calls tools_remove_hint_only with project root and entry id", async () => {
    mockedInvoke.mockResolvedValueOnce(undefined);
    const entry = CATALOG[0];
    await removeHintOnly("/tmp/proj", entry);
    expect(mockedInvoke).toHaveBeenCalledWith("tools_remove_hint_only", {
      projectRoot: "/tmp/proj",
      entryId: entry.id,
    });
  });
});

describe("buildAgentInstallPrompt — brew-failed context", () => {
  it("includes the brew command, captured stderr, docs URL, and marker line", () => {
    const entry = findEntry("gh")!;
    const stderr = "Error: No formula with name 'gh' found";
    const prompt = buildAgentInstallPrompt(entry, {
      kind: "brew-failed",
      stderr,
    });
    expect(prompt).toContain(`brew install ${entry.brewPkg}`);
    expect(prompt).toContain(stderr);
    expect(prompt).toContain(entry.docsUrl);
    expect(prompt).toContain(`<!-- entry:${entry.id} -->`);
    expect(prompt).toContain(entry.claudeMdHint);
  });
});

describe("buildAgentInstallPrompt — non-macos context", () => {
  it("identifies the target OS, gives the brew package as a hint, and includes the marker line", () => {
    const entry = findEntry("aws")!;
    const prompt = buildAgentInstallPrompt(entry, {
      kind: "non-macos",
      targetOs: "windows",
    });
    expect(prompt).toContain("windows");
    expect(prompt).toContain(entry.brewPkg);
    expect(prompt).toContain(entry.docsUrl);
    expect(prompt).toContain(`<!-- entry:${entry.id} -->`);
    expect(prompt).not.toContain("brew install"); // not the right command on windows
  });

  it("works for linux too", () => {
    const entry = findEntry("gh")!;
    const prompt = buildAgentInstallPrompt(entry, {
      kind: "non-macos",
      targetOs: "linux",
    });
    expect(prompt).toContain("linux");
    expect(prompt).toContain(entry.binary);
  });
});

describe("buildAgentUninstallPrompt", () => {
  it("brew-failed context includes the brew uninstall command and stderr", () => {
    const entry = CATALOG[0];
    const prompt = buildAgentUninstallPrompt(entry, {
      kind: "brew-failed",
      stderr: "Error: No such keg",
    });
    expect(prompt).toContain(`brew uninstall ${entry.brewPkg}`);
    expect(prompt).toContain("No such keg");
  });

  it("non-macos context identifies the OS and the marker entry to remove", () => {
    const entry = CATALOG[0];
    const prompt = buildAgentUninstallPrompt(entry, {
      kind: "non-macos",
      targetOs: "linux",
    });
    expect(prompt).toContain("linux");
    expect(prompt).toContain(`<!-- entry:${entry.id} -->`);
    expect(prompt).not.toContain("brew uninstall");
  });
});

describe("requestAgentInstall / requestAgentUninstall", () => {
  it("writes the prompt to the active session", async () => {
    mockedWrite.mockResolvedValueOnce(true);
    const entry = findEntry("gh")!;
    const ok = await requestAgentInstall(entry, {
      kind: "non-macos",
      targetOs: "linux",
    });
    expect(ok).toBe(true);
    const written = mockedWrite.mock.calls[0][0];
    expect(written.endsWith("\r")).toBe(true);
    expect(written).toContain("linux");
  });

  it("returns false when no Claude session is active", async () => {
    mockedWrite.mockResolvedValueOnce(false);
    const entry = findEntry("gh")!;
    const ok = await requestAgentInstall(entry, {
      kind: "brew-failed",
      stderr: "boom",
    });
    expect(ok).toBe(false);
  });

  it("uninstall variant writes the uninstall prompt", async () => {
    mockedWrite.mockResolvedValueOnce(true);
    const entry = CATALOG[0];
    await requestAgentUninstall(entry, {
      kind: "brew-failed",
      stderr: "uninstall stderr",
    });
    const written = mockedWrite.mock.calls[0][0];
    expect(written).toContain("uninstall stderr");
    expect(written).toContain(`brew uninstall ${entry.brewPkg}`);
  });
});
