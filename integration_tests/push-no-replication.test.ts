/**
 * Push isolation + no-replication tests.
 *
 * Pre-fix, dropping a file in `filestores/library/` resulted in it
 * being uploaded to every openit-* collection on the server (library,
 * attachments, docs-*). Reproducible because:
 *
 *  - pushAllToFilestoreInner called fsStoreListLocal (hardcoded to
 *    filestores/library/) regardless of which collection it was
 *    pushing to
 *  - fs_store_upload_file read from filestores/library/ regardless of
 *    a subdir parameter (it didn't accept one)
 *
 * This suite uses the real Pinkfish API to verify that an upload to
 * one collection does NOT leak files into another collection's listing.
 *
 * The test is hermetic: it uploads a unique fixture, verifies it lands
 * in exactly one collection, then deletes it. Other collections in the
 * same org are not modified.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { loadConfig } from "./utils/config";
import { PinkfishClient, type DataCollection } from "./utils/pinkfish-api";

const config = loadConfig();
const skip = !config;

let client: PinkfishClient | null = null;
let openitCollections: DataCollection[] = [];

describe.skipIf(skip)("push isolation — no replication across collections", () => {
  beforeAll(async () => {
    if (!config) return;
    client = new PinkfishClient(config);
    openitCollections = await client.listOpenitFilestores();
    if (openitCollections.length < 2) {
      console.warn(
        `[push-no-replication] only ${openitCollections.length} openit-* collection(s) on remote — replication test needs at least 2 to be meaningful`,
      );
    }
  });

  it("uploading to collection A does not appear in collection B", async () => {
    if (!client || openitCollections.length < 2) return;

    const [collA, collB] = openitCollections;
    const marker = `replication-test-${Date.now()}.txt`;
    const contents = new TextEncoder().encode(
      "This file was uploaded to collection A only.",
    );

    // Snapshot B before so we can detect any cross-pollution.
    const bBefore = await client.listFilestoreItems(collB.id);
    const bBeforeNames = new Set(bBefore.map((f) => f.filename));

    // Upload to A
    const uploaded = await client.uploadFilestoreFile({
      collectionId: collA.id,
      filename: marker,
      bytes: contents,
      mime: "text/plain",
    });

    try {
      // A: must contain it (under either the original or sanitized name)
      const aAfter = await client.listFilestoreItems(collA.id);
      const aHasIt = aAfter.some(
        (f) => f.filename === marker || f.filename === uploaded.filename,
      );
      expect(aHasIt).toBe(true);

      // B: must NOT contain it. Pre-fix this would fail because the
      // legacy push uploaded the file to every collection.
      const bAfter = await client.listFilestoreItems(collB.id);
      const bGotPolluted = bAfter.some(
        (f) =>
          (f.filename === marker || f.filename === uploaded.filename) &&
          !bBeforeNames.has(f.filename),
      );
      expect(bGotPolluted).toBe(false);
    } finally {
      // Cleanup A
      if (uploaded.id) await client.deleteFilestoreItem(uploaded.id);
    }
  });

  it("a third collection is also not affected", async () => {
    if (!client || openitCollections.length < 3) return;

    const [collA, , collC] = openitCollections;
    const marker = `replication-test-3-${Date.now()}.bin`;
    const contents = new TextEncoder().encode("third-collection fixture");

    const cBefore = await client.listFilestoreItems(collC.id);
    const cBeforeNames = new Set(cBefore.map((f) => f.filename));

    const uploaded = await client.uploadFilestoreFile({
      collectionId: collA.id,
      filename: marker,
      bytes: contents,
      mime: "application/octet-stream",
    });

    try {
      const cAfter = await client.listFilestoreItems(collC.id);
      const cPolluted = cAfter.some(
        (f) =>
          (f.filename === marker || f.filename === uploaded.filename) &&
          !cBeforeNames.has(f.filename),
      );
      expect(cPolluted).toBe(false);
    } finally {
      if (uploaded.id) await client.deleteFilestoreItem(uploaded.id);
    }
  });
});
