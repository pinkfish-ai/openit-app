#!/usr/bin/env node
// sync-resolve-conflict.mjs — clear a stuck sync-conflict banner after merge.
//
// Usage:
//   node .claude/scripts/sync-resolve-conflict.mjs \
//        --prefix <kb|filestore|datastore|agent|workflow> \
//        --key <manifestKey>
//
// What it does:
//   Rewrites the manifest entry for <key> in .openit/<name>-state.json
//   so the engine treats the row as "reconciled against the
//   conflict-time remote version, local has changes that need to push":
//
//     {
//       remote_version: <conflict_remote_version observed at conflict time>,
//       pulled_at_mtime_ms: 1   // sentinel: forces localChanged=true
//     }
//
//   The conflict_remote_version field was written by the engine when
//   it created the .server. shadow. With remote_version now matching
//   what the server has, the next pre-push pull won't re-detect the
//   row as remotely-changed; with pulled_at_mtime_ms=1, push sees
//   localChanged=true and uploads. After push, the engine updates the
//   manifest with the new server-issued remote_version.
//
//   If the manifest entry has no conflict_remote_version (legacy
//   state from a pre-fix conflict), we fall back to deleting the
//   entry — the old behavior. The next pull's bootstrap-adoption
//   handles it (with content-equality, this is correct only when
//   local matches remote, i.e. the user picked "remote" in the merge).
//
// When to call this:
//   After merging the canonical (`<key>.json`) and deleting the shadow
//   (`<key>.server.json`). The conflict prompt sent by the OpenIT
//   conflict banner ends with this command for each conflicting key.
//
// What this does NOT do:
//   - Push to Pinkfish — that's sync-push.mjs.
//   - Touch any file outside .openit/.
//   - Make any HTTP requests.
//
// cwd: the OpenIT project root (`~/OpenIT/<orgId>/`).

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

/// Sentinel `pulled_at_mtime_ms` for force-push state. Mirrors
/// `FORCE_PUSH_MTIME_SENTINEL` in src/lib/syncEngine.ts — any real
/// local mtime exceeds it, so the engine's `localChanged` check fires
/// on the next pull and the row gets pushed. Keep the two values in
/// sync if either side ever changes.
const FORCE_PUSH_MTIME_SENTINEL = 1;

const PREFIX_TO_FILE = {
  kb: ".openit/kb-state.json",
  filestore: ".openit/fs-state.json",
  datastore: ".openit/datastore-state.json",
  agent: ".openit/agent-state.json",
  workflow: ".openit/workflow-state.json",
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--prefix") out.prefix = argv[++i];
    else if (a === "--key") out.key = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function fail(code, message) {
  process.stdout.write(JSON.stringify({ ok: false, error: { code, message } }) + "\n");
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(
      "Usage: sync-resolve-conflict.mjs --prefix <kb|filestore|datastore|agent|workflow> --key <manifestKey>\n",
    );
    process.exit(0);
  }
  if (!args.prefix) fail("missing_prefix", "Required: --prefix <kb|filestore|datastore|agent|workflow>");
  if (!args.key) fail("missing_key", "Required: --key <manifestKey>");

  const file = PREFIX_TO_FILE[args.prefix];
  if (!file) fail("invalid_prefix", `Unknown prefix: ${args.prefix}. Valid: ${Object.keys(PREFIX_TO_FILE).join(", ")}`);

  const fullPath = path.resolve(process.cwd(), file);
  if (!existsSync(fullPath)) {
    // No manifest = no conflict to clear. Treat as a successful no-op so
    // Claude doesn't loop on a recoverable state.
    process.stdout.write(
      JSON.stringify({ ok: true, prefix: args.prefix, key: args.key, removed: false, note: "manifest not found" }) + "\n",
    );
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(await readFile(fullPath, "utf8"));
  } catch (e) {
    fail("read_failed", `Failed to read ${file}: ${e.message}`);
  }
  if (!manifest.files || typeof manifest.files !== "object") {
    fail("invalid_manifest", `Manifest at ${file} has no .files object`);
  }

  const entry = manifest.files[args.key];
  let action = "noop";
  if (entry) {
    if (entry.conflict_remote_version) {
      // Force-push case — preserves "the user merged, push their
      // local content to remote" for both pick-local AND pick-remote
      // outcomes. Pick-remote ends up uploading content the server
      // already has (~no-op), which is the small cost of not
      // distinguishing the two cases here.
      manifest.files[args.key] = {
        remote_version: entry.conflict_remote_version,
        pulled_at_mtime_ms: FORCE_PUSH_MTIME_SENTINEL,
      };
      action = "force-push";
    } else {
      // Legacy / bootstrap-adoption-without-engine-marker case —
      // delete the entry and let the next pull's bootstrap-adopt
      // handle it. Works for pick-remote (content-equality match
      // adopts cleanly); pick-local would re-conflict, which the new
      // engine path avoids by always writing conflict_remote_version.
      delete manifest.files[args.key];
      action = "deleted";
    }
    try {
      await writeFile(fullPath, JSON.stringify(manifest, null, 2));
    } catch (e) {
      fail("write_failed", `Failed to write ${file}: ${e.message}`);
    }
  }

  process.stdout.write(
    JSON.stringify({ ok: true, prefix: args.prefix, key: args.key, action }) + "\n",
  );
}

main().catch((e) => fail("unhandled", String(e?.stack ?? e)));
