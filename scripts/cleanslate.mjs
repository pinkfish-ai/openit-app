#!/usr/bin/env node
// Wipe local OpenIT state for a clean-slate dev test:
//   1. Tauri app_data state at ~/Library/Application Support/<id>/state.json
//      (holds last_repo + onboarding_complete — auto-rebinds on relaunch).
//   2. The repo workspace pointed at by state.json's last_repo.
//   3. macOS keychain entries under service `ai.pinkfish.openit`. Stale
//      entries are bound to the previous binary's ACL — leaving them
//      behind triggers the "openit-app wants to use your confidential
//      information" prompt on next launch (see src-tauri/scripts/README.md).
//
// Dev creds (.env.development) are NOT touched — toggle those with
// `npm run devmode -- off` if you want to land on the connect screen.
// Cloud-side `openit-*` collections are NOT touched — run
// `npm run clear-cloud-slate` for that.
//
// Usage:
//   npm run cleanslate

import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const TAURI_IDENT = "ai.pinkfish.openit";
const STATE_PATH = join(
  homedir(),
  "Library",
  "Application Support",
  TAURI_IDENT,
  "state.json",
);

const step = (msg) => console.log(`▸ ${msg}`);
const skip = (msg) => console.log(`  ${msg}`);

let workspace = null;
if (existsSync(STATE_PATH)) {
  try {
    const state = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    if (typeof state.last_repo === "string" && state.last_repo.length > 0) {
      workspace = state.last_repo;
    }
  } catch (e) {
    skip(`could not parse state.json: ${e.message} — continuing`);
  }
}

if (workspace && existsSync(workspace)) {
  step(`removing workspace: ${workspace}`);
  rmSync(workspace, { recursive: true, force: true });
} else if (workspace) {
  skip(`workspace ${workspace} already gone`);
} else {
  skip(`no workspace path in state.json — skipping workspace wipe`);
}

if (existsSync(STATE_PATH)) {
  step(`removing tauri state: ${STATE_PATH}`);
  rmSync(STATE_PATH, { force: true });
} else {
  skip(`tauri state already gone (${STATE_PATH})`);
}

// Drain every generic-password entry under the OpenIT service. `security
// delete-generic-password -s <svc>` removes one matching entry per call,
// so loop until it reports "not found" (exit code 44 / 36 depending on
// macOS version, or any non-zero with no match printed).
let removed = 0;
while (true) {
  const r = spawnSync("security", ["delete-generic-password", "-s", TAURI_IDENT], {
    encoding: "utf8",
  });
  if (r.status === 0) {
    removed += 1;
    continue;
  }
  break;
}
if (removed > 0) {
  step(`removed ${removed} keychain entr${removed === 1 ? "y" : "ies"} for ${TAURI_IDENT}`);
} else {
  skip(`no keychain entries to remove for ${TAURI_IDENT}`);
}

console.log();
console.log("Local clean. Reminder: cloud-side `openit-*` collections still");
console.log("exist in your dev org. Run `npm run clear-cloud-slate` to wipe");
console.log("them so the seed gates fire from scratch.");
