#!/usr/bin/env node
// slack-send-intro.mjs — DM the OpenIT bot's intro message to a
// Slack user identified by email.
//
// Invoked by the connect-slack skill on the `verify` step. Reads the
// running app's intake-server URL from `.openit/intake.json`, then
// POSTs to `/skill/slack-send-intro`. The intake server uses the
// active listener's bot token to call Slack's users.lookupByEmail
// + chat.postMessage.
//
// Usage:
//   node .claude/scripts/slack-send-intro.mjs --email <slack-user-email>
//   node .claude/scripts/slack-send-intro.mjs --email <email> --text "hello"
//
// Output (one JSON line on stdout):
//   {"ok": true}
//   {"ok": false, "error": "..."}

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { flash } from "./_flash.mjs";

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function fail(msg) {
  emit({ ok: false, error: msg });
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--email" || a === "-e") out.email = argv[++i];
    else if (a === "--text" || a === "-t") out.text = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.email || !args.email.includes("@")) {
  fail("missing --email <user@domain>");
}

// `.openit/intake.json` lives at the repo root. Plugin scripts run
// from cwd = the project folder (Claude Bash is invoked from the
// project), so the relative path is stable.
const intakeFile = resolve(process.cwd(), ".openit", "intake.json");

let intakeUrl;
try {
  const raw = await readFile(intakeFile, "utf8");
  intakeUrl = JSON.parse(raw).url;
  if (!intakeUrl || typeof intakeUrl !== "string") {
    throw new Error("intake.json has no usable `url` field");
  }
} catch (e) {
  fail(`could not read intake URL from ${intakeFile}: ${e?.message ?? e}`);
}

let res;
try {
  res = await fetch(`${intakeUrl.replace(/\/+$/, "")}/skill/slack-send-intro`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: args.email, text: args.text ?? null }),
  });
} catch (e) {
  fail(`request failed: ${e?.message ?? e}`);
}

let body;
try {
  body = await res.json();
} catch {
  fail(`server returned non-JSON (status ${res.status})`);
}

if (!res.ok || !body?.ok) {
  fail(body?.error ?? `server returned status ${res.status}`);
}
await flash(`✉️ Intro DM sent to ${args.email}`);
emit({ ok: true });
