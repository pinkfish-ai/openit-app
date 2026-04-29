// Tests for the openit-* filtering and default-collection naming changes
// landed in Phase 1 of V2 sync (PIN-5775). These cover the pure helpers
// — `dedupeByName` and `displayFilestoreName` — directly. The networked
// resolver `resolveProjectFilestores` is exercised end-to-end via the
// manual scenarios in the plan; mocking `makeSkillsFetch` + auth state
// for unit tests would mostly assert on the mock, not the behaviour
// users care about.

import { describe, expect, it } from "vitest";
import type { DataCollection } from "./skillsApi";
import {
  OPENIT_FILESTORE_PREFIX,
  dedupeByName,
  displayFilestoreName,
  getDefaultFilestores,
} from "./filestoreSync";

function row(overrides: Partial<DataCollection> & { id: string; name: string }): DataCollection {
  return {
    description: "",
    type: "filestorage",
    ...overrides,
  } as DataCollection;
}

describe("getDefaultFilestores", () => {
  it("returns a single openit-library default", () => {
    const defaults = getDefaultFilestores("any-org");
    expect(defaults).toHaveLength(1);
    expect(defaults[0].name).toBe("openit-library");
  });

  it("default name carries the openit- prefix", () => {
    const defaults = getDefaultFilestores("any-org");
    for (const d of defaults) {
      expect(d.name.startsWith(OPENIT_FILESTORE_PREFIX)).toBe(true);
    }
  });

  it("ignores the orgId argument (Phase 1: name no longer carries org)", () => {
    const a = getDefaultFilestores("org-abc");
    const b = getDefaultFilestores("org-xyz");
    expect(a).toEqual(b);
  });
});

describe("displayFilestoreName", () => {
  it("strips the openit- prefix when present", () => {
    expect(displayFilestoreName("openit-library")).toBe("library");
    expect(displayFilestoreName("openit-attachments")).toBe("attachments");
  });

  it("returns the input unchanged when the prefix is absent", () => {
    expect(displayFilestoreName("library")).toBe("library");
    expect(displayFilestoreName("customer-feedback")).toBe("customer-feedback");
  });

  it("handles the prefix as the entire name (degenerate but defined)", () => {
    expect(displayFilestoreName("openit-")).toBe("");
  });
});

describe("dedupeByName", () => {
  const defaults = getDefaultFilestores("any-org");

  it("filters out collections without the openit- prefix", () => {
    const result = dedupeByName(
      [
        row({ id: "1", name: "customer-feedback" }),
        row({ id: "2", name: "openit-library" }),
        row({ id: "3", name: "internal-archive" }),
      ],
      defaults,
    );
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("openit-library");
    expect(result[0].id).toBe("2");
  });

  it("filters out openit-prefixed collections that aren't in the defaults list", () => {
    // Phase 1 only manages `openit-library`. A user manually creating
    // `openit-experimental` shouldn't get auto-synced.
    const result = dedupeByName(
      [
        row({ id: "1", name: "openit-library" }),
        row({ id: "2", name: "openit-experimental" }),
      ],
      defaults,
    );
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("openit-library");
  });

  it("returns the lexicographically smallest id when duplicates exist", () => {
    // Legacy duplicates (same name, different ids) — keep the smallest id
    // so every caller in the same session converges on the same one.
    const result = dedupeByName(
      [
        row({ id: "Z", name: "openit-library" }),
        row({ id: "A", name: "openit-library" }),
        row({ id: "M", name: "openit-library" }),
      ],
      defaults,
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("A");
  });

  it("returns an empty list when no openit-* collections are present", () => {
    const result = dedupeByName(
      [
        row({ id: "1", name: "library" }), // missing prefix
        row({ id: "2", name: "customer-feedback" }),
      ],
      defaults,
    );
    expect(result).toHaveLength(0);
  });

  it("returns an empty list for an empty input", () => {
    expect(dedupeByName([], defaults)).toEqual([]);
  });

  it("preserves description when matching", () => {
    const result = dedupeByName(
      [row({ id: "1", name: "openit-library", description: "remote desc" })],
      defaults,
    );
    expect(result[0].description).toBe("remote desc");
  });
});
