// Slack listener — local-only V1.
//
// Long-lived process supervised by the Tauri shell (Phase 2). For
// Phase 1, runs standalone via:
//
//   OPENIT_REPO=/abs/path/to/project \
//   OPENIT_INTAKE_URL=http://127.0.0.1:54123 \
//   OPENIT_SLACK_BOT_TOKEN=xoxb-... \
//   OPENIT_SLACK_APP_TOKEN=xapp-... \
//   OPENIT_SLACK_WORKSPACE_ID=T0... \
//   OPENIT_SLACK_BOT_USER_ID=U0... \
//   [OPENIT_SLACK_ALLOWED_DOMAINS=acme.com,foo.com] \
//   node slack-listen.bundle.cjs
//
// What it does:
//
//   Inbound:   message.im → ack immediately → enqueue → worker drains
//              → trust gates → POST /chat/start (fresh or with
//              resume_ticket_id) and/or POST /chat/turn → reply via
//              chat.postMessage. Stale-session 404 is handled by
//              calling /chat/start with resume_ticket_id and retrying
//              the turn once.
//
//   Egress:    every 2s, walk databases/conversations/<ticketId>/ for
//              every ticket in the delivery ledger, post any new
//              admin turns past the per-ticket high watermark.
//
//   State:     persisted under .openit/slack-sessions.json and
//              .openit/slack-delivery.json (atomic write-temp+rename).
//              Loaded on startup so a listener restart resumes
//              cleanly without forking tickets or re-blasting replies.
//
// What it does NOT do (V1):
//
//   - Channel mentions (DM-only).
//   - Slash commands, Block Kit, threads.
//   - Bot-loop replays of missed DMs (Socket Mode does not buffer).

import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { promises as fs } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Env + constants
// ---------------------------------------------------------------------------

const REPO = mustEnv("OPENIT_REPO");
const INTAKE_URL = mustEnv("OPENIT_INTAKE_URL").replace(/\/+$/, "");
const BOT_TOKEN = mustEnv("OPENIT_SLACK_BOT_TOKEN");
const APP_TOKEN = mustEnv("OPENIT_SLACK_APP_TOKEN");
const WORKSPACE_ID = mustEnv("OPENIT_SLACK_WORKSPACE_ID");
const BOT_USER_ID = mustEnv("OPENIT_SLACK_BOT_USER_ID");
const ALLOWED_DOMAINS = (process.env.OPENIT_SLACK_ALLOWED_DOMAINS ?? "")
  .split(",")
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

const STATE_DIR = path.join(REPO, ".openit");
const SESSIONS_PATH = path.join(STATE_DIR, "slack-sessions.json");
const DELIVERY_PATH = path.join(STATE_DIR, "slack-delivery.json");

const SESSION_REUSE_MS = 6 * 60 * 60 * 1000; // 6h matches intake server LRU
const RESUME_DEFENSIVE_MS = 30 * 60 * 1000; // 30min after eviction
const EGRESS_INTERVAL_MS = 2_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const WORKER_CONCURRENCY = 4;
const SLACK_REPLY_PROMPT_EMAIL =
  "Hi! I'm the OpenIT triage bot. To file your ticket I just need your work email — what is it?";
const SLACK_REPLY_BAD_EMAIL =
  "Hmm, that doesn't look like an email address. Could you send just your work email (e.g. you@company.com)?";

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

function mustEnv(k) {
  const v = process.env[k];
  if (!v || !v.trim()) {
    console.error(`[slack-listen] missing required env var: ${k}`);
    process.exit(2);
  }
  return v.trim();
}

// ---------------------------------------------------------------------------
// On-disk state — sessions and delivery ledger.
//
// sessions[slack_user_id] is one of two shapes:
//
//   { state: "pending_email", channel_id, original_message }
//     We DM'd the user "what's your work email?" and are waiting for
//     their reply. Their next message becomes the email; the
//     `original_message` is replayed as the first ticket turn.
//
//   { state: "active", session_id, ticket_id, channel_id,
//     last_seen_ms, email }
//     A live session keyed by intake server's session_id, scoped to a
//     single ticket. Reused across DMs while last_seen_ms < 6h ago.
//
// delivery[ticket_id] = { last_delivered_msg_id, channel_id }
//   Per-ticket egress watermark. last_delivered_msg_id is the
//   highest msg-<unix-ms>-<rand> id we've sent to Slack. Strictly
//   monotonic since msg ids embed unix-ms.
// ---------------------------------------------------------------------------

let sessions = {};
let delivery = {};
const writeMutex = { busy: false, queued: false };

async function loadState() {
  await fs.mkdir(STATE_DIR, { recursive: true });
  try {
    sessions = JSON.parse(await fs.readFile(SESSIONS_PATH, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error(`[slack-listen] sessions load failed (resetting): ${err.message}`);
    }
    sessions = {};
  }
  try {
    delivery = JSON.parse(await fs.readFile(DELIVERY_PATH, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error(`[slack-listen] delivery load failed (resetting): ${err.message}`);
    }
    delivery = {};
  }
  // Defensive watermark init: for any ticket in the delivery ledger
  // without a `last_delivered_msg_id`, scan its conversation
  // directory and snap the watermark to the latest admin turn so we
  // don't re-blast historical replies.
  for (const [ticketId, entry] of Object.entries(delivery)) {
    if (entry.last_delivered_msg_id) continue;
    const id = await latestAdminMsgId(ticketId);
    if (id) {
      entry.last_delivered_msg_id = id;
    }
  }
  await persistAll();
}

async function persistAll() {
  // Coalesce concurrent writes — if a write is in flight, mark a
  // second one queued; that write picks up the latest in-memory
  // state when it runs.
  if (writeMutex.busy) {
    writeMutex.queued = true;
    return;
  }
  writeMutex.busy = true;
  try {
    await atomicWriteJson(SESSIONS_PATH, sessions);
    await atomicWriteJson(DELIVERY_PATH, delivery);
  } finally {
    writeMutex.busy = false;
    if (writeMutex.queued) {
      writeMutex.queued = false;
      // Tail-call style — re-enter to flush the latest state.
      setImmediate(() => persistAll().catch(logErr));
    }
  }
}

async function atomicWriteJson(filePath, data) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, filePath);
}

async function latestAdminMsgId(ticketId) {
  const dir = path.join(REPO, "databases", "conversations", ticketId);
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  let best = null;
  for (const name of entries) {
    if (!name.startsWith("msg-") || !name.endsWith(".json")) continue;
    if (name.includes(".server.")) continue; // sync conflict shadow
    try {
      const raw = await fs.readFile(path.join(dir, name), "utf8");
      const msg = JSON.parse(raw);
      if (msg.role !== "admin") continue;
      if (!best || (msg.id ?? "") > best) best = msg.id ?? null;
    } catch {
      /* ignore unreadable */
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Intake server HTTP wrappers
// ---------------------------------------------------------------------------

async function intakePost(pathname, body) {
  const res = await fetch(`${INTAKE_URL}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // The intake server gates every endpoint on Origin/Referer
      // being a localhost host. We're loopback, so this is honest.
      origin: "http://localhost",
    },
    body: JSON.stringify(body),
  });
  return res;
}

async function chatStart({ email, transport, resumeTicketId }) {
  const body = { email, transport };
  if (resumeTicketId) body.resume_ticket_id = resumeTicketId;
  const res = await intakePost("/chat/start", body);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`/chat/start ${res.status}: ${text}`);
  }
  return await res.json(); // { session_id, ticket_id }
}

async function chatTurn({ sessionId, message }) {
  const res = await intakePost("/chat/turn", {
    session_id: sessionId,
    message,
  });
  return res; // caller handles 404 specifically
}

// ---------------------------------------------------------------------------
// Slack clients
// ---------------------------------------------------------------------------

const web = new WebClient(BOT_TOKEN);
const sock = new SocketModeClient({ appToken: APP_TOKEN });

async function postSlack(channel, text) {
  await web.chat.postMessage({ channel, text });
}

// ---------------------------------------------------------------------------
// Trust gates
//
// Block bots, externals, and guests. Domain allowlist applies only
// to full members and never re-allows a guest or external. See plan
// "Trust model" section for rationale.
// ---------------------------------------------------------------------------

function eventIsBot(event) {
  if (event.bot_id) return true;
  if (event.subtype === "bot_message") return true;
  if (event.user === BOT_USER_ID) return true;
  return false;
}

async function userPassesTrustGates(slackUserId) {
  let info;
  try {
    const res = await web.users.info({ user: slackUserId });
    info = res.user;
  } catch (err) {
    console.error(`[slack-listen] users.info failed for ${slackUserId}: ${err.message}`);
    return { ok: false, reason: "users.info failed" };
  }
  if (!info) return { ok: false, reason: "no user info" };
  if (info.is_bot) return { ok: false, reason: "is_bot" };
  if (info.is_stranger) return { ok: false, reason: "is_stranger" };
  if (info.is_restricted || info.is_ultra_restricted) {
    return { ok: false, reason: "is_guest" };
  }
  if (info.team_id && info.team_id !== WORKSPACE_ID) {
    return { ok: false, reason: "wrong_workspace" };
  }
  const email = info.profile?.email ?? null;
  if (ALLOWED_DOMAINS.length > 0) {
    if (!email) return { ok: false, reason: "no_email_for_domain_check" };
    const domain = email.split("@").pop()?.toLowerCase() ?? "";
    if (!ALLOWED_DOMAINS.includes(domain)) {
      return { ok: false, reason: "domain_not_allowed" };
    }
  }
  return { ok: true, email };
}

// ---------------------------------------------------------------------------
// Defensive resume: walk databases/tickets/ for a Slack ticket whose
// asker matches `email` and whose updatedAt is within the
// RESUME_DEFENSIVE_MS window. If found, returns its ticket id.
//
// This covers the case where the in-memory session_id was lost (app
// restart, listener crash) and `slack-sessions.json` was missing
// the user's row, but the user is mid-conversation. Without this,
// a brief outage would fork the conversation into a fresh ticket.
// ---------------------------------------------------------------------------

async function findRecentSlackTicketForEmail(email, slackUserId) {
  const dir = path.join(REPO, "databases", "tickets");
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }
  const cutoffMs = Date.now() - RESUME_DEFENSIVE_MS;
  let bestId = null;
  let bestUpdatedMs = 0;
  for (const name of entries) {
    if (!name.endsWith(".json") || name === "_schema.json") continue;
    try {
      const raw = await fs.readFile(path.join(dir, name), "utf8");
      const t = JSON.parse(raw);
      if (t.askerChannel !== "slack") continue;
      if (t.asker !== email) continue;
      if (t.slackUserId && t.slackUserId !== slackUserId) continue;
      const updatedMs = Date.parse(t.updatedAt ?? "");
      if (!Number.isFinite(updatedMs) || updatedMs < cutoffMs) continue;
      if (updatedMs > bestUpdatedMs) {
        bestUpdatedMs = updatedMs;
        bestId = name.replace(/\.json$/, "");
      }
    } catch {
      /* ignore */
    }
  }
  return bestId;
}

// ---------------------------------------------------------------------------
// Inbound queue + worker pool
//
// Slack Socket Mode requires acks within ~3s or the event is
// retried (causing duplicate tickets and replies). The handler
// acks immediately and enqueues; workers drain the queue and do
// the slow `claude -p` round-trip out-of-band.
// ---------------------------------------------------------------------------

const queue = [];
let activeWorkers = 0;
let stopping = false;

function enqueue(job) {
  if (stopping) return;
  queue.push(job);
  pumpWorkers();
}

function pumpWorkers() {
  while (activeWorkers < WORKER_CONCURRENCY && queue.length > 0) {
    const job = queue.shift();
    activeWorkers += 1;
    Promise.resolve()
      .then(() => job())
      .catch(logErr)
      .finally(() => {
        activeWorkers -= 1;
        if (queue.length > 0) pumpWorkers();
      });
  }
}

async function handleMessageIm(event) {
  if (eventIsBot(event)) return;
  if (event.team && event.team !== WORKSPACE_ID) return;
  if (!event.user || !event.channel) return;
  if (!event.text || !event.text.trim()) return; // file_share-only etc.

  const slackUserId = event.user;
  const channelId = event.channel;
  const text = event.text.trim();

  // Trust gate (also resolves email).
  const gate = await userPassesTrustGates(slackUserId);
  if (!gate.ok) {
    console.error(
      `[slack-listen] dropped event from ${slackUserId} (${gate.reason})`,
    );
    return;
  }

  const session = sessions[slackUserId];
  const nowMs = Date.now();

  // Pending-email state: this DM is the user's email reply.
  if (session?.state === "pending_email") {
    const match = text.match(EMAIL_RE);
    if (!match) {
      await postSlack(channelId, SLACK_REPLY_BAD_EMAIL);
      return;
    }
    const email = match[0].toLowerCase();
    await startSessionAndDeliver({
      slackUserId,
      channelId,
      email,
      firstMessage: session.original_message,
    });
    return;
  }

  // Active session within the 6h reuse window — route as turn.
  if (session?.state === "active" && nowMs - session.last_seen_ms < SESSION_REUSE_MS) {
    await deliverTurn({ slackUserId, message: text });
    return;
  }

  // Fresh start. Either no session, or the last one is stale.
  // Email comes from users.info (already resolved by trust gate)
  // or, if absent, we ask for it and stash the message.
  if (!gate.email) {
    sessions[slackUserId] = {
      state: "pending_email",
      channel_id: channelId,
      original_message: text,
    };
    await persistAll();
    await postSlack(channelId, SLACK_REPLY_PROMPT_EMAIL);
    return;
  }

  await startSessionAndDeliver({
    slackUserId,
    channelId,
    email: gate.email,
    firstMessage: text,
  });
}

async function startSessionAndDeliver({
  slackUserId,
  channelId,
  email,
  firstMessage,
}) {
  // Defensive resume: if the user has a recent slack ticket on disk
  // (e.g. listener crashed and lost its session row, but disk
  // remembers), continue the existing thread.
  const resumeId = await findRecentSlackTicketForEmail(email, slackUserId);
  let started;
  try {
    started = await chatStart({
      email,
      transport: {
        kind: "slack",
        workspace_id: WORKSPACE_ID,
        channel_id: channelId,
        user_id: slackUserId,
      },
      resumeTicketId: resumeId,
    });
  } catch (err) {
    // 400 from resume validation → retry once without resume.
    if (resumeId && /\b400\b/.test(String(err.message))) {
      console.error(
        `[slack-listen] resume rejected (${err.message}); starting fresh ticket`,
      );
      started = await chatStart({
        email,
        transport: {
          kind: "slack",
          workspace_id: WORKSPACE_ID,
          channel_id: channelId,
          user_id: slackUserId,
        },
      });
    } else {
      throw err;
    }
  }

  sessions[slackUserId] = {
    state: "active",
    session_id: started.session_id,
    ticket_id: started.ticket_id,
    channel_id: channelId,
    last_seen_ms: Date.now(),
    email,
  };
  if (!delivery[started.ticket_id]) {
    delivery[started.ticket_id] = {
      last_delivered_msg_id: null,
      channel_id: channelId,
    };
  } else {
    // Channel can change if the user opened a fresh DM — refresh it.
    delivery[started.ticket_id].channel_id = channelId;
  }
  await persistAll();

  await deliverTurn({ slackUserId, message: firstMessage });
}

async function deliverTurn({ slackUserId, message }) {
  const sess = sessions[slackUserId];
  if (!sess || sess.state !== "active") {
    console.error(`[slack-listen] deliverTurn called without active session for ${slackUserId}`);
    return;
  }
  const reply = await runTurnWithRetry({ slackUserId, message });
  if (reply == null) return;
  sessions[slackUserId].last_seen_ms = Date.now();
  await persistAll();
  await postSlack(sess.channel_id, reply);
}

async function runTurnWithRetry({ slackUserId, message }) {
  const sess = sessions[slackUserId];
  let res = await chatTurn({ sessionId: sess.session_id, message });

  // Stale session_id (intake server restarted, or LRU-evicted).
  // Re-start with resume_ticket_id and retry once.
  if (res.status === 404) {
    console.error(
      `[slack-listen] session ${sess.session_id} unknown (404); resuming on ticket ${sess.ticket_id}`,
    );
    let restarted;
    try {
      restarted = await chatStart({
        email: sess.email,
        transport: {
          kind: "slack",
          workspace_id: WORKSPACE_ID,
          channel_id: sess.channel_id,
          user_id: slackUserId,
        },
        resumeTicketId: sess.ticket_id,
      });
    } catch (err) {
      console.error(`[slack-listen] resume after 404 failed: ${err.message}`);
      return null;
    }
    sessions[slackUserId].session_id = restarted.session_id;
    await persistAll();
    res = await chatTurn({
      sessionId: restarted.session_id,
      message,
    });
    if (res.status === 404) {
      console.error(`[slack-listen] second 404 after resume — dropping turn`);
      return null;
    }
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(`[slack-listen] /chat/turn ${res.status}: ${text}`);
    return null;
  }
  const json = await res.json();
  return json.reply ?? "";
}

// ---------------------------------------------------------------------------
// Egress polling — admin replies → Slack
// ---------------------------------------------------------------------------

async function egressTick() {
  for (const [ticketId, entry] of Object.entries(delivery)) {
    try {
      await drainTicket(ticketId, entry);
    } catch (err) {
      console.error(`[slack-listen] egress drain failed for ${ticketId}: ${err.message}`);
    }
  }
}

async function drainTicket(ticketId, entry) {
  const dir = path.join(REPO, "databases", "conversations", ticketId);
  let names;
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }
  // Filter + sort by id (monotonic since unix-ms is the prefix).
  const candidates = names
    .filter((n) => n.startsWith("msg-") && n.endsWith(".json") && !n.includes(".server."))
    .sort();
  let high = entry.last_delivered_msg_id ?? "";
  let updated = false;
  for (const name of candidates) {
    let msg;
    try {
      msg = JSON.parse(await fs.readFile(path.join(dir, name), "utf8"));
    } catch {
      continue;
    }
    if (msg.role !== "admin") continue;
    const id = msg.id ?? "";
    if (id <= high) continue;
    try {
      await postSlack(entry.channel_id, msg.body ?? "");
      high = id;
      entry.last_delivered_msg_id = id;
      updated = true;
      // Persist after each delivery — strictly monotonic, never
      // re-deliver on crash even if we crash between two messages.
      await persistAll();
    } catch (err) {
      console.error(
        `[slack-listen] postMessage failed for ticket ${ticketId} msg ${id}: ${err.message}`,
      );
      break; // try again next tick rather than skipping ahead
    }
  }
  if (updated) {
    /* persisted incrementally above */
  }
}

// ---------------------------------------------------------------------------
// Heartbeat — JSON line on stderr the Tauri supervisor parses
// ---------------------------------------------------------------------------

function heartbeat() {
  const payload = {
    ok: true,
    ts: new Date().toISOString(),
    sessions: Object.keys(sessions).length,
    open_tickets: Object.keys(delivery).length,
    queue_depth: queue.length,
    workers: activeWorkers,
  };
  console.error(JSON.stringify(payload));
}

// ---------------------------------------------------------------------------
// Boot + lifecycle
// ---------------------------------------------------------------------------

function logErr(err) {
  console.error(`[slack-listen] worker error: ${err?.stack ?? err}`);
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.error(`[slack-listen] received ${signal}; draining…`);
  // Drain inbound queue — wait up to 5s for in-flight workers.
  const deadline = Date.now() + 5_000;
  while ((queue.length > 0 || activeWorkers > 0) && Date.now() < deadline) {
    await sleep(100);
  }
  try {
    await sock.disconnect();
  } catch (err) {
    console.error(`[slack-listen] disconnect failed: ${err.message}`);
  }
  await persistAll();
  process.exit(0);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  await loadState();

  sock.on("message", async ({ event, ack }) => {
    // Ack first — always, fast — then enqueue.
    try {
      await ack();
    } catch (err) {
      console.error(`[slack-listen] ack failed: ${err.message}`);
    }
    // Some `message` envelope subtypes (channel_join, etc.) come
    // through too; we only handle plain DMs.
    if (!event || event.channel_type !== "im") return;
    if (event.subtype && event.subtype !== "file_share") return;
    enqueue(() => handleMessageIm(event));
  });

  sock.on("disconnect", () => {
    console.error(`[slack-listen] socket disconnected (will auto-retry)`);
  });
  sock.on("error", (err) => {
    console.error(`[slack-listen] socket error: ${err?.message ?? err}`);
  });

  await sock.start();
  // The SDK's start() resolves once the websocket is up. Log a
  // recognizable line so the Tauri supervisor (Phase 2) can detect
  // ready state without polling Slack.
  console.error(`[slack-listen] socket-mode connected`);

  setInterval(() => egressTick().catch(logErr), EGRESS_INTERVAL_MS).unref();
  setInterval(heartbeat, HEARTBEAT_INTERVAL_MS).unref();

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(`[slack-listen] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});
