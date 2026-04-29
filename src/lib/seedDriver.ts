// Bundled-seed driver. Owns the decision of when to write the seed
// (sample tickets / people / KB articles) to disk, separate from the
// always-runs `skillsSync` writer.
//
// Why split it out:
//   skillsSync writes manifest items (skills, schemas, scripts, agents,
//   CLAUDE.md) at startup and is local-only. Seed records are different
//   — we only want them written when the project is genuinely brand-new
//   (locally AND, when cloud is connected, on the cloud side too). If
//   the user is reconnecting against an existing cloud org with rows,
//   those rows pull down first and we must not also push our seed up,
//   or the user ends up with `their data + our samples` merged.
//
// Decision matrix:
//   1. Sentinel `.openit/seed-applied` present                → never re-seed
//   2. Local-only mode (no creds)                             → seed if local folders empty
//   3. Cloud-connected, AFTER first datastore + KB resolve    → seed only if
//      local folders are STILL empty post-pull (= cloud also empty)
//
// In all "did not seed" branches we still write the sentinel so the
// next launch doesn't re-evaluate.

import { invoke } from "@tauri-apps/api/core";
import { fsList } from "./api";
import { getDatastoreSyncStatus, subscribeDatastoreSync } from "./datastoreSync";
import { getSyncStatus as getKbSyncStatus, subscribeSync as subscribeKbSync } from "./kbSync";
import { type PinkfishCreds } from "./pinkfishAuth";
import { routeFile } from "./skillsSync";

const SEED_APPLIED_SENTINEL = ".openit/seed-applied";

/// Manifest paths the seed gate cares about. Mirror these in
/// `manifest.json` — `skillsSync` skips routing them (it sees
/// `route.isSeed` and continues), and we own the writes here.
const SEED_PATHS = [
  "seed/tickets/sample-ticket-1.json",
  "seed/tickets/sample-ticket-2.json",
  "seed/tickets/sample-ticket-3.json",
  "seed/tickets/sample-ticket-4.json",
  "seed/tickets/sample-ticket-5.json",
  "seed/people/sample-person-1.json",
  "seed/people/sample-person-2.json",
  "seed/people/sample-person-3.json",
  "seed/people/sample-person-4.json",
  "seed/people/sample-person-5.json",
  "seed/knowledge/sample-article-1.md",
  "seed/knowledge/sample-article-2.md",
  "seed/conversations/sample-ticket-1/msg-1745848931000-aa01.json",
  "seed/conversations/sample-ticket-2/msg-1745858924000-bb01.json",
  "seed/conversations/sample-ticket-2/msg-1745861702000-bb02.json",
  "seed/conversations/sample-ticket-3/msg-1745749860000-cc01.json",
  "seed/conversations/sample-ticket-3/msg-1745751738000-cc02.json",
  "seed/conversations/sample-ticket-4/msg-1745916300000-dd01.json",
  "seed/conversations/sample-ticket-5/msg-1745667000000-ee01.json",
  "seed/conversations/sample-ticket-5/msg-1745669100000-ee02.json",
];

const SEED_TARGETS = [
  "databases/tickets",
  "databases/people",
  "knowledge-bases/default",
  "databases/conversations",
];

async function isSeedApplied(repo: string): Promise<boolean> {
  try {
    await invoke<string>("fs_read", { path: `${repo}/${SEED_APPLIED_SENTINEL}` });
    return true;
  } catch {
    return false;
  }
}

async function markSeedApplied(repo: string): Promise<void> {
  try {
    await invoke("entity_write_file", {
      repo,
      subdir: ".openit",
      filename: "seed-applied",
      content: new Date().toISOString(),
    });
  } catch (err) {
    console.warn("[seedDriver] failed to write seed-applied sentinel:", err);
  }
}

/// True iff the folder has no real content. Tolerates `_schema.json`
/// (skillsSync writes those) and dotfiles. Direct-child subdirs count
/// as "non-empty" so a project that already has e.g.
/// `databases/conversations/<existing-ticket>/` doesn't get seed
/// conversations layered on top.
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

async function allTargetsEmpty(repo: string): Promise<boolean> {
  const checks = await Promise.all(SEED_TARGETS.map((d) => isFolderEmptyForSeed(repo, d)));
  return checks.every((c) => c);
}

/// Write the bundled seed files to disk. Skips per-file collisions —
/// if a target file already exists (e.g. the user already created one
/// with the same name), we leave their version alone.
async function writeSeedFilesToDisk(repo: string): Promise<number> {
  let written = 0;
  for (const path of SEED_PATHS) {
    const route = routeFile(path, "");
    if (!route || !route.isSeed) {
      console.warn(`[seedDriver] no seed route for ${path}, skipping`);
      continue;
    }
    try {
      const content = await invoke<string>("skills_fetch_bundled_file", { skillPath: path });
      // Per-file existence check — don't clobber an admin's same-named file.
      const dest = `${repo}/${route.subdir}/${route.filename}`;
      let exists = false;
      try {
        await invoke<string>("fs_read", { path: dest });
        exists = true;
      } catch {
        /* missing — we'll write */
      }
      if (exists) continue;
      await invoke("entity_write_file", {
        repo,
        subdir: route.subdir,
        filename: route.filename,
        content,
      });
      console.log(`[seedDriver] wrote ${path} → ${route.subdir}/${route.filename}`);
      written += 1;
    } catch (err) {
      console.warn(`[seedDriver] failed to write seed ${path}:`, err);
    }
  }
  return written;
}

/// Backfill seed conversations for any sample-ticket the project has
/// but whose conversation subfolder is empty. Idempotent: skips
/// tickets that don't exist locally and skips conversations already
/// on disk. Lets us add new conversation seeds in a later release
/// for projects that already passed the initial seed gate without
/// re-seeding tickets/people/KB.
async function backfillMissingConversationSeeds(repo: string): Promise<void> {
  for (const path of SEED_PATHS) {
    if (!path.startsWith("seed/conversations/")) continue;
    const route = routeFile(path, "");
    if (!route || !route.isSeed) continue;
    // route.subdir is `databases/conversations/<ticketId>`. Map back to the
    // ticket-row path; if the ticket isn't on disk, skip the conversation.
    const ticketId = route.subdir.replace("databases/conversations/", "");
    const ticketPath = `${repo}/databases/tickets/${ticketId}.json`;
    try {
      await invoke<string>("fs_read", { path: ticketPath });
    } catch {
      continue; // ticket not present — leave conversation alone
    }
    const dest = `${repo}/${route.subdir}/${route.filename}`;
    try {
      await invoke<string>("fs_read", { path: dest });
      continue; // already present
    } catch {
      /* missing — write below */
    }
    try {
      const content = await invoke<string>("skills_fetch_bundled_file", { skillPath: path });
      await invoke("entity_write_file", {
        repo,
        subdir: route.subdir,
        filename: route.filename,
        content,
      });
      console.log(`[seedDriver] backfilled ${path} → ${route.subdir}/${route.filename}`);
    } catch (err) {
      console.warn(`[seedDriver] backfill ${path} failed:`, err);
    }
  }
}

/// Local-only entry point. Runs when the user is NOT cloud-connected;
/// no engine resolves to wait for. Apply seed if the gate's open.
export async function applySeedLocalOnly(repo: string): Promise<void> {
  if (await isSeedApplied(repo)) {
    // Seed is locked but a previous build may have shipped without
    // conversation seeds — backfill those if their parent tickets
    // are still on disk.
    await backfillMissingConversationSeeds(repo);
    return;
  }
  if (!(await allTargetsEmpty(repo))) {
    // Folders aren't empty (user already has content) — lock out and bail.
    await markSeedApplied(repo);
    return;
  }
  const written = await writeSeedFilesToDisk(repo);
  await markSeedApplied(repo);
  console.log(`[seedDriver] local-only seed applied (${written} files)`);
}

/// Cloud-connected entry point. Subscribes to the datastore + KB
/// engines, waits for the FIRST successful resolve of each (status
/// reaches `ready` with `lastPullAt` set), then re-checks local
/// emptiness — if the folders are still empty, the cloud also has
/// nothing for them, and it's safe to seed. Self-cleans subscriptions.
///
/// Fire-and-forget — caller doesn't await this. Errors get logged.
export function applySeedAfterCloudResolve(
  repo: string,
  creds: PinkfishCreds,
  onPushRequest?: () => void,
): void {
  void creds; // creds isn't needed by the seed write itself; kept for signature symmetry
  void (async () => {
    if (await isSeedApplied(repo)) {
      await backfillMissingConversationSeeds(repo);
      return;
    }

    let datastoreReady = false;
    let kbReady = false;
    let resolved = false;

    const tryFinish = async () => {
      if (resolved) return;
      if (!datastoreReady || !kbReady) return;
      resolved = true;
      try {
        unsubscribeDs();
      } catch {
        /* already torn down */
      }
      try {
        unsubscribeKb();
      } catch {
        /* already torn down */
      }
      try {
        if (await isSeedApplied(repo)) return;
        if (!(await allTargetsEmpty(repo))) {
          await markSeedApplied(repo);
          console.log("[seedDriver] cloud has content — seed skipped, sentinel locked");
          return;
        }
        const written = await writeSeedFilesToDisk(repo);
        await markSeedApplied(repo);
        console.log(`[seedDriver] cloud-resolve seed applied (${written} files)`);
        // Trigger an upstream push so the seed reaches cloud right
        // away; without this it'd wait for the user to hit Deploy.
        if (onPushRequest && written > 0) {
          try {
            onPushRequest();
          } catch (err) {
            console.warn("[seedDriver] push trigger threw:", err);
          }
        }
      } catch (err) {
        console.warn("[seedDriver] post-resolve seed pass failed:", err);
      }
    };

    // Engines may already have resolved by the time we subscribe (the
    // pull is async; this subscribe could land after the first ready
    // tick). Sample current status before subscribing so we don't
    // wait forever on an event that already fired.
    const dsNow = getDatastoreSyncStatus();
    if (dsNow.phase === "ready" && dsNow.lastPullAt != null) datastoreReady = true;
    const kbNow = getKbSyncStatus();
    if (kbNow.phase === "ready" && kbNow.lastPullAt != null) kbReady = true;

    const unsubscribeDs = subscribeDatastoreSync((s) => {
      if (s.phase === "ready" && s.lastPullAt != null) {
        datastoreReady = true;
        void tryFinish();
      }
    });
    const unsubscribeKb = subscribeKbSync((s) => {
      if (s.phase === "ready" && s.lastPullAt != null) {
        kbReady = true;
        void tryFinish();
      }
    });

    // If both were already ready at subscribe time, fire once now.
    void tryFinish();
  })();
}
