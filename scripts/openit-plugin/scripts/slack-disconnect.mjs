#!/usr/bin/env node
// slack-disconnect.mjs — full Slack teardown for this project.
//
//   1. Kill any running OpenIT slack listener (the supervisor in
//      Tauri observes the exit and clears its state on its own).
//   2. Remove both bot/app tokens from macOS Keychain. The keychain
//      slots are scoped per orgId, derived from cwd's parent dir
//      basename (`~/OpenIT/<orgId>/` → orgId).
//   3. Delete the local pointer + ledger files under .openit/.
//   4. Clear the connect-slack skill side-channel so the next
//      `/connect-slack` starts fresh (no stale dock kind hanging
//      around).
//
// The Slack-side app at api.slack.com is NOT touched — it lives on
// Slack's servers and the user can leave it installed (idle) or
// delete it manually. Claude prints that follow-up next to the
// disconnect call.
//
// Usage: `node .claude/scripts/slack-disconnect.mjs`
//   (no args; orgId derived from cwd)
//
// Output (one JSON line on stdout):
//   {"ok": true, "removed": [...]}
//   {"ok": false, "error": "..."}

import { rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, resolve } from "node:path";
import { flash } from "./_flash.mjs";

const SERVICE = "ai.pinkfish.openit";
const LISTENER_PROC_PATTERN = "slack-listen.bundle.cjs";

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/// Run a command, resolving with the exit code (never rejects).
/// Used for `pkill` and `security delete-generic-password` where a
/// non-zero exit ("nothing matched") is fine — we want best-effort
/// cleanup, not strict failure.
function runOk(cmd, args) {
  return new Promise((resolveP) => {
    const child = spawn(cmd, args, { stdio: "ignore" });
    child.on("error", () => resolveP(null));
    child.on("close", (code) => resolveP(code));
  });
}

const removed = [];

// 1. Listener.
const pkillCode = await runOk("pkill", ["-f", LISTENER_PROC_PATTERN]);
if (pkillCode === 0) removed.push("listener-process");

// 2. Keychain. orgId mirrors slack.rs::bot_token_slot/app_token_slot:
// empty / undefined cred → "local" qualifier. Scripts always run with
// cwd = `~/OpenIT/<orgId>/`, so basename(cwd) is the orgId.
const orgId = basename(process.cwd()) || "local";
const botSlot = `slack:bot-token:${orgId}`;
const appSlot = `slack:app-token:${orgId}`;
for (const account of [botSlot, appSlot]) {
  const code = await runOk("security", [
    "delete-generic-password",
    "-s",
    SERVICE,
    "-a",
    account,
  ]);
  if (code === 0) removed.push(`keychain:${account}`);
}

// 3. Local files.
const filesToRemove = [
  ".openit/slack.json",
  ".openit/slack-sessions.json",
  ".openit/slack-delivery.json",
];
for (const rel of filesToRemove) {
  const abs = resolve(process.cwd(), rel);
  try {
    await rm(abs, { force: true });
    // `force: true` swallows "not found", so we can't tell whether
    // the file actually existed — but for the user-facing summary
    // it's fine to claim removal either way.
    removed.push(rel);
  } catch (e) {
    // Permissions, locked file, etc. — surface at the end.
    emit({ ok: false, error: `failed to remove ${rel}: ${e?.message ?? e}` });
    process.exit(1);
  }
}

// 4. Clear the dock side-channel so a future /connect-slack starts
// from scratch. Best-effort.
try {
  await rm(resolve(process.cwd(), ".openit/skill-state/connect-slack.json"), {
    force: true,
  });
  removed.push(".openit/skill-state/connect-slack.json");
} catch {
  // Non-fatal; the next /connect-slack just overwrites.
}

await flash("✓ Slack disconnected");
emit({ ok: true, removed });
