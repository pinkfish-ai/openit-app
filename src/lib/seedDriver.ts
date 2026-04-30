// Bundled-seed driver. Decides per-target whether to write the seed
// (sample tickets / people / KB articles + the matching conversation
// turns) to disk. Runs BEFORE `startCloudSyncs` so the engine's
// `customCreate` (datastoreSync's import-csv path) has rows to push
// when it fires.
//
// Why per-target rather than all-or-nothing:
//   The user can have different cloud state per collection. E.g.
//   `openit-default` KB exists from a prior session but `openit-tickets`
//   was deleted to retest. We want to seed JUST tickets in that case.
//   The previous all-or-nothing gate would skip everything because
//   "the cloud has at least one openit-* collection".
//
// Idempotent without a sentinel:
//   - If the local folder already has content → don't seed (the next
//     run's local-empty check fails, so re-running is a no-op).
//   - If the cloud collection already exists → don't seed (engine will
//     pull cloud's data into local; we don't want to layer samples on
//     top of real rows).
//   - Otherwise → write seed.
//
// No sentinel file: the on-disk content + cloud state ARE the
// sentinel. Wipe local + delete cloud collection = clean re-seed.

import { invoke } from "@tauri-apps/api/core";
import { fsList } from "./api";
import { derivedUrls, getToken, type PinkfishCreds } from "./pinkfishAuth";
import { listCollections } from "./skillsApi";
import { routeFile } from "./skillsSync";

/// One seed target. `local` is the folder we check for emptiness;
/// `cloudName` is the cloud collection name we check for absence;
/// `cloudType` selects which `?type=` filter to use; `paths` is the
/// list of bundled files to write when the gate's open.
type SeedTarget = {
  label: string;
  local: string;
  cloudName: string;
  cloudType: "datastore" | "knowledge_base";
  paths: string[];
};

const SEED_TARGETS: SeedTarget[] = [
  {
    label: "tickets",
    local: "databases/tickets",
    cloudName: "openit-tickets",
    cloudType: "datastore",
    paths: [
      "seed/tickets/sample-ticket-1.json",
      "seed/tickets/sample-ticket-2.json",
      "seed/tickets/sample-ticket-3.json",
      "seed/tickets/sample-ticket-4.json",
      "seed/tickets/sample-ticket-5.json",
      // Conversations live alongside their tickets; write them as part
      // of the tickets seed so a click on any sample ticket has its
      // thread on disk.
      "seed/conversations/sample-ticket-1/msg-1745848931000-aa01.json",
      "seed/conversations/sample-ticket-2/msg-1745858924000-bb01.json",
      "seed/conversations/sample-ticket-2/msg-1745861702000-bb02.json",
      "seed/conversations/sample-ticket-3/msg-1745749860000-cc01.json",
      "seed/conversations/sample-ticket-3/msg-1745751738000-cc02.json",
      "seed/conversations/sample-ticket-4/msg-1745916300000-dd01.json",
      "seed/conversations/sample-ticket-5/msg-1745667000000-ee01.json",
      "seed/conversations/sample-ticket-5/msg-1745669100000-ee02.json",
    ],
  },
  {
    label: "people",
    local: "databases/people",
    cloudName: "openit-people",
    cloudType: "datastore",
    paths: [
      "seed/people/sample-person-1.json",
      "seed/people/sample-person-2.json",
      "seed/people/sample-person-3.json",
      "seed/people/sample-person-4.json",
      "seed/people/sample-person-5.json",
    ],
  },
  {
    label: "knowledge",
    local: "knowledge-bases/default",
    cloudName: "openit-default",
    cloudType: "knowledge_base",
    paths: [
      "seed/knowledge/sample-article-1.md",
      "seed/knowledge/sample-article-2.md",
    ],
  },
];

async function isFolderEmptyForSeed(repo: string, subdir: string): Promise<boolean> {
  const root = `${repo}/${subdir}`;
  let nodes;
  try {
    nodes = await fsList(root);
  } catch {
    return true;
  }
  const prefix = `${root}/`;
  for (const n of nodes) {
    if (!n.path.startsWith(prefix)) continue;
    const tail = n.path.slice(prefix.length);
    if (tail.includes("/")) continue;
    if (n.name.startsWith(".")) continue;
    if (n.name === "_schema.json") continue;
    return false;
  }
  return true;
}

async function writeSeedPath(repo: string, path: string): Promise<boolean> {
  const route = routeFile(path, "");
  if (!route || !route.isSeed) {
    console.warn(`[seedDriver] no seed route for ${path}, skipping`);
    return false;
  }
  const dest = `${repo}/${route.subdir}/${route.filename}`;
  try {
    await invoke<string>("fs_read", { path: dest });
    return false; // already there — leave alone
  } catch {
    /* missing — write below */
  }
  try {
    const content = await invoke<string>("skills_fetch_bundled_file", {
      skillPath: path,
    });
    await invoke("entity_write_file", {
      repo,
      subdir: route.subdir,
      filename: route.filename,
      content,
    });
    console.log(`[seedDriver] wrote ${path} → ${route.subdir}/${route.filename}`);
    return true;
  } catch (err) {
    console.warn(`[seedDriver] failed to write seed ${path}:`, err);
    return false;
  }
}

async function writeTargetSeed(repo: string, target: SeedTarget): Promise<number> {
  let written = 0;
  for (const p of target.paths) {
    if (await writeSeedPath(repo, p)) written += 1;
  }
  return written;
}

/// Local-only entry point. No cloud to consult — gate is just
/// folder-emptiness per target. (No sentinel: a project that already
/// has content for a target won't re-seed because the local check
/// fails on the next run.)
export async function applySeedLocalOnly(repo: string): Promise<void> {
  for (const target of SEED_TARGETS) {
    if (!(await isFolderEmptyForSeed(repo, target.local))) continue;
    const written = await writeTargetSeed(repo, target);
    if (written > 0) {
      console.log(`[seedDriver] local-only seed/${target.label} (${written} files)`);
    }
  }
}

/// Cloud-aware entry point. Per-target decision: write the seed
/// only when BOTH the local folder is empty AND the cloud doesn't
/// yet have the matching collection. Run before `startCloudSyncs`
/// so the engine's customCreate (import-csv) sees the seed rows.
export async function applySeedBeforeCloudConnect(
  repo: string,
  creds: PinkfishCreds,
): Promise<void> {
  const token = getToken();
  if (!token) {
    console.warn("[seedDriver] no token — falling back to local-only seed gate");
    await applySeedLocalOnly(repo);
    return;
  }
  const urls = derivedUrls(creds.tokenUrl);
  // Pre-fetch both lists once (used by every target).
  let datastores: { name: string }[] = [];
  let kbs: { name: string }[] = [];
  try {
    [datastores, kbs] = await Promise.all([
      listCollections(urls.skillsBaseUrl, token.accessToken, "datastore"),
      listCollections(urls.skillsBaseUrl, token.accessToken, "knowledge_base"),
    ]);
  } catch (e) {
    console.warn("[seedDriver] cloud probe failed:", e);
    return;
  }

  for (const target of SEED_TARGETS) {
    if (!(await isFolderEmptyForSeed(repo, target.local))) {
      continue;
    }
    const cloudList = target.cloudType === "datastore" ? datastores : kbs;
    const cloudHas = cloudList.some((c) => c.name === target.cloudName);
    if (cloudHas) {
      console.log(
        `[seedDriver] ${target.label}: cloud already has ${target.cloudName}, skipping`,
      );
      continue;
    }
    const written = await writeTargetSeed(repo, target);
    console.log(
      `[seedDriver] ${target.label}: seed applied (${written} files, cloud=${target.cloudName})`,
    );
  }
}
