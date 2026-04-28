#!/usr/bin/env node
// Throwaway test harness for PIN-5774 PR 1 — plays the role of the Tauri
// callback listener so you can drive the /openit/connect web flow end-to-end
// before PR 2 lands.
//
// Usage:
//   node scripts/test-cloud-connect.mjs                       # vs. http://localhost:5173
//   node scripts/test-cloud-connect.mjs http://localhost:3000 # vs. a different port
//   node scripts/test-cloud-connect.mjs https://dev20.pinkfish.dev

import http from 'node:http';
import { randomUUID } from 'node:crypto';

const state = randomUUID();
const webHost = process.argv[2] || 'http://localhost:5173';

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const params = Object.fromEntries(new URLSearchParams(body));
    if (params.state !== state) {
      console.error(`✗ state mismatch: ${params.state} != ${state}`);
      res.writeHead(400).end('state mismatch');
      return;
    }
    console.log('\n✓ Got creds:\n');
    console.log(JSON.stringify(params, null, 2));
    console.log('\n--- export for curl test ---');
    console.log(`export CLIENT_ID='${params.client_id}'`);
    console.log(`export CLIENT_SECRET='${params.client_secret}'`);
    console.log(`export ORG_ID='${params.org_id}'`);
    console.log(`export TOKEN_URL='${params.token_url}'`);
    res
      .writeHead(200, { 'Content-Type': 'text/html' })
      .end('<h1>OK — you can close this tab.</h1>');
    setTimeout(() => server.close(() => process.exit(0)), 200);
  });
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  const cb = `http://127.0.0.1:${port}/cb`;
  const url = `${webHost}/openit/connect?cb=${encodeURIComponent(cb)}&state=${state}&name=test-machine`;
  console.log('Listener bound to', cb);
  console.log('\nOpen this URL in your browser:\n');
  console.log('  ' + url + '\n');
  console.log('Waiting for callback…');
});
