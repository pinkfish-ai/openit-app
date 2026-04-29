/**
 * Adapter routing tests.
 *
 * Verifies the filestore adapter wires correct subdir/path/manifest plumbing
 * for every collection. These were the four bugs that combined to break
 * multi-collection sync:
 *
 * 1. listLocal hardcoded to filestores/library
 *    → every collection saw library files, engine thought files were
 *      already on disk and skipped downloads
 * 2. fsStoreDownloadToLocal didn't accept subdir
 *    → backend wrote everything to filestores/library (or failed with
 *      "filename must not contain path separators" if we tried full paths)
 * 3. fs_store_upload_file read from filestores/library only
 *    → push iterated every collection from the same library dir,
 *      replicating files across all openit-* collections
 * 4. Sync engine had no `tracked && !localFile` branch
 *    → once a stale manifest entry existed (from a failed sync),
 *      the file would never re-download
 *
 * These tests pin the fix shape in unit-style detail. The real-API
 * counterpart is in filestore-sync.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { filestoreAdapter } from "../src/lib/entities/filestore";
import * as api from "../src/lib/api";

vi.mock("../src/lib/api", () => ({
  entityDeleteFile: vi.fn(),
  fsStoreDownloadToLocal: vi.fn(),
  fsStoreListLocal: vi.fn(),
  entityListLocal: vi.fn().mockResolvedValue([]),
  kbListRemote: vi.fn(),
  entityWriteFile: vi.fn(),
}));

vi.mock("../src/lib/pinkfishAuth", () => ({
  getToken: () => ({
    accessToken: "test-token",
    expiresAt: Date.now() + 3600000,
    orgId: "test-org",
  }),
  derivedUrls: () => ({
    skillsBaseUrl: "https://skills-stage.pinkfish.ai",
  }),
}));

const TEST_CREDS = {
  orgId: "test-org",
  tokenUrl: "https://app-api.dev20.pinkfish.dev/oauth/token",
  clientId: "test-client",
  clientSecret: "test-secret",
};

function remoteFile(filename: string, signedUrl = "https://download/test"): any {
  return {
    id: `id-${filename}`,
    filename,
    signed_url: signedUrl,
    updated_at: "2026-04-29T00:00:00Z",
    file_size: 100,
    mime_type: "application/octet-stream",
  };
}

describe("filestoreAdapter — routing", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("workingTreePath calculation", () => {
    const cases: Array<[string, string]> = [
      ["openit-library", "filestores/library"],
      ["openit-attachments", "filestores/attachments"],
      ["openit-docs-653713545258", "filestores/docs-653713545258"],
      ["openit-custom-name", "filestores/custom-name"],
      // Non-openit fallback (Phase 2)
      ["my-other-collection", "filestores/my-other-collection"],
    ];

    for (const [collectionName, expectedDir] of cases) {
      it(`${collectionName} → ${expectedDir}`, async () => {
        const adapter = filestoreAdapter({
          creds: TEST_CREDS,
          collection: { id: "x", name: collectionName },
        });
        vi.mocked(api.kbListRemote).mockResolvedValue([
          remoteFile("doc.txt"),
        ]);
        const r = await adapter.listRemote("/repo");
        expect(r.items[0].workingTreePath).toBe(`${expectedDir}/doc.txt`);
        expect(adapter.prefix).toBe(expectedDir);
      });
    }
  });

  describe("listLocal isolation per collection", () => {
    it("uses entityListLocal with collection-specific subdir", async () => {
      const adapter = filestoreAdapter({
        creds: TEST_CREDS,
        collection: { id: "x", name: "openit-docs-abc" },
      });
      await adapter.listLocal("/repo");
      expect(api.entityListLocal).toHaveBeenCalledWith(
        "/repo",
        "filestores/docs-abc",
      );
      // Critical: must NOT use the legacy hardcoded fsStoreListLocal,
      // which always lists from filestores/library/.
      expect(api.fsStoreListLocal).not.toHaveBeenCalled();
    });

    it("two collections with overlapping filenames don't see each other", async () => {
      const docAdapter = filestoreAdapter({
        creds: TEST_CREDS,
        collection: { id: "1", name: "openit-docs-1" },
      });
      const attachAdapter = filestoreAdapter({
        creds: TEST_CREDS,
        collection: { id: "2", name: "openit-attachments" },
      });

      // entityListLocal returns DIFFERENT files based on the subdir
      // argument — simulating a real filesystem where each collection
      // folder has its own files.
      vi.mocked(api.entityListLocal).mockImplementation(
        async (_repo: string, subdir: string) => {
          if (subdir === "filestores/docs-1") {
            return [{ filename: "shared.txt", mtime_ms: 1000, size: 10 }];
          }
          if (subdir === "filestores/attachments") {
            return [{ filename: "shared.txt", mtime_ms: 2000, size: 20 }];
          }
          return [];
        },
      );

      const docLocal = await docAdapter.listLocal("/repo");
      const attachLocal = await attachAdapter.listLocal("/repo");

      // Each adapter sees ONLY its collection's file.
      expect(docLocal[0].workingTreePath).toBe("filestores/docs-1/shared.txt");
      expect(docLocal[0].mtime_ms).toBe(1000);
      expect(attachLocal[0].workingTreePath).toBe(
        "filestores/attachments/shared.txt",
      );
      expect(attachLocal[0].mtime_ms).toBe(2000);
    });
  });

  describe("fetchAndWrite — directory creation + subdir parameter", () => {
    it("ensures parent directory exists before downloading", async () => {
      const adapter = filestoreAdapter({
        creds: TEST_CREDS,
        collection: { id: "x", name: "openit-docs-newcoll" },
      });
      vi.mocked(api.kbListRemote).mockResolvedValue([remoteFile("doc.pdf")]);
      vi.mocked(api.entityWriteFile).mockResolvedValue(undefined);
      vi.mocked(api.entityDeleteFile).mockResolvedValue(undefined);
      vi.mocked(api.fsStoreDownloadToLocal).mockResolvedValue(undefined);

      const items = (await adapter.listRemote("/repo")).items;
      await items[0].fetchAndWrite("/repo");

      // 1. placeholder write to materialize the directory
      expect(api.entityWriteFile).toHaveBeenCalledWith(
        "/repo",
        "filestores/docs-newcoll",
        ".placeholder",
        "",
      );
      // 2. delete the placeholder (it's not data)
      expect(api.entityDeleteFile).toHaveBeenCalledWith(
        "/repo",
        "filestores/docs-newcoll",
        ".placeholder",
      );
      // 3. download with explicit subdir → backend creates remaining
      // parents and writes the bytes there
      expect(api.fsStoreDownloadToLocal).toHaveBeenCalledWith(
        "/repo",
        "doc.pdf",
        "https://download/test",
        "filestores/docs-newcoll",
      );
    });

    it("download proceeds even if placeholder write fails", async () => {
      const adapter = filestoreAdapter({
        creds: TEST_CREDS,
        collection: { id: "x", name: "openit-library" },
      });
      vi.mocked(api.kbListRemote).mockResolvedValue([remoteFile("a.md")]);
      vi.mocked(api.entityWriteFile).mockRejectedValue(new Error("EACCES"));
      vi.mocked(api.fsStoreDownloadToLocal).mockResolvedValue(undefined);

      const items = (await adapter.listRemote("/repo")).items;
      await expect(items[0].fetchAndWrite("/repo")).resolves.not.toThrow();
      expect(api.fsStoreDownloadToLocal).toHaveBeenCalled();
    });
  });

  describe("writeShadow — same subdir, shadow filename", () => {
    it("writes shadow to the collection's subdir, not library", async () => {
      const adapter = filestoreAdapter({
        creds: TEST_CREDS,
        collection: { id: "x", name: "openit-docs-shadow" },
      });
      vi.mocked(api.kbListRemote).mockResolvedValue([
        remoteFile("conflict.md"),
      ]);
      vi.mocked(api.entityWriteFile).mockResolvedValue(undefined);
      vi.mocked(api.entityDeleteFile).mockResolvedValue(undefined);
      vi.mocked(api.fsStoreDownloadToLocal).mockResolvedValue(undefined);

      const items = (await adapter.listRemote("/repo")).items;
      await items[0].writeShadow("/repo");

      expect(api.fsStoreDownloadToLocal).toHaveBeenCalledWith(
        "/repo",
        "conflict.server.md",
        "https://download/test",
        "filestores/docs-shadow",
      );
    });
  });

  describe("listRemote with malformed responses", () => {
    it("skips items missing filename", async () => {
      const adapter = filestoreAdapter({
        creds: TEST_CREDS,
        collection: { id: "x", name: "openit-library" },
      });
      vi.mocked(api.kbListRemote).mockResolvedValue([
        remoteFile("ok.txt"),
        // @ts-expect-error - simulating bad server data
        { filename: null, signed_url: "x" },
        // @ts-expect-error - simulating bad server data
        { filename: "no-url.txt", signed_url: "" },
      ]);

      const r = await adapter.listRemote("/repo");
      expect(r.items).toHaveLength(1);
      expect(r.items[0].manifestKey).toBe("ok.txt");
    });

    it("returns empty when remote has zero files", async () => {
      const adapter = filestoreAdapter({
        creds: TEST_CREDS,
        collection: { id: "x", name: "openit-attachments" },
      });
      vi.mocked(api.kbListRemote).mockResolvedValue([]);
      const r = await adapter.listRemote("/repo");
      expect(r.items).toHaveLength(0);
      expect(r.paginationFailed).toBe(false);
    });
  });

  describe("listLocal — shadow classification", () => {
    it("classifies foo.server.md as a shadow when foo.md sibling exists", async () => {
      const adapter = filestoreAdapter({
        creds: TEST_CREDS,
        collection: { id: "x", name: "openit-library" },
      });
      vi.mocked(api.entityListLocal).mockResolvedValue([
        { filename: "foo.md", mtime_ms: 1000, size: 10 },
        { filename: "foo.server.md", mtime_ms: 2000, size: 11 },
      ]);
      const local = await adapter.listLocal("/repo");
      const shadow = local.find((l) => l.workingTreePath.endsWith("foo.server.md"));
      const canonical = local.find((l) => l.workingTreePath.endsWith("foo.md") && !l.isShadow);
      expect(shadow?.isShadow).toBe(true);
      // Shadow's manifestKey points back to the canonical name
      expect(shadow?.manifestKey).toBe("foo.md");
      expect(canonical?.isShadow).toBe(false);
    });

    it("does NOT classify a.server.conf as shadow when a.conf is absent", async () => {
      const adapter = filestoreAdapter({
        creds: TEST_CREDS,
        collection: { id: "x", name: "openit-library" },
      });
      vi.mocked(api.entityListLocal).mockResolvedValue([
        { filename: "a.server.conf", mtime_ms: 1000, size: 10 },
      ]);
      const local = await adapter.listLocal("/repo");
      expect(local[0].isShadow).toBe(false);
      expect(local[0].manifestKey).toBe("a.server.conf");
    });
  });
});
