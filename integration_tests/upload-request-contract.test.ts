/**
 * Regression contract for the signed-URL upload path (PIN-5847).
 *
 * The pre-PIN-5847 multipart `/filestorage/items/upload` endpoint
 * rewrote uploaded filenames with a UUID prefix and created a new
 * Firestore doc on every call, so a same-name re-push accumulated
 * duplicates server- and (after pull) client-side. Filestore push is
 * now `POST /filestorage/items/upload-request` + signed GCS PUT, which
 * preserves the verbatim sanitized filename and dedupes by
 * `filename + collectionId`.
 *
 * This file pins both halves of that contract:
 *   1. Server returns the same filename it was sent (only `formatFileName`
 *      sanitization, no UUID prefix).
 *   2. Three same-name uploads in a row leave the collection's list
 *      count at baseline + 1 — the row is overwritten in place, not
 *      duplicated.
 *
 * The pre-PIN-5847 multipart pathology (3 uploads → 3 UUID-prefixed
 * rows) is captured in the PIN-5847 plan doc rather than re-asserted
 * here. KB push still uses multipart `/upload` (vector-store indexing
 * lives only on that path); the multipart UUID-prefix issue is tracked
 * separately as a server-side fix.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { loadConfig } from "./utils/config";
import { PinkfishClient, type DataCollection } from "./utils/pinkfish-api";

const config = loadConfig();
const skip = !config;

describe.skipIf(skip)("upload-request signed-URL contract (PIN-5847)", () => {
  let client: PinkfishClient;
  let target: DataCollection;

  beforeAll(async () => {
    if (!config) return;
    client = new PinkfishClient(config);
    const all = await client.listCollections("filestorage");
    // Prefer openit-* if present, otherwise just use the first writable
    // one — the contract is collection-agnostic.
    const found =
      all.find((c) => c.name === "openit-library") ??
      all.find((c) => c.name.startsWith("openit-")) ??
      all.find((c) => c.name === "automatedFS") ??
      all[0];
    if (!found) throw new Error("no filestorage collection available for tests");
    target = found;
  });

  it("returns the filename verbatim (no UUID prefix)", async () => {
    const filename = `pin-5847-clean-name-${Date.now()}.mjs`;
    const contents = new TextEncoder().encode("console.log('clean');\n");

    const result = await client.uploadFilestoreFileSigned({
      collectionId: target.id,
      filename,
      bytes: contents,
      mime: "text/javascript",
    });

    // Our test filename has no characters that need sanitizing, so it
    // must round-trip verbatim. (formatFileName collapses spaces and
    // special chars to hyphens; an already-clean name stays put.)
    expect(result.filename).toBe(filename);
    // Loud failure if the server starts adding UUIDs on this path.
    expect(result.filename).not.toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/,
    );
    expect(result.id).toBeTruthy();

    await client.deleteFilestoreItem(result.id);
  });

  it("re-uploading the same name overwrites in place (no duplicate rows)", async () => {
    const filename = `pin-5847-overwrite-${Date.now()}.mjs`;

    // Snapshot the list so we can assert net delta = 1, regardless of
    // whatever else lives in the collection.
    const baseline = await client.listFilestoreItems(target.id);
    const baselineCount = baseline.length;

    const ids: string[] = [];
    for (let i = 1; i <= 3; i += 1) {
      const contents = new TextEncoder().encode(
        `console.log('iteration ${i}');\n`,
      );
      const result = await client.uploadFilestoreFileSigned({
        collectionId: target.id,
        filename,
        bytes: contents,
        mime: "text/javascript",
      });
      ids.push(result.id);
      // Server sanitization is deterministic on a clean input — every
      // upload returns the same filename.
      expect(result.filename).toBe(filename);
    }

    // Firestore dedupe-by-filename means all three uploads map to the
    // same row id. If this drifts (server changes), we want a loud
    // failure here.
    expect(new Set(ids).size).toBe(1);

    const after = await client.listFilestoreItems(target.id);
    const matchingRows = after.filter(
      (f) => (f as unknown as { filename?: string }).filename === filename,
    );
    expect(matchingRows).toHaveLength(1);
    expect(after.length).toBe(baselineCount + 1);

    if (ids[0]) await client.deleteFilestoreItem(ids[0]);
  });
});
