import { describe, expect, it } from "vitest";
import { CATALOG, findEntry } from "./cliCatalog";

describe("CLI catalog", () => {
  it("has no duplicate ids", () => {
    const ids = CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has no duplicate binaries", () => {
    const binaries = CATALOG.map((e) => e.binary);
    expect(new Set(binaries).size).toBe(binaries.length);
  });

  it("every entry has a brew package and a binary", () => {
    for (const entry of CATALOG) {
      expect(entry.brewPkg.trim()).not.toBe("");
      expect(entry.binary.trim()).not.toBe("");
    }
  });

  it("every entry has non-empty name, description, and CLAUDE.md hint", () => {
    for (const entry of CATALOG) {
      expect(entry.name.trim()).not.toBe("");
      expect(entry.description.trim()).not.toBe("");
      expect(entry.claudeMdHint.trim()).not.toBe("");
    }
  });

  it("every entry has an https docs URL", () => {
    for (const entry of CATALOG) {
      expect(entry.docsUrl).toMatch(/^https:\/\//);
    }
  });

  it("findEntry returns the matching entry or undefined", () => {
    expect(findEntry("gh")?.name).toBe("GitHub CLI");
    expect(findEntry("does-not-exist")).toBeUndefined();
  });
});
