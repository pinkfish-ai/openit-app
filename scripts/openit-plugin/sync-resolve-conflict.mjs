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

import { readFile, unlink, writeFile } from "node:fs/promises";
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

/// Map a (prefix, manifestKey) back to the canonical and shadow paths
/// on disk. The conflict prompt instructs Claude to delete the shadow
/// before running this script, but Claude has been observed to skip
/// step 3 occasionally — we defensively clean up the shadow here so a
/// leftover .server.* file doesn't keep the FileExplorer's "shadow
/// next to canonical" detection lit up. Returning null disables the
/// cleanup for that prefix (e.g. unknown layout).
function shadowPathFor(prefix, key) {
  // Datastore: manifestKey is `<colName>/<key>`, shadow is
  // `databases/<colName>/<key>.server.json`.
  if (prefix === "datastore") {
    return `databases/${key}.server.json`;
  }
  // KB: filename is the manifestKey verbatim.
  if (prefix === "kb") {
    return shadowFilenameFor(`knowledge-base/${key}`);
  }
  // Filestore: ditto.
  if (prefix === "filestore") {
    return shadowFilenameFor(`filestore/${key}`);
  }
  if (prefix === "agent") {
    return shadowFilenameFor(`agents/${key}`);
  }
  if (prefix === "workflow") {
    return shadowFilenameFor(`workflows/${key}`);
  }
  return null;
}

/// runbook.md → runbook.server.md. Bare filename (no extension) is
/// also handled.
function shadowFilenameFor(workingTreePath) {
  const dot = workingTreePath.lastIndexOf(".");
  const slash = workingTreePath.lastIndexOf("/");
  if (dot <= slash) return `${workingTreePath}.server`;
  return `${workingTreePath.slice(0, dot)}.server.${workingTreePath.slice(dot + 1)}`;
}

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
    // Use a typeof check, NOT truthiness — adapters whose remote
    // payload lacks an `updatedAt` normalize to "" (KB / filestore /
    // datastore / agent / workflow all do this). The engine writes
    // that "" into `conflict_remote_version` faithfully, and a
    // truthiness check would skip past the force-push path into the
    // legacy delete-entry path, which re-conflicts on the next pull
    // when the user picked LOCAL.
    if (typeof entry.conflict_remote_version === "string") {
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

  // Defensive shadow cleanup. The prompt instructs Claude to `rm` the
  // shadow before running this script; if Claude skipped that step,
  // a leftover `.server.*` file would keep the explorer's conflict
  // marker on the canonical (it's keyed off the engine aggregate, but
  // also off "is there a sibling shadow on disk?" — depending on the
  // entity). Best-effort: ignore if the file doesn't exist.
  let shadowRemoved = false;
  const shadowRel = shadowPathFor(args.prefix, args.key);
  if (shadowRel) {
    const shadowAbs = path.resolve(process.cwd(), shadowRel);
    if (existsSync(shadowAbs)) {
      try {
        await unlink(shadowAbs);
        shadowRemoved = true;
      } catch (e) {
        // Don't fail the whole resolve on a shadow cleanup miss.
        process.stderr.write(`warn: shadow cleanup failed: ${e.message}\n`);
      }
    }
  }

  process.stdout.write(
    JSON.stringify({
      ok: true,
      prefix: args.prefix,
      key: args.key,
      action,
      shadowRemoved,
    }) + "\n",
  );
}

main().catch((e) => fail("unhandled", String(e?.stack ?? e)));
