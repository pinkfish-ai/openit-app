import { describe, expect, it } from "vitest";
import { CATALOG, findEntry } from "./mcpCatalog";

describe("MCP catalog", () => {
  it("has no duplicate ids", () => {
    const ids = CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every entry has an https url", () => {
    for (const entry of CATALOG) {
      expect(entry.url, `${entry.id} missing url`).toMatch(/^https:\/\//);
    }
  });

  it("every entry has non-empty name and description", () => {
    for (const entry of CATALOG) {
      expect(entry.name.trim()).not.toBe("");
      expect(entry.description.trim()).not.toBe("");
    }
  });

  it("findEntry returns the matching entry or undefined", () => {
    expect(findEntry("github")?.name).toBe("GitHub");
    expect(findEntry("does-not-exist")).toBeUndefined();
  });
});
