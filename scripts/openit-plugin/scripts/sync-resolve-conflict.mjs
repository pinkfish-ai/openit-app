#!/usr/bin/env node
// sync-resolve-conflict.mjs — clear a stuck sync-conflict banner after merge.
//
// Usage:
//   node .claude/scripts/sync-resolve-conflict.mjs \
//        --prefix <knowledge-bases/<name> | filestores/<name> | databases/<name> | agent | workflow> \
//        --key <manifestKey>
//
// What it does:
//   Rewrites the manifest entry for <key> in `.openit/<name>-state.json`
//   so the engine treats the row as "reconciled against the conflict-time
//   remote version, local has changes that need to push":
//
//     {
//       remote_version: <conflict_remote_version observed at conflict time>,
//       pulled_at_mtime_ms: 1   // sentinel: forces localChanged=true
//     }
//
//   The conflict_remote_version field was written by the engine when it
//   created the .server. shadow. With remote_version now matching what
//   the server has, the next pre-push pull won't re-detect the row as
//   remotely-changed; with pulled_at_mtime_ms=1, push sees
//   localChanged=true and uploads. After push, the engine updates the
//   manifest with the new server-issued remote_version.
//
//   If the manifest entry has no conflict_remote_version (legacy state
//   from a pre-fix conflict), we fall back to deleting the entry — the
//   old behaviour. The next pull's bootstrap-adoption handles it.
//
// Manifest formats — Phase 2 of V2 sync (PIN-5775):
//   - **Nested per-collection** (current): `.openit/<entity>-state.json`
//     is `{ [collectionId]: { collection_id, collection_name, files } }`.
//     KB and filestore both use this shape.
//   - **Flat single-collection** (legacy): `{ collection_id,
//     collection_name, files }`. Only agent / workflow still write
//     this shape — datastore migrated to nested in Phase 3.
//
//   The script auto-detects which format is on disk and routes
//   accordingly.
//
// Prefix → manifest file:
//   - `knowledge-bases/<name>`     → `.openit/kb-state.json` (nested)
//   - `filestores/<name>`          → `.openit/fs-state.json` (nested)
//   - `databases/<name>`           → `.openit/datastore-state.json` (nested)
//   - `agent`                      → `.openit/agent-state.json` (flat)
//   - `workflow`                   → `.openit/workflow-state.json` (flat)
//
// Agent / workflow keep the flat shape until those engines migrate to
// per-collection manifests in a later phase. KB / filestore / datastore
// use the per-collection nested shape — and per-collection prefixes
// always carry collection identity, so this script can route directly to
// the right bucket without a legacy short-form fallback.
//
// When to call this:
//   After merging the canonical (`<key>.json`) and deleting the shadow
//   (`<key>.server.json`). The conflict prompt sent by the OpenIT
//   conflict banner ends with this command for each conflicting key.
//
// What this does NOT do:
//   - Push to Pinkfish — that's sync-push.mjs.
//   - Touch any file outside `.openit/`.
//   - Make any HTTP requests.
//
// cwd: the OpenIT project root (`~/OpenIT/<orgId>/`).

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

/// Sentinel `pulled_at_mtime_ms` for force-push state. Mirrors
/// `FORCE_PUSH_MTIME_SENTINEL` in src/lib/syncEngine.ts.
const FORCE_PUSH_MTIME_SENTINEL = 1;

/// Map an adapter prefix to the entity-state filename. Returns null
/// when the prefix shape is unrecognised.
function manifestFileFor(prefix) {
  if (prefix.startsWith("knowledge-bases/")) return ".openit/kb-state.json";
  if (prefix.startsWith("filestores/")) return ".openit/fs-state.json";
  if (prefix.startsWith("databases/")) return ".openit/datastore-state.json";
  if (prefix === "agent") return ".openit/agent-state.json";
  if (prefix === "workflow") return ".openit/workflow-state.json";
  return null;
}

/// Detect a nested manifest. Nested = every top-level value is an
/// object with `files` and `collection_id`. Flat = `collection_id`
/// lives at the top level alongside `files`.
function isNestedManifest(manifest) {
  if (!manifest || typeof manifest !== "object") return false;
  if (typeof manifest.collection_id === "string") return false;
  const values = Object.values(manifest);
  if (values.length === 0) return false;
  return values.every(
    (v) =>
      v &&
      typeof v === "object" &&
      "collection_id" in v &&
      "files" in v &&
      typeof v.files === "object",
  );
}

/// Find the right collection bucket inside a nested manifest given the
/// adapter prefix. Returns `{ bucket, bucketKey }` or null. `bucketKey`
/// is the collectionId we use to write back.
function findBucket(manifest, prefix) {
  // KB: `knowledge-bases/<displayName>` → look up by canonical
  // `openit-<displayName>` collection name.
  if (prefix.startsWith("knowledge-bases/")) {
    const displayName = prefix.slice("knowledge-bases/".length);
    const expected = `openit-${displayName}`;
    for (const [id, bucket] of Object.entries(manifest)) {
      if (bucket?.collection_name === expected) {
        return { bucket, bucketKey: id };
      }
    }
    return null;
  }
  // Filestore: same pattern, `filestores/<displayName>` → `openit-<displayName>`.
  if (prefix.startsWith("filestores/")) {
    const displayName = prefix.slice("filestores/".length);
    const expected = `openit-${displayName}`;
    for (const [id, bucket] of Object.entries(manifest)) {
      if (bucket?.collection_name === expected) {
        return { bucket, bucketKey: id };
      }
    }
    return null;
  }
  // Datastore: same pattern, `databases/<displayName>` → `openit-<displayName>`.
  // Phase 3 of V2 sync (PIN-5779) — datastore migrated to the nested
  // manifest shape alongside filestore + KB.
  if (prefix.startsWith("databases/")) {
    const displayName = prefix.slice("databases/".length);
    const expected = `openit-${displayName}`;
    for (const [id, bucket] of Object.entries(manifest)) {
      if (bucket?.collection_name === expected) {
        return { bucket, bucketKey: id };
      }
    }
    return null;
  }
  // agent / workflow use the flat manifest shape — they don't appear
  // in a nested manifest, so finding nothing here means the caller is
  // targeting the wrong file.
  return null;
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
      "Usage: sync-resolve-conflict.mjs --prefix <knowledge-bases/<name>|filestores/<name>|databases/<name>|agent|workflow> --key <manifestKey>\n",
    );
    process.exit(0);
  }
  if (!args.prefix) fail("missing_prefix", "Required: --prefix");
  if (!args.key) fail("missing_key", "Required: --key");

  const file = manifestFileFor(args.prefix);
  if (!file) {
    fail(
      "invalid_prefix",
      `Unknown prefix: ${args.prefix}. Valid: knowledge-bases/<name>, filestores/<name>, databases/<name>, agent, workflow.`,
    );
  }

  const fullPath = path.resolve(process.cwd(), file);
  if (!existsSync(fullPath)) {
    process.stdout.write(
      JSON.stringify({
        ok: true,
        prefix: args.prefix,
        key: args.key,
        removed: false,
        note: "manifest not found",
      }) + "\n",
    );
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(await readFile(fullPath, "utf8"));
  } catch (e) {
    fail("read_failed", `Failed to read ${file}: ${e.message}`);
  }

  // Pick the right files-container based on manifest shape.
  let files;
  let writeBack;
  if (isNestedManifest(manifest)) {
    const lookup = findBucket(manifest, args.prefix);
    if (!lookup) {
      fail(
        "bucket_not_found",
        `Prefix ${args.prefix} did not match any collection in nested manifest at ${file}. Buckets: ${Object.keys(manifest).join(", ")}`,
      );
    }
    files = lookup.bucket.files;
    writeBack = () => {
      manifest[lookup.bucketKey].files = files;
    };
  } else {
    if (!manifest.files || typeof manifest.files !== "object") {
      fail("invalid_manifest", `Manifest at ${file} has no .files object`);
    }
    files = manifest.files;
    writeBack = () => {
      manifest.files = files;
    };
  }

  const entry = files[args.key];
  let action = "noop";
  if (entry) {
    if (entry.conflict_remote_version) {
      // Force-push case — preserves "the user merged, push their local
      // content to remote" for both pick-local AND pick-remote outcomes.
      // Pick-remote ends up uploading content the server already has
      // (~no-op), the small cost of not distinguishing here.
      files[args.key] = {
        remote_version: entry.conflict_remote_version,
        pulled_at_mtime_ms: FORCE_PUSH_MTIME_SENTINEL,
      };
      action = "force-push";
    } else {
      // Legacy / bootstrap-adoption-without-engine-marker case — delete
      // the entry and let the next pull's bootstrap-adopt handle it.
      delete files[args.key];
      action = "deleted";
    }
    writeBack();
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
