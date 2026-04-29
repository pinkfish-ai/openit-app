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
    // Phase 3: datastore migrated to nested per-collection manifest.
    // The bare manifestKey is the row key (`row-A`); the bucket is
    // keyed by collection id and looked up by `collection_name`
    // matching `openit-<displayName>`.
    await writeFile(
      path.join(tmpDir, ".openit", "datastore-state.json"),
      JSON.stringify({
        "ds-people-id": {
          collection_id: "ds-people-id",
          collection_name: "openit-people",
          files: {
            "row-A": {
              remote_version: "v1-pre-conflict",
              pulled_at_mtime_ms: 1000,
              conflict_remote_version: "v2-at-conflict-time",
            },
            "row-B": {
              remote_version: "v2",
              pulled_at_mtime_ms: 2000,
            },
          },
        },
      }),
    );

    const { stdout } = await runScript([
      "--prefix",
      "databases/people",
      "--key",
      "row-A",
    ]);
    const result = JSON.parse(stdout.trim());
    expect(result).toEqual({
      ok: true,
      prefix: "databases/people",
      key: "row-A",
      action: "force-push",
    });

    const manifest = (await readManifest("datastore")) as unknown as Record<
      string,
      { files: Record<string, unknown> }
    >;
    expect(manifest["ds-people-id"].files["row-A"]).toEqual({
      remote_version: "v2-at-conflict-time",
      pulled_at_mtime_ms: 1,
    });
    // Sibling row-B preserved unchanged.
    expect(manifest["ds-people-id"].files["row-B"]).toEqual({
      remote_version: "v2",
      pulled_at_mtime_ms: 2000,
    });
  });

  it("legacy: deletes the entry when no conflict_remote_version is present", async () => {
    await writeFile(
      path.join(tmpDir, ".openit", "datastore-state.json"),
      JSON.stringify({
        "ds-people-id": {
          collection_id: "ds-people-id",
          collection_name: "openit-people",
          files: {
            "row-A": { remote_version: "v1", pulled_at_mtime_ms: 1000 },
          },
        },
      }),
    );

    const { stdout } = await runScript([
      "--prefix",
      "databases/people",
      "--key",
      "row-A",
    ]);
    const result = JSON.parse(stdout.trim());
    expect(result).toEqual({
      ok: true,
      prefix: "databases/people",
      key: "row-A",
      action: "deleted",
    });

    const manifest = (await readManifest("datastore")) as unknown as Record<
      string,
      { files: Record<string, unknown> }
    >;
    expect(manifest["ds-people-id"].files["row-A"]).toBeUndefined();
  });

  it("is a no-op when the key isn't tracked (idempotent)", async () => {
    // Nested manifest, default bucket present but empty files.
    await writeFile(
      path.join(tmpDir, ".openit", "kb-state.json"),
      JSON.stringify({
        "kb-default-id": {
          collection_id: "kb-default-id",
          collection_name: "openit-default",
          files: {},
        },
      }),
    );

    const { stdout } = await runScript([
      "--prefix",
      "knowledge-bases/default",
      "--key",
      "missing.md",
    ]);
    const result = JSON.parse(stdout.trim());
    expect(result.ok).toBe(true);
    expect(result.action).toBe("noop");
  });

  it("treats a missing manifest file as a successful no-op", async () => {
    // No filestore manifest written.
    const { stdout } = await runScript([
      "--prefix",
      "filestores/library",
      "--key",
      "foo.pdf",
    ]);
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
