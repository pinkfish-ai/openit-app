#!/usr/bin/env node
// slack-copy-manifest.mjs — copy the Slack app manifest YAML to the
// macOS clipboard so the user can paste it into
// https://api.slack.com/apps → Create New App → From an app manifest.
//
// Invoked by the connect-slack skill on the `create-app` step. Pure
// Node + system pbcopy — no Tauri / IPC. Reads the YAML from
// `.claude/scripts/slack-manifest.yml` (mirrored by the plugin manifest
// from openit-plugin/scripts/slack-manifest.yml in this repo).
//
// Output: a single JSON line on stdout, either
//   {"ok": true, "bytes": <n>}
// or
//   {"ok": false, "error": "<reason>"}
// so Claude can branch on it.

import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { flash } from "./_flash.mjs";

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function pbcopy(text) {
  return new Promise((resolveP, reject) => {
    if (process.platform !== "darwin") {
      reject(new Error(`clipboard copy not supported on ${process.platform}`));
      return;
    }
    const child = spawn("pbcopy");
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolveP();
      else reject(new Error(`pbcopy exited with code ${code}`));
    });
    child.stdin.end(text, "utf8");
  });
}

try {
  const here = dirname(fileURLToPath(import.meta.url));
  const yamlPath = resolve(here, "slack-manifest.yml");
  const yaml = await readFile(yamlPath, "utf8");
  await pbcopy(yaml);
  await flash("📋 Slack manifest copied to clipboard");
  emit({ ok: true, bytes: Buffer.byteLength(yaml, "utf8") });
} catch (e) {
  emit({ ok: false, error: String(e?.message ?? e) });
  process.exit(1);
}
