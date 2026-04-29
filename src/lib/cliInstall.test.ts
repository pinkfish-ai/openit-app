import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { CATALOG } from "./cliCatalog";
import {
  installCli,
  listInstalled,
  removeHintOnly,
  uninstallCli,
  UninstallError,
} from "./cliInstall";

const mockedInvoke = vi.mocked(invoke);

beforeEach(() => {
  mockedInvoke.mockReset();
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
  it("invokes cli_install with the entry's brew_pkg and CLAUDE.md hint", async () => {
    mockedInvoke.mockResolvedValueOnce(undefined);
    const entry = CATALOG.find((e) => e.id === "gh")!;
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
});

describe("uninstallCli", () => {
  it("calls cli_uninstall with the entry's brew_pkg and id", async () => {
    mockedInvoke.mockResolvedValueOnce(undefined);
    const entry = CATALOG[0];
    await uninstallCli("/tmp/proj", entry);
    expect(mockedInvoke).toHaveBeenCalledWith("cli_uninstall", {
      args: { project_root: "/tmp/proj", brew_pkg: entry.brewPkg, entry_id: entry.id },
    });
  });

  it("wraps brew failures in UninstallError with hintRemoved=true", async () => {
    mockedInvoke.mockRejectedValueOnce(new Error("brew uninstall failed: not installed"));
    const entry = CATALOG[0];
    await expect(uninstallCli("/tmp/proj", entry)).rejects.toBeInstanceOf(
      UninstallError,
    );
    try {
      await uninstallCli("/tmp/proj", entry);
    } catch (e) {
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
