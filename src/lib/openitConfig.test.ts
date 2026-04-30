// Pure-helper tests for the partial-override merge. The on-disk
// load path delegates to `mergeOpenitConfig` once it has parsed JSON,
// so the merge is the only logic worth pinning. The fs-read leg lives
// in `api.ts` and is exercised end-to-end via the running Tauri app.

import { describe, it, expect } from "vitest";
import {
  DEFAULT_TICKET_LIFECYCLE,
  mergeOpenitConfig,
} from "./openitConfig";

describe("mergeOpenitConfig", () => {
  it("returns defaults for null / undefined / non-object input", () => {
    expect(mergeOpenitConfig(null).ticketLifecycle).toEqual(DEFAULT_TICKET_LIFECYCLE);
    expect(mergeOpenitConfig(undefined).ticketLifecycle).toEqual(DEFAULT_TICKET_LIFECYCLE);
    expect(mergeOpenitConfig("not an object").ticketLifecycle).toEqual(DEFAULT_TICKET_LIFECYCLE);
    expect(mergeOpenitConfig(42).ticketLifecycle).toEqual(DEFAULT_TICKET_LIFECYCLE);
  });

  it("returns defaults when ticketLifecycle is absent", () => {
    expect(mergeOpenitConfig({}).ticketLifecycle).toEqual(DEFAULT_TICKET_LIFECYCLE);
    expect(mergeOpenitConfig({ otherKey: 1 }).ticketLifecycle).toEqual(DEFAULT_TICKET_LIFECYCLE);
  });

  it("applies a full override", () => {
    const cfg = mergeOpenitConfig({
      ticketLifecycle: {
        autoCloseResolvedAfterHours: 48,
        autoEscalateOpenAfterHours: 12,
        escalateOnAdminReply: false,
        escalateOnAgentCrash: false,
      },
    });
    expect(cfg.ticketLifecycle.autoCloseResolvedAfterHours).toBe(48);
    expect(cfg.ticketLifecycle.autoEscalateOpenAfterHours).toBe(12);
    expect(cfg.ticketLifecycle.escalateOnAdminReply).toBe(false);
    expect(cfg.ticketLifecycle.escalateOnAgentCrash).toBe(false);
  });

  it("merges a partial override with defaults", () => {
    const cfg = mergeOpenitConfig({
      ticketLifecycle: { escalateOnAdminReply: false },
    });
    // Overridden:
    expect(cfg.ticketLifecycle.escalateOnAdminReply).toBe(false);
    // Defaulted:
    expect(cfg.ticketLifecycle.autoCloseResolvedAfterHours).toBe(24);
    expect(cfg.ticketLifecycle.autoEscalateOpenAfterHours).toBe(24);
    expect(cfg.ticketLifecycle.escalateOnAgentCrash).toBe(true);
  });

  it("treats 0 as a valid disable value for hour fields", () => {
    const cfg = mergeOpenitConfig({
      ticketLifecycle: {
        autoCloseResolvedAfterHours: 0,
        autoEscalateOpenAfterHours: 0,
      },
    });
    expect(cfg.ticketLifecycle.autoCloseResolvedAfterHours).toBe(0);
    expect(cfg.ticketLifecycle.autoEscalateOpenAfterHours).toBe(0);
  });

  it("clamps negative hour values to 0 (defensive — admin typo shouldn't break the walker)", () => {
    const cfg = mergeOpenitConfig({
      ticketLifecycle: { autoCloseResolvedAfterHours: -5 },
    });
    expect(cfg.ticketLifecycle.autoCloseResolvedAfterHours).toBe(0);
  });

  it("ignores wrong-typed fields and falls through to defaults", () => {
    const cfg = mergeOpenitConfig({
      ticketLifecycle: {
        autoCloseResolvedAfterHours: "24" as unknown as number, // string, not number
        escalateOnAdminReply: "yes" as unknown as boolean, // string, not boolean
      },
    });
    expect(cfg.ticketLifecycle.autoCloseResolvedAfterHours).toBe(24); // default kept
    expect(cfg.ticketLifecycle.escalateOnAdminReply).toBe(true); // default kept
  });

  it("does not share state between calls (defaults are not mutated)", () => {
    const a = mergeOpenitConfig({
      ticketLifecycle: { autoCloseResolvedAfterHours: 48 },
    });
    const b = mergeOpenitConfig({});
    expect(a.ticketLifecycle.autoCloseResolvedAfterHours).toBe(48);
    expect(b.ticketLifecycle.autoCloseResolvedAfterHours).toBe(24); // pristine
    expect(DEFAULT_TICKET_LIFECYCLE.autoCloseResolvedAfterHours).toBe(24);
  });
});
