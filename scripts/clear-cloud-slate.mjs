#!/usr/bin/env node
// Wipe every cloud-side `openit-*` data collection (filestorage, datastore,
// knowledge_base) in the org pointed at by test-config.json. Companion to
// `cleanslate.mjs` — that one nukes local state, this one nukes the cloud
// fixtures the seed gates would otherwise see.
//
// Auth + endpoints mirror integration_tests/utils/pinkfish-api.ts so the
// behavior stays in lockstep with the integration-test cleanup helpers.
//
// Usage:
//   npm run clear-cloud-slate              # prompts for confirmation
//   npm run clear-cloud-slate -- --yes     # skip prompt
//   npm run clear-cloud-slate -- --dry-run # list only, no deletes

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run") || args.has("-n");
const SKIP_CONFIRM = args.has("--yes") || args.has("-y");

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

// Mirrors deriveSkillsBaseUrl() in integration_tests/utils/config.ts
function deriveSkillsBaseUrl(tokenUrl) {
  let host;
  try {
    host = new URL(tokenUrl).host;
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
  if (!res.ok) {
    throw new Error(
      `listCollections(${type}) failed: HTTP ${res.status}: ${await res.text()}`,
    );
  }
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function deleteCollection(token, id) {
  const url = new URL(`/datacollection/${encodeURIComponent(id)}`, skillsBaseUrl);
  const res = await fetch(url, {
    method: "DELETE",
    headers: { "Auth-Token": `Bearer ${token}`, Accept: "*/*" },
  });
  if (res.ok || res.status === 404) return "ok";
  if (res.status === 403) return "forbidden";
  throw new Error(`delete failed: HTTP ${res.status}: ${await res.text()}`);
}

// Mirrors derivedUrls(tokenUrl).appBaseUrl — strip /oauth/token to
// get the appapi root. Used for /service/useragents calls below.
function deriveAppBaseUrl(tokenUrl) {
  try {
    const u = new URL(tokenUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "https://app-api.app.pinkfish.ai";
  }
}

const appBaseUrl = deriveAppBaseUrl(tokenUrl);

async function listAgents(token) {
  const url = new URL("/service/useragents", appBaseUrl);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "*/*" },
  });
  if (!res.ok) {
    throw new Error(`listAgents failed: HTTP ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function deleteAgent(token, id) {
  const url = new URL(
    `/service/useragents/${encodeURIComponent(id)}`,
    appBaseUrl,
  );
  const res = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}`, Accept: "*/*" },
  });
  if (res.ok || res.status === 404) return "ok";
  if (res.status === 403) return "forbidden";
  if (res.status === 405) return "route-missing";
  throw new Error(`delete failed: HTTP ${res.status}: ${await res.text()}`);
}

const TYPES = ["filestorage", "datastore", "knowledge_base"];

console.log(`▸ token endpoint:  ${tokenUrl}`);
console.log(`▸ skills endpoint: ${skillsBaseUrl}`);
console.log(`▸ org:             ${orgId}`);
console.log();

const token = await getToken();
console.log(`✓ got access token`);

const matches = [];
for (const type of TYPES) {
  const all = await listCollections(token, type);
  const openit = all.filter((c) => typeof c.name === "string" && c.name.startsWith("openit-"));
  for (const c of openit) matches.push({ kind: "collection", type, id: c.id, name: c.name });
}

const allAgents = await listAgents(token);
const openitAgents = allAgents.filter(
  (a) => typeof a.name === "string" && a.name.startsWith("openit-"),
);
for (const a of openitAgents) {
  matches.push({ kind: "agent", type: "useragent", id: a.id, name: a.name });
}

if (matches.length === 0) {
  console.log(`\n✓ no openit-* collections or agents to delete — cloud is already clean.`);
  process.exit(0);
}

console.log(`\nFound ${matches.length} openit-* item(s):\n`);
for (const m of matches) {
  console.log(`  [${m.type.padEnd(14)}] ${m.name}  (${m.id})`);
}

if (DRY_RUN) {
  console.log(`\n(dry-run — nothing deleted)`);
  process.exit(0);
}

if (!SKIP_CONFIRM) {
  const rl = createInterface({ input, output });
  const answer = await rl.question(`\nDelete all ${matches.length}? [y/N] `);
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) {
    console.log("aborted.");
    process.exit(0);
  }
}

console.log();
let deleted = 0;
let forbidden = 0;
let routeMissing = 0;
for (const m of matches) {
  try {
    const result = m.kind === "agent"
      ? await deleteAgent(token, m.id)
      : await deleteCollection(token, m.id);
    if (result === "forbidden") {
      console.log(`  ⚠  forbidden  ${m.name}  (cred lacks delete scope)`);
      forbidden += 1;
    } else if (result === "route-missing") {
      console.log(
        `  ⚠  route-missing  ${m.name}  (DELETE /service/useragents/{id} not deployed yet)`,
      );
      routeMissing += 1;
    } else {
      console.log(`  ✓ deleted    ${m.name}`);
      deleted += 1;
    }
  } catch (e) {
    console.log(`  ✗ failed     ${m.name}: ${e.message}`);
  }
}

const tail = [];
if (forbidden) tail.push(`${forbidden} forbidden`);
if (routeMissing) tail.push(`${routeMissing} route-missing`);
console.log(
  `\nDone. Deleted ${deleted}/${matches.length}${tail.length ? `, ${tail.join(", ")}` : ""}.`,
);
