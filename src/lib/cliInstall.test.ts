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
  buildInstallPrompt,
  buildUninstallPrompt,
  listInstalled,
  requestCliInstall,
  requestCliUninstall,
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

describe("buildInstallPrompt", () => {
  it("includes brew suggestion, docs URL, marker line, and entry id", () => {
    const entry = findEntry("gh")!;
    const prompt = buildInstallPrompt(entry);
    expect(prompt).toContain("brew install gh");
    expect(prompt).toContain(entry.docsUrl);
    expect(prompt).toContain(`<!-- entry:gh -->`);
    expect(prompt).toContain(entry.claudeMdHint);
    expect(prompt).toContain("which gh");
  });

  it("works for every catalog entry", () => {
    for (const entry of CATALOG) {
      const prompt = buildInstallPrompt(entry);
      expect(prompt).toContain(entry.brewPkg);
      expect(prompt).toContain(entry.binary);
      expect(prompt).toContain(entry.claudeMdHint);
    }
  });
});

describe("buildUninstallPrompt", () => {
  it("includes brew uninstall suggestion and the entry-id removal instruction", () => {
    const entry = findEntry("aws")!;
    const prompt = buildUninstallPrompt(entry);
    expect(prompt).toContain(`brew uninstall ${entry.brewPkg}`);
    expect(prompt).toContain(`<!-- entry:${entry.id} -->`);
  });
});

describe("requestCliInstall / requestCliUninstall", () => {
  it("writes the install prompt + carriage return to the active session", async () => {
    mockedWrite.mockResolvedValueOnce(true);
    const entry = findEntry("gh")!;
    const ok = await requestCliInstall(entry);
    expect(ok).toBe(true);
    expect(mockedWrite).toHaveBeenCalledTimes(1);
    const written = mockedWrite.mock.calls[0][0];
    expect(written.endsWith("\r")).toBe(true);
    expect(written).toContain("brew install gh");
  });

  it("returns false when no Claude session is active", async () => {
    mockedWrite.mockResolvedValueOnce(false);
    const entry = findEntry("gh")!;
    const ok = await requestCliInstall(entry);
    expect(ok).toBe(false);
  });

  it("uninstall writes the uninstall prompt", async () => {
    mockedWrite.mockResolvedValueOnce(true);
    const entry = findEntry("op")!;
    await requestCliUninstall(entry);
    const written = mockedWrite.mock.calls[0][0];
    expect(written).toContain("Please uninstall");
    expect(written).toContain(`brew uninstall ${entry.brewPkg}`);
  });
});
