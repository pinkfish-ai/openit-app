// Pure-helper tests for the KB resolver module — Phase 2 of V2 sync
// (PIN-5775). Mirror of the helper-only tests in filestoreSync.test.ts.
// The networked behaviour (resolveCollections via the engine) is
// exercised end-to-end by the integration tests; mocking
// `makeSkillsFetch` here would mostly assert on the mock.

import { describe, expect, it } from "vitest";
import { OPENIT_KB_PREFIX, displayKbName } from "./kb";

describe("OPENIT_KB_PREFIX", () => {
  it("is the literal `openit-` (mirrors filestore prefix)", () => {
    expect(OPENIT_KB_PREFIX).toBe("openit-");
  });
});

describe("displayKbName", () => {
  it("strips the openit- prefix when present", () => {
    expect(displayKbName("openit-default")).toBe("default");
    expect(displayKbName("openit-runbooks")).toBe("runbooks");
  });

  it("returns the input unchanged when the prefix is absent", () => {
    expect(displayKbName("default")).toBe("default");
    expect(displayKbName("customer-knowledge")).toBe("customer-knowledge");
  });

  it("handles the prefix as the entire name (degenerate but defined)", () => {
    expect(displayKbName("openit-")).toBe("");
  });
});
