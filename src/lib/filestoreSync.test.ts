// Tests for the openit-* filtering and default-collection naming changes
// landed in Phase 1 of V2 sync (PIN-5775). These cover the pure helpers
// — `dedupeOpenitByName` and `displayFilestoreName` — directly. The
// networked resolver `resolveProjectFilestores` is exercised end-to-end
// via integration tests in integration_tests/; mocking
// `makeSkillsFetch` + auth state for unit tests would mostly assert on
// the mock, not the behaviour users care about.

import { describe, expect, it } from "vitest";
import type { DataCollection } from "./skillsApi";
import {
  OPENIT_FILESTORE_PREFIX,
  dedupeOpenitByName,
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
  it("returns the four defaults: openit-library, openit-attachments, openit-skills, openit-scripts", () => {
    const defaults = getDefaultFilestores("any-org");
    expect(defaults).toHaveLength(4);
    const names = defaults.map((d) => d.name);
    expect(names).toContain("openit-library");
    expect(names).toContain("openit-attachments");
    expect(names).toContain("openit-skills");
    expect(names).toContain("openit-scripts");
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

describe("dedupeOpenitByName", () => {
  // The runtime resolver wants every openit-* collection (defaults +
  // per-org dynamic ones like `openit-docs-<orgId>`), not just the
  // hardcoded defaults set. Phase 1 dropped a tighter
  // defaults-filter variant that was only used in tests, so this is now
  // the single source of truth for "what does sync see?".

  it("keeps every openit-* collection", () => {
    const result = dedupeOpenitByName([
      row({ id: "1", name: "openit-library" }),
      row({ id: "2", name: "openit-attachments" }),
      row({ id: "3", name: "openit-experimental" }),
      row({ id: "4", name: "openit-docs-653713545258" }),
    ]);
    expect(result.map((c) => c.name).sort()).toEqual([
      "openit-attachments",
      "openit-docs-653713545258",
      "openit-experimental",
      "openit-library",
    ]);
  });

  it("filters out collections without the openit- prefix", () => {
    const result = dedupeOpenitByName([
      row({ id: "1", name: "customer-feedback" }),
      row({ id: "2", name: "openit-library" }),
      row({ id: "3", name: "internal-archive" }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("openit-library");
  });

  it("returns the lexicographically smallest id when duplicates exist", () => {
    // Legacy duplicates (same name, different ids) — keep the smallest
    // id so every caller in the same session converges on the same
    // collection, otherwise two adapters would race against the same
    // `filestores/<x>/` folder.
    const result = dedupeOpenitByName([
      row({ id: "Z", name: "openit-library" }),
      row({ id: "A", name: "openit-library" }),
      row({ id: "M", name: "openit-library" }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("A");
  });

  it("returns an empty list for an empty input", () => {
    expect(dedupeOpenitByName([])).toEqual([]);
  });

  it("preserves description from the winning row", () => {
    const result = dedupeOpenitByName([
      row({ id: "1", name: "openit-library", description: "winner" }),
      row({ id: "2", name: "openit-library", description: "loser" }),
    ]);
    expect(result[0].description).toBe("winner");
  });

  it("converges to one collection when concurrent creates produce true duplicates", () => {
    // Two concurrent startFilestoreSync calls both see an empty list,
    // both POST to create openit-library, both succeed with different
    // ids. The post-create refetch sees both and dedupe picks the
    // lex-smallest id, so every caller converges on the same one.
    const result = dedupeOpenitByName([
      row({ id: "second-create-999", name: "openit-library" }),
      row({ id: "first-create-111", name: "openit-library" }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("first-create-111");
  });

  it("filters mixed remote collections correctly", () => {
    // User has unrelated collections plus an openit-* one. Sync only
    // sees the openit-* entries; the user's `customer-data` is never
    // touched.
    const result = dedupeOpenitByName([
      row({ id: "1", name: "customer-data" }),
      row({ id: "2", name: "openit-library" }),
      row({ id: "3", name: "my-docs" }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("openit-library");
  });
});
