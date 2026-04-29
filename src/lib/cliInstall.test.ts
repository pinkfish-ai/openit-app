import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("../shell/activeSession", () => ({
  writeToActiveSession: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { writeToActiveSession } from "../shell/activeSession";
import { CATALOG, findEntry } from "./cliCatalog";
import {
  buildInstallDebugPrompt,
  buildUninstallDebugPrompt,
  installCli,
  listInstalled,
  removeHintOnly,
  requestInstallDebug,
  requestUninstallDebug,
  uninstallCli,
  UninstallError,
} from "./cliInstall";

const mockedInvoke = vi.mocked(invoke);
const mockedWrite = vi.mocked(writeToActiveSession);

beforeEach(() => {
  mockedInvoke.mockReset();
  mockedWrite.mockReset();
});

describe("listInstalled", () => {
  it("returns the set of catalog ids whose binary cli_is_installed reports true", async () => {
    mockedInvoke.mockImplementation(async (cmd, args) => {
      if (cmd !== "cli_is_installed") return false;
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

describe("installCli", () => {
  it("invokes cli_install with the entry's brew_pkg, id, and CLAUDE.md hint", async () => {
    mockedInvoke.mockResolvedValueOnce(undefined);
    const entry = findEntry("gh")!;
    await installCli("/tmp/proj", entry);
    expect(mockedInvoke).toHaveBeenCalledWith("cli_install", {
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
    await expect(installCli("/tmp/proj", entry)).rejects.toThrow(/No formula found/);
  });
});

describe("uninstallCli", () => {
  it("calls cli_uninstall with the entry's brew_pkg and id", async () => {
    mockedInvoke.mockResolvedValueOnce(undefined);
    const entry = CATALOG[0];
    await uninstallCli("/tmp/proj", entry);
    expect(mockedInvoke).toHaveBeenCalledWith("cli_uninstall", {
      args: {
        project_root: "/tmp/proj",
        brew_pkg: entry.brewPkg,
        entry_id: entry.id,
      },
    });
  });

  it("wraps brew failures in UninstallError with hintRemoved=true", async () => {
    mockedInvoke.mockRejectedValueOnce(new Error("brew uninstall failed"));
    const entry = CATALOG[0];
    try {
      await uninstallCli("/tmp/proj", entry);
      expect.fail("expected UninstallError");
    } catch (e) {
      expect(e).toBeInstanceOf(UninstallError);
      expect((e as UninstallError).hintRemoved).toBe(true);
    }
  });
});

describe("removeHintOnly", () => {
  it("calls cli_remove_hint_only with project root and entry id", async () => {
    mockedInvoke.mockResolvedValueOnce(undefined);
    const entry = CATALOG[0];
    await removeHintOnly("/tmp/proj", entry);
    expect(mockedInvoke).toHaveBeenCalledWith("cli_remove_hint_only", {
      projectRoot: "/tmp/proj",
      entryId: entry.id,
    });
  });
});

describe("buildInstallDebugPrompt", () => {
  it("includes the brew command, the captured stderr, the docs URL, and the marker line", () => {
    const entry = findEntry("gh")!;
    const stderr = "Error: No formula with name 'gh' found";
    const prompt = buildInstallDebugPrompt(entry, stderr);
    expect(prompt).toContain(`brew install ${entry.brewPkg}`);
    expect(prompt).toContain(stderr);
    expect(prompt).toContain(entry.docsUrl);
    expect(prompt).toContain(`<!-- entry:${entry.id} -->`);
    expect(prompt).toContain(entry.claudeMdHint);
  });
});

describe("buildUninstallDebugPrompt", () => {
  it("includes the brew uninstall command and the captured stderr", () => {
    const entry = CATALOG[0];
    const stderr = "Error: No such keg";
    const prompt = buildUninstallDebugPrompt(entry, stderr);
    expect(prompt).toContain(`brew uninstall ${entry.brewPkg}`);
    expect(prompt).toContain(stderr);
    expect(prompt).toContain(entry.id);
  });
});

describe("requestInstallDebug / requestUninstallDebug", () => {
  it("writes the install-debug prompt to the active session", async () => {
    mockedWrite.mockResolvedValueOnce(true);
    const entry = findEntry("gh")!;
    const ok = await requestInstallDebug(entry, "Some error");
    expect(ok).toBe(true);
    const written = mockedWrite.mock.calls[0][0];
    expect(written.endsWith("\r")).toBe(true);
    expect(written).toContain("Some error");
  });

  it("returns false when no Claude session is active", async () => {
    mockedWrite.mockResolvedValueOnce(false);
    const entry = findEntry("gh")!;
    const ok = await requestInstallDebug(entry, "stderr");
    expect(ok).toBe(false);
  });

  it("uninstall debug writes the uninstall prompt", async () => {
    mockedWrite.mockResolvedValueOnce(true);
    const entry = CATALOG[0];
    await requestUninstallDebug(entry, "uninstall stderr");
    const written = mockedWrite.mock.calls[0][0];
    expect(written).toContain("uninstall stderr");
    expect(written).toContain(`brew uninstall ${entry.brewPkg}`);
  });
});
