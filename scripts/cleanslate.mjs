#!/usr/bin/env node
// Wipe local OpenIT state for a clean-slate dev test:
//   1. Tauri app_data state at ~/Library/Application Support/<id>/state.json
//      (holds last_repo + onboarding_complete — auto-rebinds on relaunch).
//   2. The repo workspace pointed at by state.json's last_repo.
//
// Dev creds (.env.development) are NOT touched — toggle those with
// `npm run devmode -- off` if you want to land on the connect screen.
// Cloud-side `openit-*` collections are NOT touched — delete those in the
// Pinkfish dashboard if you want the seed gates to fire from scratch.
//
// Usage:
//   npm run cleanslate

import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

console.log();
console.log("Local clean. Reminder: cloud-side `openit-*` collections still");
console.log("exist in your dev org. Delete them in the Pinkfish dashboard if");
console.log("you want the seed gates to fire from scratch:");
console.log("  • openit-tickets / openit-people / openit-conversations (datastore)");
console.log("  • openit-* knowledge bases / filestores (if you want a full reset)");
