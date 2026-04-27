#!/usr/bin/env node
// sync-push.mjs — ask the running OpenIT app to push every bidirectional
// entity (KB, filestore, datastore) to Pinkfish.
//
// Usage:
//   node .claude/scripts/sync-push.mjs [--timeout <seconds>]
//
// How it works:
//   This script can't push directly — pushes need OAuth creds that live
//   in the OS keychain and are only loaded into memory by the OpenIT
//   app. Instead, the script writes `.openit/push-request.json` and
//   polls `.openit/push-result.json`. The running OpenIT app has an fs
//   watcher subscribed to those paths; when the request appears it
//   runs `pushAllEntities` and writes the result file. The script
//   reads the result, prints a JSON summary to stdout, and exits.
//
// When to call this:
//   After resolving conflicts (running sync-resolve-conflict.mjs for
//   each one), and only after explicit user confirmation. The conflict
//   prompt walks Claude through this.
//
// Requirements:
//   - OpenIT must be running. If it isn't, the marker sits on disk and
//     this script times out with `app_not_running`.
//
// Exit codes:
//   0 — push completed (status: ok)
//   1 — push reported an error or the script timed out
//
// cwd: the OpenIT project root (`~/OpenIT/<orgId>/`).

import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const REQUEST_FILE = ".openit/push-request.json";
const RESULT_FILE = ".openit/push-result.json";
const POLL_INTERVAL_MS = 250;
const DEFAULT_TIMEOUT_SEC = 60;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--timeout") out.timeoutSec = Number(argv[++i]);
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function fail(code, message) {
  emit({ ok: false, error: { code, message } });
  process.exit(1);
}

async function ensureDirFor(filePath) {
  await mkdir(path.dirname(filePath), { recursive: true });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write("Usage: sync-push.mjs [--timeout <seconds>]\n");
    process.exit(0);
  }
  const timeoutSec = Number.isFinite(args.timeoutSec) && args.timeoutSec > 0
    ? args.timeoutSec
    : DEFAULT_TIMEOUT_SEC;

  const requestPath = path.resolve(process.cwd(), REQUEST_FILE);
  const resultPath = path.resolve(process.cwd(), RESULT_FILE);

  // Clear any stale result from a previous run so our poll only sees
  // a result that came from this request.
  if (existsSync(resultPath)) {
    try {
      await unlink(resultPath);
    } catch (e) {
      fail("stale_result_unlink_failed", `Could not remove stale ${RESULT_FILE}: ${e.message}`);
    }
  }

  // Write the request marker.
  await ensureDirFor(requestPath);
  const requestPayload = {
    requestedAt: new Date().toISOString(),
    pid: process.pid,
  };
  try {
    await writeFile(requestPath, JSON.stringify(requestPayload, null, 2));
  } catch (e) {
    fail("write_request_failed", `Could not write ${REQUEST_FILE}: ${e.message}`);
  }

  // Poll for the result.
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    if (existsSync(resultPath)) {
      let result;
      try {
        result = JSON.parse(await readFile(resultPath, "utf8"));
      } catch (e) {
        fail("read_result_failed", `Could not parse ${RESULT_FILE}: ${e.message}`);
      }
      // Tidy up the result file so the next request starts clean.
      try {
        await unlink(resultPath);
      } catch {
        // best-effort
      }
      if (result.status === "ok") {
        emit({ ok: true, status: "ok", lines: result.lines ?? [] });
        return;
      } else {
        emit({ ok: false, status: "error", error: result.error, lines: result.lines ?? [] });
        process.exit(1);
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }

  // Timed out — most likely OpenIT isn't running. Tidy the request so
  // a stale marker doesn't trigger a push when the app starts later.
  try {
    if (existsSync(requestPath)) await unlink(requestPath);
  } catch {
    // best-effort
  }
  fail(
    "app_not_running",
    `OpenIT did not pick up the push request within ${timeoutSec}s. Is the app running? You can also click "Sync to Pinkfish" in the Sync tab.`,
  );
}

main().catch((e) => fail("unhandled", String(e?.stack ?? e)));
