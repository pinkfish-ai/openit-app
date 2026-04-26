// Smoke tests for the sync-resolve-conflict.mjs script. Spawns the
// script via `node` against a tempdir and asserts the manifest is
// mutated correctly. Lives next to the script so it travels with it
// when the script eventually moves to /web.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const execFileAsync = promisify(execFile);
const SCRIPT = path.resolve(__dirname, "sync-resolve-conflict.mjs");

let tmpDir = "";

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "openit-script-test-"));
  await mkdir(path.join(tmpDir, ".openit"), { recursive: true });
});

afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

async function runScript(args: string[]) {
  return execFileAsync("node", [SCRIPT, ...args], { cwd: tmpDir });
}

async function readManifest(name: string): Promise<{
  files: Record<string, unknown>;
}> {
  const raw = await readFile(path.join(tmpDir, ".openit", `${name}-state.json`), "utf8");
  return JSON.parse(raw);
}

describe("sync-resolve-conflict.mjs", () => {
  it("force-push: rewrites the entry using conflict_remote_version", async () => {
    // Engine flagged this row as conflicted and recorded the
    // current remote_version on the entry. Resolve script should
    // replace remote_version with that captured value and set
    // pulled_at_mtime_ms=1 so the next push sees localChanged=true.
    await writeFile(
      path.join(tmpDir, ".openit", "datastore-state.json"),
      JSON.stringify({
        collection_id: null,
        collection_name: null,
        files: {
          "openit-people/row-A": {
            remote_version: "v1-pre-conflict",
            pulled_at_mtime_ms: 1000,
            conflict_remote_version: "v2-at-conflict-time",
          },
          "openit-people/row-B": { remote_version: "v2", pulled_at_mtime_ms: 2000 },
        },
      }),
    );

    const { stdout } = await runScript([
      "--prefix",
      "datastore",
      "--key",
      "openit-people/row-A",
    ]);
    const result = JSON.parse(stdout.trim());
    expect(result).toMatchObject({
      ok: true,
      prefix: "datastore",
      key: "openit-people/row-A",
      action: "force-push",
      // No shadow on disk in this test, so cleanup should report false.
      shadowRemoved: false,
    });

    const manifest = await readManifest("datastore");
    expect(manifest.files["openit-people/row-A"]).toEqual({
      remote_version: "v2-at-conflict-time",
      pulled_at_mtime_ms: 1,
    });
    // Sibling row-B preserved unchanged.
    expect(manifest.files["openit-people/row-B"]).toEqual({
      remote_version: "v2",
      pulled_at_mtime_ms: 2000,
    });
  });

  it("defensively removes a leftover .server. shadow file (Claude skipped step 3)", async () => {
    // The conflict prompt instructs Claude to delete the shadow before
    // running this script. Claude has been observed to skip that step,
    // leaving the shadow on disk and the explorer's "shadow next to
    // canonical" detection lit up. This test pins the script's
    // defensive cleanup.
    await writeFile(
      path.join(tmpDir, ".openit", "datastore-state.json"),
      JSON.stringify({
        collection_id: null,
        collection_name: null,
        files: {
          "openit-people/row-A": {
            remote_version: "v0",
            pulled_at_mtime_ms: 1000,
            conflict_remote_version: "v1",
          },
        },
      }),
    );
    // Plant the merged canonical + the leftover shadow.
    await mkdir(path.join(tmpDir, "databases", "openit-people"), { recursive: true });
    await writeFile(
      path.join(tmpDir, "databases", "openit-people", "row-A.json"),
      '{"f_1":"merged"}',
    );
    const shadowPath = path.join(tmpDir, "databases", "openit-people", "row-A.server.json");
    await writeFile(shadowPath, '{"f_1":"remote"}');

    const { stdout } = await runScript([
      "--prefix",
      "datastore",
      "--key",
      "openit-people/row-A",
    ]);
    const result = JSON.parse(stdout.trim());
    expect(result.action).toBe("force-push");
    expect(result.shadowRemoved).toBe(true);

    // Shadow gone from disk.
    const { existsSync: exists } = await import("node:fs");
    expect(exists(shadowPath)).toBe(false);
  });

  it("force-push: handles empty-string conflict_remote_version (adapter normalized missing updatedAt)", async () => {
    // Regression test for the truthy-check bug: KB / filestore /
    // datastore / agent / workflow adapters all normalize a missing
    // remote `updatedAt` to "" before passing it to the engine. The
    // engine writes that "" into `conflict_remote_version` faithfully.
    // A truthy check (`if (entry.conflict_remote_version) …`) would
    // fall through to the legacy delete-entry path, which the next
    // pull's bootstrap-adopt would re-conflict if the user picked
    // LOCAL. A typeof check correctly takes the force-push path.
    await writeFile(
      path.join(tmpDir, ".openit", "datastore-state.json"),
      JSON.stringify({
        collection_id: null,
        collection_name: null,
        files: {
          "openit-people/row-A": {
            remote_version: "v1-pre-conflict",
            pulled_at_mtime_ms: 1000,
            conflict_remote_version: "",
          },
        },
      }),
    );

    const { stdout } = await runScript([
      "--prefix",
      "datastore",
      "--key",
      "openit-people/row-A",
    ]);
    const result = JSON.parse(stdout.trim());
    expect(result.action).toBe("force-push");

    const manifest = await readManifest("datastore");
    expect(manifest.files["openit-people/row-A"]).toEqual({
      remote_version: "",
      pulled_at_mtime_ms: 1,
    });
  });

  it("legacy: deletes the entry when no conflict_remote_version is present", async () => {
    await writeFile(
      path.join(tmpDir, ".openit", "datastore-state.json"),
      JSON.stringify({
        collection_id: null,
        collection_name: null,
        files: {
          "openit-people/row-A": { remote_version: "v1", pulled_at_mtime_ms: 1000 },
        },
      }),
    );

    const { stdout } = await runScript([
      "--prefix",
      "datastore",
      "--key",
      "openit-people/row-A",
    ]);
    const result = JSON.parse(stdout.trim());
    expect(result).toMatchObject({
      ok: true,
      prefix: "datastore",
      key: "openit-people/row-A",
      action: "deleted",
    });

    const manifest = await readManifest("datastore");
    expect(manifest.files["openit-people/row-A"]).toBeUndefined();
  });

  it("is a no-op when the key isn't tracked (idempotent)", async () => {
    await writeFile(
      path.join(tmpDir, ".openit", "kb-state.json"),
      JSON.stringify({ collection_id: null, collection_name: null, files: {} }),
    );

    const { stdout } = await runScript(["--prefix", "kb", "--key", "missing.md"]);
    const result = JSON.parse(stdout.trim());
    expect(result.ok).toBe(true);
    expect(result.action).toBe("noop");
  });

  it("treats a missing manifest file as a successful no-op", async () => {
    // No filestore manifest written.
    const { stdout } = await runScript(["--prefix", "filestore", "--key", "foo.pdf"]);
    const result = JSON.parse(stdout.trim());
    expect(result).toMatchObject({ ok: true, removed: false, note: "manifest not found" });
  });

  it("rejects a bad prefix with a clear error and exit code 1", async () => {
    await expect(
      runScript(["--prefix", "bogus", "--key", "x"]),
    ).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining("invalid_prefix"),
    });
  });

  it("rejects missing required args", async () => {
    await expect(runScript(["--prefix", "datastore"])).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining("missing_key"),
    });
    await expect(runScript(["--key", "x"])).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining("missing_prefix"),
    });
  });
});
