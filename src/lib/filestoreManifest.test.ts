// Race regression: pre-fix, two concurrent saveCollectionManifest calls on
// the same repo both read the same root snapshot, each updated only its
// own slot, and the second write silently dropped the first. The
// per-repo Promise-chain mutex serializes the read-modify-write so both
// slots survive.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { KbStatePersisted } from "./api";

vi.mock("./api", () => {
  let store: KbStatePersisted | null = null;
  return {
    fsStoreStateLoad: vi.fn(async () => {
      // Simulate a slow read so concurrent callers actually overlap if not
      // serialized. Without a delay the JS event loop runs both calls'
      // sync portions before either yields, and the race is hidden.
      await new Promise((r) => setTimeout(r, 5));
      if (!store) throw new Error("not found");
      return JSON.parse(JSON.stringify(store)) as KbStatePersisted;
    }),
    fsStoreStateSave: vi.fn(async (_repo: string, value: KbStatePersisted) => {
      store = JSON.parse(JSON.stringify(value));
    }),
    __reset: () => {
      store = null;
    },
  };
});

import { saveCollectionManifest, loadCollectionManifest } from "./filestoreManifest";

describe("filestoreManifest concurrent saves", () => {
  beforeEach(async () => {
    const api = await import("./api");
    (api as unknown as { __reset: () => void }).__reset();
  });

  it("two concurrent saves on the same repo both land in the root manifest", async () => {
    const repo = "/tmp/openit-test-race";
    const baseManifest = (id: string): KbStatePersisted => ({
      collection_id: id,
      collection_name: `openit-${id}`,
      files: { [`${id}.txt`]: { remote_version: "v1", pulled_at_mtime_ms: 1 } },
    });

    await Promise.all([
      saveCollectionManifest(repo, "library", "openit-library", baseManifest("library")),
      saveCollectionManifest(repo, "attachments", "openit-attachments", baseManifest("attachments")),
    ]);

    // Both collection slots should be present.
    const lib = await loadCollectionManifest(repo, "library");
    const att = await loadCollectionManifest(repo, "attachments");
    expect(lib.files["library.txt"]).toBeDefined();
    expect(att.files["attachments.txt"]).toBeDefined();
  });
});
