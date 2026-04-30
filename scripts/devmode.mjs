#!/usr/bin/env node
// Toggle dev auto-connect creds on/off by renaming `.env.development` ↔
// `.env.development.bak`. The Vite-injected VITE_DEV_CLIENT_ID/SECRET/ORG_ID
// are what cause the app to skip the keychain and land pre-connected at
// every launch — disable them when you want to test the connect flow as
// a fresh user.
//
// Usage:
//   npm run devmode             # show current state
//   npm run devmode -- on       # enable (rename .env.development.bak → .env.development)
//   npm run devmode -- off      # disable (rename .env.development → .env.development.bak)

import { existsSync, renameSync } from "node:fs";

const ENV = ".env.development";
const BAK = ".env.development.bak";

const arg = (process.argv[2] || "").toLowerCase().replace(/^-+/, "");

const onPresent = existsSync(ENV);
const offPresent = existsSync(BAK);

function status() {
  if (onPresent && offPresent) {
    console.log("dev mode: ON (both files exist — .env.development is active)");
    console.log(`  active: ${ENV}`);
    console.log(`  shadow: ${BAK}`);
  } else if (onPresent) {
    console.log("dev mode: ON");
    console.log(`  ${ENV} present — app will auto-connect with dev creds`);
  } else if (offPresent) {
    console.log("dev mode: OFF");
    console.log(`  ${BAK} present — app will land on the connect screen`);
  } else {
    console.log("dev mode: not configured");
    console.log(`  neither ${ENV} nor ${BAK} present`);
    console.log(`  copy from .env.development.example and rerun`);
  }
}

if (!arg) {
  status();
  process.exit(0);
}

if (arg === "on") {
  if (onPresent) {
    console.log(`▸ already ON (${ENV} present)`);
  } else if (offPresent) {
    renameSync(BAK, ENV);
    console.log(`▸ enabled dev mode: ${BAK} → ${ENV}`);
  } else {
    console.error(`✗ cannot enable: neither ${ENV} nor ${BAK} present`);
    console.error(`  copy from .env.development.example and rerun`);
    process.exit(1);
  }
} else if (arg === "off") {
  if (offPresent && !onPresent) {
    console.log(`▸ already OFF (${BAK} present)`);
  } else if (onPresent) {
    if (offPresent) {
      console.error(`✗ both ${ENV} and ${BAK} exist — refusing to overwrite ${BAK}`);
      console.error(`  resolve manually then rerun`);
      process.exit(1);
    }
    renameSync(ENV, BAK);
    console.log(`▸ disabled dev mode: ${ENV} → ${BAK}`);
  } else {
    console.error(`✗ nothing to disable: ${ENV} not present`);
    process.exit(1);
  }
} else {
  console.error(`✗ unknown argument "${arg}"`);
  console.error(`  usage: npm run devmode [-- on|off]`);
  process.exit(1);
}
