// Unit tests for the shared nested-manifest module. Cover all three
// entity names (`fs`, `kb`, `datastore`) so a regression in one doesn't
// slip through via another. Concurrent-save serialisation is covered too
// — same race that the predecessor `filestoreManifest.test.ts` guarded
// against, now via the per-(repo, entity) lock in nestedManifest.ts.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { KbStatePersisted } from "./api";

vi.mock("./api", () => {
  let fsStore: KbStatePersisted | null = null;
  let kbStore: KbStatePersisted | null = null;
  let dsStore: KbStatePersisted | null = null;
  return {
    fsStoreStateLoad: vi.fn(async () => {
      // Simulate a slow read so concurrent callers actually overlap if
      // not serialised. Without a delay the JS event loop runs both
      // calls' sync portions before either yields, and the race is
      // hidden.
      await new Promise((r) => setTimeout(r, 5));
      if (!fsStore) throw new Error("not found");
      return JSON.parse(JSON.stringify(fsStore)) as KbStatePersisted;
    }),
    fsStoreStateSave: vi.fn(async (_repo: string, value: KbStatePersisted) => {
      fsStore = JSON.parse(JSON.stringify(value));
    }),
    kbStateLoad: vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      if (!kbStore) throw new Error("not found");
      return JSON.parse(JSON.stringify(kbStore)) as KbStatePersisted;
    }),
    kbStateSave: vi.fn(async (_repo: string, value: KbStatePersisted) => {
      kbStore = JSON.parse(JSON.stringify(value));
    }),
    datastoreStateLoad: vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      if (!dsStore) throw new Error("not found");
      return JSON.parse(JSON.stringify(dsStore)) as KbStatePersisted;
    }),
    datastoreStateSave: vi.fn(async (_repo: string, value: KbStatePersisted) => {
      dsStore = JSON.parse(JSON.stringify(value));
    }),
    __reset: () => {
      fsStore = null;
      kbStore = null;
      dsStore = null;
    },
  };
});

import { loadCollectionManifest, saveCollectionManifest } from "./nestedManifest";

beforeEach(async () => {
  const api = await import("./api");
  (api as unknown as { __reset: () => void }).__reset();
});

const baseManifest = (id: string): KbStatePersisted => ({
  collection_id: id,
  collection_name: `openit-${id}`,
  files: { [`${id}.txt`]: { remote_version: "v1", pulled_at_mtime_ms: 1 } },
});

describe("nestedManifest concurrent saves (fs)", () => {
  it("two concurrent saves on the same repo both land in the root manifest", async () => {
    const repo = "/tmp/openit-test-race-fs";
    await Promise.all([
      saveCollectionManifest(repo, "fs", "library", "openit-library", baseManifest("library")),
      saveCollectionManifest(repo, "fs", "attachments", "openit-attachments", baseManifest("attachments")),
    ]);

    const lib = await loadCollectionManifest(repo, "fs", "library");
    const att = await loadCollectionManifest(repo, "fs", "attachments");
    expect(lib.files["library.txt"]).toBeDefined();
    expect(att.files["attachments.txt"]).toBeDefined();
  });
});

describe("nestedManifest concurrent saves (kb)", () => {
  it("kb backend serialises through its own lock independent of fs", async () => {
    const repo = "/tmp/openit-test-race-kb";
    await Promise.all([
      saveCollectionManifest(repo, "kb", "default", "openit-default", baseManifest("default")),
      saveCollectionManifest(repo, "kb", "runbooks", "openit-runbooks", baseManifest("runbooks")),
    ]);

    const def = await loadCollectionManifest(repo, "kb", "default");
    const runb = await loadCollectionManifest(repo, "kb", "runbooks");
    expect(def.files["default.txt"]).toBeDefined();
    expect(runb.files["runbooks.txt"]).toBeDefined();
  });

  it("fs and kb stores are isolated — saving on one entity doesn't leak into the other", async () => {
    const repo = "/tmp/openit-test-isolation";
    await saveCollectionManifest(repo, "fs", "x", "openit-x", baseManifest("x"));
    // The kb-side load should NOT see the fs save.
    const kbX = await loadCollectionManifest(repo, "kb", "x");
    expect(kbX.files).toEqual({});
  });
});

describe("nestedManifest concurrent saves (datastore)", () => {
  it("datastore backend serialises through its own lock independent of fs/kb", async () => {
    const repo = "/tmp/openit-test-race-datastore";
    await Promise.all([
      saveCollectionManifest(repo, "datastore", "tickets", "openit-tickets", baseManifest("tickets")),
      saveCollectionManifest(repo, "datastore", "people", "openit-people", baseManifest("people")),
    ]);

    const tickets = await loadCollectionManifest(repo, "datastore", "tickets");
    const people = await loadCollectionManifest(repo, "datastore", "people");
    expect(tickets.files["tickets.txt"]).toBeDefined();
    expect(people.files["people.txt"]).toBeDefined();
  });

  it("datastore stays isolated from fs and kb stores", async () => {
    const repo = "/tmp/openit-test-isolation-ds";
    await saveCollectionManifest(repo, "datastore", "x", "openit-x", baseManifest("x"));
    const fsX = await loadCollectionManifest(repo, "fs", "x");
    const kbX = await loadCollectionManifest(repo, "kb", "x");
    expect(fsX.files).toEqual({});
    expect(kbX.files).toEqual({});
  });
});

describe("nestedManifest legacy migration", () => {
  it("treats flat-format payload as missing — returns default for the requested collection", async () => {
    const repo = "/tmp/openit-test-legacy";
    const api = await import("./api");
    // Simulate an on-disk flat manifest from before the nested rewrite.
    await (
      api as unknown as { fsStoreStateSave: (r: string, v: KbStatePersisted) => Promise<void> }
    ).fsStoreStateSave(repo, {
      collection_id: "legacy-id",
      collection_name: "openit-legacy",
      files: { "old.md": { remote_version: "v0", pulled_at_mtime_ms: 1 } },
    });

    const out = await loadCollectionManifest(repo, "fs", "col-1");
    expect(out).toEqual({ collection_id: "col-1", collection_name: "", files: {} });
  });
});
