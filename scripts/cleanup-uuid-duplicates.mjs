#!/usr/bin/env node
// One-shot cleanup for the UUID-prefixed duplicates that pre-PIN-5847
// `pushAllToFilestoreImpl` accumulated. Companion to the PIN-5847 fix
// (filestore push now uses `/upload-request` + signed PUT, which keeps
// filenames clean). This script is idempotent — running it on a
// freshly-clean repo is a no-op.
//
// What it does, per filestore collection (`openit-library`,
// `openit-attachments`, `openit-skills`, `openit-scripts`) and the
// default KB collection (`openit-default`):
//
//   1. Lists remote items.
//   2. Identifies UUID-prefixed remote rows (`<32-hex-with-dashes>-<rest>`)
//      whose canonical sibling (`<rest>`) also exists in the same
//      collection. Those are pure duplicates — the canonical row is
//      authoritative.
//   3. For each duplicate: DELETE /filestorage/items/<id>.
//   4. Walks the local working-tree dir for the same collection and
//      deletes the matching `<uuid>-<rest>` file if a non-prefixed
//      sibling exists locally.
//
// Safety:
//   - Skips local files that have NO canonical sibling. We can't
//     auto-pick the "right" UUID copy in that case — manual rename
//     required.
//   - Dry-run by default. Pass --apply to actually delete.
//
// Usage:
//   node scripts/cleanup-uuid-duplicates.mjs --repo ~/OpenIT/local
//   node scripts/cleanup-uuid-duplicates.mjs --repo ~/OpenIT/local --apply
//
// Auth: same `test-config.json` pattern as
// `scripts/clear-cloud-slate.mjs` — orgId + OAuth client creds.

import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const repoIdx = args.indexOf("--repo");
const REPO = repoIdx >= 0 ? args[repoIdx + 1] : null;

if (!REPO) {
  console.error("usage: node scripts/cleanup-uuid-duplicates.mjs --repo <path> [--apply]");
  process.exit(1);
}

const repoPath = resolve(REPO.replace(/^~/, process.env.HOME ?? ""));
if (!existsSync(repoPath)) {
  console.error(`✗ repo path does not exist: ${repoPath}`);
  process.exit(1);
}

const CONFIG_PATH = resolve(process.cwd(), "test-config.json");
if (!existsSync(CONFIG_PATH)) {
  console.error(`✗ test-config.json not found at ${CONFIG_PATH}`);
  console.error(`  Copy test-config.example.json and fill in your dev creds.`);
  process.exit(1);
}

const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
const { orgId, credentials } = config;
const { tokenUrl, clientId, clientSecret } = credentials ?? {};
if (!orgId || !tokenUrl || !clientId || !clientSecret) {
  console.error("✗ test-config.json missing orgId or credentials fields");
  process.exit(1);
}

function deriveSkillsBaseUrl(url) {
  let host;
  try {
    host = new URL(url).host;
  } catch {
    host = "app-api.app.pinkfish.ai";
  }
  const isDev = host.endsWith(".pinkfish.dev") || /\.dev\d/i.test(host);
  return `https://${isDev ? "skills-stage.pinkfish.ai" : "skills.pinkfish.ai"}`;
}

const skillsBaseUrl = deriveSkillsBaseUrl(tokenUrl);

async function getToken() {
  const params = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: `org:${orgId}`,
  });
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!res.ok) {
    throw new Error(`token request failed: HTTP ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.access_token;
}

async function listCollections(token, type) {
  const url = new URL("/datacollection/", skillsBaseUrl);
  url.searchParams.set("type", type);
  const res = await fetch(url, {
    headers: { "Auth-Token": `Bearer ${token}`, Accept: "*/*" },
  });
  if (!res.ok) throw new Error(`list ${type}: HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function listItems(token, collectionId) {
  const url = new URL("/filestorage/items", skillsBaseUrl);
  url.searchParams.set("collectionId", collectionId);
  url.searchParams.set("format", "light");
  const res = await fetch(url, {
    headers: { "Auth-Token": `Bearer ${token}`, Accept: "*/*" },
  });
  if (!res.ok) throw new Error(`list items: HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.items)) return data.items;
  return [];
}

async function deleteItem(token, itemId) {
  const url = new URL(`/filestorage/items/${encodeURIComponent(itemId)}`, skillsBaseUrl);
  const res = await fetch(url, {
    method: "DELETE",
    headers: { "Auth-Token": `Bearer ${token}`, Accept: "*/*" },
  });
  if (res.ok || res.status === 404) return "ok";
  if (res.status === 403) return "forbidden";
  throw new Error(`delete item ${itemId}: HTTP ${res.status}: ${await res.text()}`);
}

const UUID_PREFIX_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(.+)$/i;

function stripUuid(filename) {
  const m = filename.match(UUID_PREFIX_RE);
  return m ? m[2] : null;
}

// Collection name → local working-tree subdir. Mirrors the filestore +
// KB adapters in src/lib/entities/.
const SUBDIR_BY_NAME = {
  "openit-library": "filestores/library",
  "openit-attachments": "filestores/attachments",
  "openit-skills": "filestores/skills",
  "openit-scripts": "filestores/scripts",
  "openit-default": "knowledge-bases/default",
};

console.log(`▸ repo:            ${repoPath}`);
console.log(`▸ skills endpoint: ${skillsBaseUrl}`);
console.log(`▸ org:             ${orgId}`);
console.log(`▸ mode:            ${APPLY ? "APPLY" : "dry-run (pass --apply to delete)"}`);
console.log();

const token = await getToken();
console.log(`✓ got access token\n`);

let totalRemoteFlagged = 0;
let totalRemoteDeleted = 0;
let totalLocalFlagged = 0;
let totalLocalDeleted = 0;
let totalLocalOrphans = 0;

async function processCollection(token, type, collection) {
  const subdir = SUBDIR_BY_NAME[collection.name];
  if (!subdir) {
    console.log(`  (skipping ${collection.name} — no local-dir mapping)`);
    return;
  }

  const items = await listItems(token, collection.id);
  const byCanonical = new Map();
  for (const item of items) {
    const canonical = stripUuid(item.filename) ?? item.filename;
    if (!byCanonical.has(canonical)) byCanonical.set(canonical, []);
    byCanonical.get(canonical).push(item);
  }

  const remoteToDelete = [];
  for (const [canonical, group] of byCanonical) {
    if (group.length < 2) continue;
    const canonicalRow = group.find((g) => g.filename === canonical);
    if (!canonicalRow) {
      console.log(
        `  ⚠ ${collection.name}: ${group.length} UUID-prefixed copies of "${canonical}" but no canonical row — skipping (manual rename needed)`,
      );
      continue;
    }
    for (const dup of group) {
      if (dup.filename !== canonical) remoteToDelete.push(dup);
    }
  }

  if (remoteToDelete.length > 0) {
    console.log(`  remote: ${remoteToDelete.length} duplicate row(s) flagged in ${collection.name}`);
    totalRemoteFlagged += remoteToDelete.length;
    for (const dup of remoteToDelete) {
      if (!APPLY) {
        console.log(`    - ${dup.filename}  (id=${dup.id})`);
        continue;
      }
      try {
        const result = await deleteItem(token, dup.id);
        if (result === "forbidden") {
          console.log(`    ⚠ forbidden  ${dup.filename}  (cred lacks delete scope)`);
        } else {
          console.log(`    ✓ deleted   ${dup.filename}`);
          totalRemoteDeleted += 1;
        }
      } catch (e) {
        console.log(`    ✗ error     ${dup.filename}: ${e.message}`);
      }
    }
  }

  // Local cleanup — independent of the remote pass. Walk the local
  // dir; for each <uuid>-<rest> file with a non-prefixed sibling
  // present, delete the prefixed copy.
  const dir = join(repoPath, subdir);
  if (!existsSync(dir)) {
    return;
  }
  const entries = readdirSync(dir);
  const present = new Set(entries);

  const localFlagged = [];
  for (const name of entries) {
    const stripped = stripUuid(name);
    if (!stripped) continue;
    if (present.has(stripped)) {
      localFlagged.push({ prefixed: name, canonical: stripped });
    } else {
      totalLocalOrphans += 1;
      console.log(`  ⚠ ${subdir}/${name}: UUID-prefixed but no canonical sibling — skipping (manual rename needed)`);
    }
  }

  if (localFlagged.length > 0) {
    console.log(`  local: ${localFlagged.length} duplicate file(s) flagged in ${subdir}`);
    totalLocalFlagged += localFlagged.length;
    for (const f of localFlagged) {
      if (!APPLY) {
        console.log(`    - ${subdir}/${f.prefixed}`);
        continue;
      }
      try {
        unlinkSync(join(dir, f.prefixed));
        console.log(`    ✓ deleted   ${subdir}/${f.prefixed}`);
        totalLocalDeleted += 1;
      } catch (e) {
        console.log(`    ✗ error     ${subdir}/${f.prefixed}: ${e.message}`);
      }
    }
  }
}

for (const type of ["filestorage", "knowledge_base"]) {
  const all = await listCollections(token, type);
  const openit = all.filter(
    (c) => typeof c.name === "string" && c.name.startsWith("openit-"),
  );
  if (openit.length === 0) {
    console.log(`(no openit-* ${type} collections)`);
    continue;
  }
  console.log(`\n=== ${type} ===`);
  for (const c of openit) {
    console.log(`\n  collection: ${c.name}  (id=${c.id})`);
    await processCollection(token, type, c);
  }
}

// Suppress unused-var linter on `statSync` import (kept for future
// content-equality checks).
void statSync;

console.log(`\n──────────────`);
console.log(`Remote: flagged=${totalRemoteFlagged}  ${APPLY ? `deleted=${totalRemoteDeleted}` : "(dry-run)"}`);
console.log(`Local:  flagged=${totalLocalFlagged}  ${APPLY ? `deleted=${totalLocalDeleted}` : "(dry-run)"}  orphans=${totalLocalOrphans}`);
if (!APPLY) {
  console.log(`\n(dry-run — re-run with --apply to actually delete)`);
}
