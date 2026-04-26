#!/usr/bin/env node
// sync-resolve-conflict.mjs — clear a stuck sync-conflict banner after merge.
//
// Usage:
//   node .claude/scripts/sync-resolve-conflict.mjs \
//        --prefix <kb|filestore|datastore|agent|workflow> \
//        --key <manifestKey>
//
// What it does:
//   Deletes the manifest entry for <key> from .openit/<name>-state.json.
//   The OpenIT sync engine then treats the key as fresh on its next poll
//   (60s) and bootstrap-adopts it — seeding the manifest with the current
//   remote version + the on-disk mtime. The conflict banner clears.
//
// When to call this:
//   After merging the canonical (`<key>.json`) and deleting the shadow
//   (`<key>.server.json`). The conflict prompt sent by the OpenIT
//   conflict banner ends with this command for each conflicting key.
//
// What this does NOT do:
//   - Push to Pinkfish (the user reviews + commits in the Sync tab).
//   - Touch any file outside .openit/.
//   - Make any HTTP requests.
//
// cwd: the OpenIT project root (`~/OpenIT/<orgId>/`).

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

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

  const removed = Object.prototype.hasOwnProperty.call(manifest.files, args.key);
  if (removed) {
    delete manifest.files[args.key];
    try {
      await writeFile(fullPath, JSON.stringify(manifest, null, 2));
    } catch (e) {
      fail("write_failed", `Failed to write ${file}: ${e.message}`);
    }
  }

  process.stdout.write(
    JSON.stringify({ ok: true, prefix: args.prefix, key: args.key, removed }) + "\n",
  );
}

main().catch((e) => fail("unhandled", String(e?.stack ?? e)));
