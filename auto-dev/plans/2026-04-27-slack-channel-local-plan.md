# Slack as a Local Channel — V1 Plan

**Date:** 2026-04-27
**Status:** Draft v2 (post-codex review)
**Author:** Claude (with Sankalp)

## Vision in one paragraph

Today, an OpenIT admin testing the helpdesk plays "employee" by opening the localhost intake URL in a browser and chatting. The vision: that same chat experience, but happening in **Slack DMs** to a Slack bot the admin has connected. Real employees DM the bot, the existing triage agent answers from the local KB or escalates, and admin replies (written in OpenIT via `answer-ticket`) are delivered back as Slack DMs. Everything runs **locally on the admin's machine** — no Pinkfish cloud needed. When the admin closes OpenIT, the bot goes offline; that's an acceptable V1 trade-off because OpenIT is positioned as scaffolding the admin tests against, not a 24/7 cloud service. Cloud-promotion is a future Pinkfish upsell explicitly out of scope here.

## Scope

### In V1

- A `/connect-slack` admin-facing skill that walks the admin through creating a Slack app (manifest-paste pattern), capturing tokens, and verifying roundtrip.
- A long-lived **Slack listener** (Node, Socket Mode) supervised by the Tauri shell — auto-starts when the project has a Slack config, stops when the project closes.
- **DM-only.** Inbound DMs become turns on the existing intake server. Outbound: admin's `answer-ticket` reply turns are DMed back to the asker.
- `askerChannel: "slack"` tickets get full inbound + egress wiring (mirrors `chat`).
- Token storage in macOS Keychain via existing `keychain.rs` (other OSes deferred — see open questions).

### Out of V1

- Channel mentions, slash commands, threads, Block Kit interactivity, approvals, streaming previews.
- Multi-workspace install (one Slack workspace per OpenIT project).
- Promote-to-cloud (Pinkfish hosted listener) — separate future plan.
- External / shared-channel users (explicitly blocked at the listener — see Trust model).

---

## The IT admin experience

The admin already has OpenIT running locally with a project. From the desktop Claude pane, they type `/connect-slack`. The skill is conversational — one step at a time, confirm, advance — same shape as `connect-to-cloud.md`.

### Step 0 — Setup gate

Skill detects whether `.openit/slack.json` exists. If yes and the listener reports healthy, skill says "you're already connected as `<bot-name>` in `<workspace>`. Reset?" and exits unless told otherwise.

### Step 1 — Slack workspace check

> "Do you have a Slack workspace where you want this bot to live? You'll need to be a workspace admin or have permission to install apps."

If not, point them at `slack.com/get-started` and stop.

### Step 2 — Create the app from manifest

Skill prints a **YAML manifest** (full text, copy-pasteable, embedded in the skill file) and guides:

> "1. Open https://api.slack.com/apps → **Create New App** → **From an app manifest**.
> 2. Pick your workspace.
> 3. Paste this manifest, click Next, then Create."

The manifest declares:
- Bot name: `OpenIT`
- Bot scopes: `chat:write`, `im:history`, `im:read`, `im:write`, `users:read`, `users:read.email`, `team:read`
- Subscribed bot events: `message.im`
- Socket Mode: enabled
- No slash commands, no interactivity, no public webhooks, no `app_mentions:read`, no channel scopes

### Step 3 — Install + grab the bot token

> "Click **Install to Workspace**, approve. Then **OAuth & Permissions** → copy the **Bot User OAuth Token** (starts `xoxb-`). Paste here."

Skill validates the prefix and round-trips an `auth.test` to confirm the token works and capture `team_id`, `bot_user_id`.

### Step 4 — Generate the app-level token (Socket Mode)

> "Now **Basic Information → App-Level Tokens → Generate Token and Scopes**. Name it `socket`, add `connections:write`, Generate. Copy (`xapp-…`) and paste here."

Skill stores both tokens in keychain (`openit:<orgId>:slack:bot-token`, `openit:<orgId>:slack:app-token`) and writes a non-secret pointer file at `.openit/slack.json`:

```json
{
  "workspaceId": "T012ABCDE",
  "workspaceName": "Acme",
  "botUserId": "U098WXYZ",
  "botName": "OpenIT",
  "connectedAt": "2026-04-27T14:22:00Z",
  "allowedDomains": []
}
```

### Step 5 — Start the listener

Skill calls `slack_listener_start`. Tauri shell pulls tokens from keychain, spawns the bundled listener (see Dependency packaging), and returns once the listener has logged `"socket-mode connected"` (or times out).

### Step 6 — Verify roundtrip

Skill says:

> "Set. I'm asking the bot to DM you 'Hi, I'm the OpenIT triage bot — try asking me a question.' Open Slack, ask me anything (e.g. 'how do I reset my Mac password?'). Tell me when you've seen the reply."

Behind the scenes the skill calls a one-shot `slack_listener_send_intro` Tauri command that uses `chat.postMessage` to DM the admin's Slack user (resolved via `users.lookupByEmail` against the admin's email). Skill also includes a heads-up:

> "Two things to know: (1) the bot will treat *your own* DMs the same as any employee's — that's the point, you're testing the asker experience. (2) The bot only works while OpenIT is open on this machine; for now, anything DM'd while OpenIT is closed is not delivered or replayed."

Done — admin can tell teammates to DM `@OpenIT` for IT help.

### After connect

Next time the admin opens OpenIT, the Tauri shell sees `.openit/slack.json` exists and auto-starts the listener as part of project bootstrap (right after `intake_start`). A small "Slack: connected as @OpenIT" pill appears in the header next to the localhost intake pill, with status indicator and kill switch.

---

## Architecture

```
                    ┌────────────────────────┐
  Slack employee ──▶│  Slack (Socket Mode)   │
                    └───────────┬────────────┘
                                │ websocket (events)
                                ▼
                    ┌─────────────────────────────────┐
                    │ slack-listen (bundled Node)     │  long-lived,
                    │  ┌─────────────────────────┐    │  Tauri-supervised
                    │  │ event ack (immediate)   │    │
                    │  │ inbound queue ──────────┼─┐  │
                    │  │ egress polling loop ────┼─┤  │
                    │  └─────────────────────────┘ │  │
                    │  delivery ledger (.openit/)  │  │
                    │  session map (.openit/)      │  │
                    └──────────────────────────────┼──┘
                                                   │ HTTP (Origin: localhost)
                                                   ▼
                                       ┌────────────────────────┐
                                       │ axum intake server     │
                                       │ /chat/start (extended) │
                                       │ /chat/turn             │
                                       │ /chat/poll             │
                                       └───────────┬────────────┘
                                                   │ spawn
                                                   ▼
                                       ┌────────────────────────┐
                                       │ claude -p ai-intake    │  unchanged
                                       └────────────────────────┘
```

**Key idea:** the Slack listener is a *second transport* into the same intake server. No changes to `claude -p`, no changes to the `ai-intake` skill, no changes to the on-disk ticket/conversation/people layout. Slack DMs become indistinguishable from web-chat turns once they hit `/chat/turn`.

### Intake server contract changes (decided, not optional)

The listener doing a follow-up `Edit` on the ticket file to set `askerChannel: "slack"` is race-prone — `ensure_responding_stub` (intake.rs:1192) currently hardcodes `"askerChannel": "chat"` and would race with any post-write Edit. So we extend `/chat/start` to accept transport metadata and let `intake.rs` stamp the ticket directly:

```diff
 // POST /chat/start
 struct ChatStartReq {
     email: String,
+    // Optional. Defaults to "chat" (web intake) for backward compat.
+    // When present, the server stamps these onto the ticket on first
+    // turn instead of hardcoding "chat", and stores them on SessionData
+    // so subsequent turns retain provenance.
+    transport: Option<TransportMeta>,
+    // Optional. When present and points to an existing on-disk ticket,
+    // the server reuses that ticket id instead of generating a fresh
+    // one — used by the listener to resume Slack conversations across
+    // listener / app restarts. Server validates the file exists and
+    // belongs to the same email; rejects otherwise.
+    resume_ticket_id: Option<String>,
 }

+enum TransportMeta {
+    Slack {
+        workspace_id: String,
+        channel_id: String,   // the DM channel
+        user_id: String,      // the Slack user
+    },
+    // Future: Teams { ... }, Email { ... }, etc.
+}
```

`SessionData` grows a `transport: TransportMeta` field. `ensure_responding_stub` reads it and writes the right `askerChannel` + (for Slack) `slackWorkspaceId` / `slackChannelId` / `slackUserId` into the ticket on first turn. Idempotent on subsequent turns. No follow-up Edit from the listener. Default for the existing web chat is `Chat` (no metadata), so the on-the-wire payload from the browser client is unchanged.

### What the listener does

A bundled Node process (~400 lines) with five responsibilities:

**1. Immediate Slack event ack.**
Slack Socket Mode requires an ack within ~3s or it retries the event (causing duplicates). The listener acknowledges the moment the event lands, *before* doing any intake-server work. Pattern:

```
on('message') {
  ack();                                    // first thing, always
  inboundQueue.push({ event, receivedAt }); // then enqueue
}
```

A small worker pool (concurrency = 4) drains the queue. Slow `claude -p` turns never block the websocket.

**2. Inbound (Slack → intake server).**
For each queued event:
- **Filter:** ignore events from bots (`subtype: bot_message` or `bot_id` set, including our own). Ignore events from external/shared-channel users (`user.is_stranger` or `is_external`). Ignore guest accounts unless explicitly allowlisted.
- **Trust gate:** if `allowedDomains` is non-empty in `.openit/slack.json`, fetch the user's email via `users.info` and reject (with no reply) if the domain doesn't match.
- **Session lookup:** check the on-disk session map for `slack_user_id`. If present and `last_seen_unix` is < 6h old, route as `/chat/turn`. Otherwise call `/chat/start` (with `transport: Slack{...}` and, if there's a stale-but-recent ticket on disk for the same user inside a 30-min window, a `resume_ticket_id` to continue rather than fork).
- **Stale-session retry.** Persisted Slack `session_id`s outlive the intake server's in-memory session map. If `/chat/turn` returns `404 unknown session` (intake server restarted, or the session was idle-evicted server-side), the listener calls `/chat/start` with `resume_ticket_id` set to the on-disk ticket id, updates `.openit/slack-sessions.json` with the fresh `session_id`, and retries the turn once. Second 404 → drop with an error log; do not infinite-loop.
- Take the `reply` from the response, post back via `chat.postMessage` to the DM channel.
- Update the on-disk session map.

**3. Egress (admin reply → Slack) with durable de-dupe.**
Single polling loop covering all open Slack tickets:
- Every 2s, for each ticket in the on-disk delivery ledger, list `databases/conversations/<ticketId>/msg-*.json`.
- For each turn with `role: "admin"` whose `id` is past the ledger's high-watermark for that ticket, post via `chat.postMessage` to the saved `slackChannelId`, then advance the watermark.
- Watermark advancement is per-message-id (not just timestamp), so retries after restart correctly skip already-delivered turns.

**4. Persistence under `.openit/`.**
Two small JSON files, atomically written (write-temp + rename):

- `.openit/slack-sessions.json` — `{ slack_user_id: { session_id, ticket_id, last_seen_unix } }`. Loaded on startup. Lets a listener restart resume mid-conversation instead of forking a new ticket.
- `.openit/slack-delivery.json` — `{ ticket_id: { last_delivered_msg_id, channel_id } }`. Initialized on first egress for a ticket; updated after each successful `chat.postMessage`. On startup, for any ticket present here, the listener also reads existing conversation files and bumps the watermark to the latest delivered admin turn (defensive: if the ledger was lost, we don't re-blast a thread).

Both files are gitignored.

**5. Heartbeat + lifecycle.**
- Heartbeat to stderr every 30s (`{"ok":true,"sessions":N,"open_tickets":M,"queue_depth":Q}`).
- On SIGTERM, drain the inbound queue, close websocket, fsync ledgers, exit.
- Reconnect with exponential backoff on websocket drops (Slack SDK handles this; we surface state to Tauri via heartbeat).

### Trust model

Slack DMs let any Slack workspace user trigger a `claude -p` subprocess on the admin's machine. That's a real boundary; spell it out so the admin understands and can constrain it.

**Default V1 posture:**
- **Same workspace only.** Listener only handles events from the workspace declared in `.openit/slack.json`. Cross-workspace DM (Slack Connect) is rejected silently.
- **No bots.** Events with `bot_id` or `subtype: bot_message` are dropped, including the listener's own messages (prevents loops).
- **No externals.** `user.is_stranger` → drop.
- **No guests.** `is_restricted` or `is_ultra_restricted` → drop. Guest blocking is unconditional in V1; the email-domain allowlist below does not override it. (Future: a separate `allowGuests` or `allowedSlackUserIds` knob if needed.)
- **Optional email-domain allowlist** for *full members*. `.openit/slack.json` `allowedDomains: ["acme.com"]` — when non-empty, full-member users whose `profile.email` domain doesn't match are dropped. Empty array (V1 default) = allow all in-workspace full-member humans. This knob never re-allows guests or externals.

What we're explicitly *not* defending against in V1: a malicious workspace member crafting prompts to abuse the admin's local Claude session (prompt injection into KB articles, etc.). The admin should treat the bot like the localhost intake URL: only safe to expose to people they'd already trust to file IT tickets.

The `/connect-slack` skill surfaces this in plain language at the verify step.

### Dependency packaging

`@slack/socket-mode` and `@slack/web-api` won't magically exist inside `~/OpenIT/<orgId>/.claude/scripts/`. Existing plugin scripts (`sync-push.mjs`, `kb-search.mjs`) are dependency-light and use only Node stdlib + `fetch`. We're not changing that pattern for everyone; we're shipping the listener as a **bundled, single-file artifact** so it inherits the same "drop in and it runs" property.

**Approach:** at OpenIT build time, esbuild bundles `slack-listen.mjs` together with its `node_modules` deps into a single self-contained `slack-listen.bundle.cjs` (or `.mjs` if ESM bundling stays clean). The bundle ships in two places:

1. **Plugin dist** — `web/packages/app/public/openit-plugin/scripts/slack-listen.bundle.cjs`. Synced down to `~/OpenIT/<orgId>/.claude/scripts/` like every other plugin script. Lets a terminal-only admin (no OpenIT app) run it directly.
2. **App resources** — `src-tauri/resources/slack-listen.bundle.cjs`, packaged inside the `.app`. The Tauri supervisor prefers this copy (always matches the running app version) and falls back to the plugin-dist copy if missing.

Build pipeline: a new `npm run build:slack-listener` step in this repo (and equivalent in `/web` for the plugin dist) runs `esbuild slack-listen.mjs --bundle --platform=node --format=cjs --target=node20 --outfile=slack-listen.bundle.cjs`. Wired into the existing `npm run build` and the plugin-mirror step.

Source lives at `scripts/openit-plugin/scripts/slack-listen.src.mjs`; the bundle is a build artifact (gitignored in source repo, committed in `/web` plugin dist).

### Tauri-side additions

| New Tauri command | What |
|---|---|
| `slack_connect(bot_token, app_token, workspace_meta)` | Validates tokens (calls `auth.test`), stores tokens in keychain, writes `.openit/slack.json`. |
| `slack_disconnect()` | Removes tokens, deletes `.openit/slack.json`, stops listener. |
| `slack_listener_start()` | Spawns the bundled listener, returns once "socket-mode connected" line seen (or 10s timeout). |
| `slack_listener_stop()` | SIGTERMs the listener, waits for clean exit (5s) before SIGKILL. |
| `slack_listener_status()` | Returns `{ running, sessions, open_tickets, queue_depth, last_heartbeat, last_error }` for the header pill. |
| `slack_listener_send_intro(slack_user_email)` | One-shot DM used by the verify step. |

The supervisor lives in a new `src-tauri/src/slack.rs` (mirrors `pty.rs` / `intake.rs` patterns).

### Auth between listener and intake server

The listener runs on the same machine. It sets `Origin: http://localhost` on every HTTP call to satisfy the existing `origin_is_localhost` guard. No new auth surface — loopback-only remains the security boundary, same as the web chat. (If we ever expose the intake server beyond loopback, both the web chat and the Slack listener should grow a shared-secret header at the same time.)

### What does NOT change

- `intake.rs` HTTP routes — `/chat/start` body grows two optional fields, every existing client continues to work.
- `ai-intake` skill — unchanged.
- Ticket schema — gains optional `slackChannelId`, `slackUserId`, `slackWorkspaceId`. `askerChannel: "slack"` already enumerated.
- `answer-ticket` skill — needs one wording update: the "manual delivery" path for `askerChannel: "slack"` is deleted, since admin replies now flow automatically.
- On-disk conversation layout — unchanged.

---

## Components to build

| # | Component | Where it lives | Owner repo |
|---|---|---|---|
| 1 | `connect-slack` skill (admin-facing, conversational) | `scripts/openit-plugin/skills/connect-slack.md` | this repo (mirror to `/web` at merge) |
| 2 | Slack manifest YAML (embedded in skill, copy-pasteable) | inline in `connect-slack.md` | this repo |
| 3 | Slack listener source (Socket Mode + intake bridge) | `scripts/openit-plugin/scripts/slack-listen.src.mjs` | this repo |
| 4 | esbuild bundle step + npm script | `package.json` + `scripts/build-slack-listener.mjs` | this repo |
| 5 | Bundled listener committed to plugin dist | `web/packages/app/public/openit-plugin/scripts/slack-listen.bundle.cjs` | `/web` (at merge) |
| 6 | Bundled listener packaged into app resources | `src-tauri/resources/slack-listen.bundle.cjs` + `tauri.conf.json` resources entry | this repo |
| 7 | Listener supervisor (spawn / kill / status) | `src-tauri/src/slack.rs` | this repo |
| 8 | New Tauri commands registered | `src-tauri/src/lib.rs` | this repo |
| 9 | Intake server: extend `/chat/start` with `transport` + `resume_ticket_id`; thread `TransportMeta` through `SessionData` and `ensure_responding_stub` | `src-tauri/src/intake.rs` | this repo |
| 10 | Header UI: "Slack: connected" pill + kill switch | `src/shell/Shell.tsx` (likely) | this repo |
| 11 | `answer-ticket` wording fix | `scripts/openit-plugin/skills/answer-ticket.md` | this repo |
| 12 | Ticket schema additions (`slackChannelId`, etc.) | `scripts/openit-plugin/schemas/tickets._schema.json` | this repo |
| 13 | Gitignore additions for `.openit/slack-*.json` | `.gitignore` (project template) | this repo |

---

## Phasing

Three slim phases, each independently testable.

### Phase 1 — Listener + intake-server protocol changes

- Extend `/chat/start` (transport metadata + resume_ticket_id), thread `TransportMeta` through `SessionData` and `ensure_responding_stub`. Backward-compatible — web chat unchanged.
- Build `slack-listen.src.mjs` standalone with hardcoded tokens via env, no Tauri integration yet. Includes the Slack ack/queue, persistence, delivery ledger, trust gate.
- esbuild bundle pipeline.
- **Done when:** admin can manually `node slack-listen.bundle.cjs` and get a working bot end-to-end (inbound + admin-reply egress + survives listener restart without forking tickets or re-delivering replies).

### Phase 2 — Tauri supervisor + auto-start

- `src-tauri/src/slack.rs` with start/stop/status commands.
- Wire into project bootstrap: if `.openit/slack.json` exists, auto-start listener after intake server.
- Header pill in UI showing status + kill switch.
- Keychain storage for tokens (macOS).
- Graceful shutdown on app quit / project switch.
- **Done when:** opening a project with Slack already configured "just works"; closing the project / quitting the app cleanly stops the listener and persists ledgers.

### Phase 3 — `connect-slack` skill + verification flow

- Write the skill following `connect-to-cloud.md` shape.
- Embed the manifest YAML.
- Wire the verify step (intro DM).
- Update `answer-ticket.md` wording.
- Surface trust-model heads-up in the verify step.
- **Done when:** a fresh admin can go from zero to "DMing the bot and getting answers" in under 5 minutes by following `/connect-slack`.

---

## Decisions (locked for V1)

1. **Email capture.** Try `users.info` → `profile.email` first. If missing, bot DMs "Hi! What's your work email so I can file your ticket properly?" and waits for a reply before calling `/chat/start`. Pending-email state is held per `slack_user_id` in the on-disk session map.
2. **Trust posture.** Allow all in-workspace humans by default. Block bots, externals (Slack Connect / shared channels), and guests (`is_restricted` / `is_ultra_restricted` / `is_stranger`). No `allowedDomains` requirement in V1; the field exists for a future opt-in tightening but is empty by default.
3. **Resume semantics.** Same `slack_user_id` within 6h → reuse session and ticket. >6h → new session, new ticket. 30-min defensive resume window covers listener restarts mid-conversation (rebinds to existing ticket from disk even if session map didn't survive).
4. **Self-DM behavior.** Bot treats admin DMs the same as any employee — files a ticket, escalates back to the admin. The verify-step copy explicitly explains this so the admin isn't confused. No special-case detection.
5. **Token storage.** macOS Keychain only in V1. No plaintext-file fallback; Windows / Linux deferred to a follow-up.
6. **Admin UI surface.** Header pill only ("Slack: connected as @OpenIT" + status indicator + kill switch). Slack tickets show up in the regular ticket list / explorer / reports like any other — no Slack-specific panel.

---

## Manual test plan

### Happy path

1. Fresh OpenIT project. Run `/connect-slack`. Follow steps. End up with a working bot.
2. From a second Slack account (or admin's own — see Q4), DM the bot a question with a KB hit. Bot answers within ~5s. OpenIT shows ticket with `askerChannel: "slack"`, `slackChannelId`, `slackUserId`, status `open`, both turns in conversation file.
3. DM a question with no KB hit. Bot escalates. OpenIT shows escalation banner. Run `/answer-ticket <ticket>`, write a reply. Within ~5s the reply arrives in the asker's Slack DM.
4. Quit OpenIT. Wait. DM the bot — no reply (expected). Reopen OpenIT — listener restarts, ledgers reload, no duplicate replies, no missed-DM replay (Socket Mode doesn't buffer).

### Edge cases worth checking by hand

- **Race on first turn:** transport metadata correctly stamped on the ticket without any second-pass Edit (verify by checking the file write count).
- **Slack retry handling:** simulate slow `claude -p` (sleep injected); confirm Slack does not retry/duplicate because we acked immediately.
- **Restart mid-conversation:** DM bot, get reply, kill the listener with SIGKILL, restart. Send another DM within 6h — same ticket, no duplicate admin-reply re-delivery.
- **Delivery ledger lost:** delete `.openit/slack-delivery.json` while listener is stopped. On restart, listener walks existing conversation files and sets watermarks to the most-recent admin turn per ticket — no replay of old admin replies.
- **Bot loop guard:** confirm bot's own outgoing messages (looped back as `message.im` events) are filtered.
- **External user:** invite a Slack Connect user, DM the bot. Listener silently drops the event; no ticket created.
- **Guest user:** DM as a guest (`is_restricted` or `is_ultra_restricted`) — dropped. Add the guest's domain to `allowedDomains` and retry — still dropped (guest block is unconditional in V1).
- **Domain allowlist:** with `allowedDomains: ["acme.com"]` set, a full-member from `acme.com` is accepted; a full-member from `other.com` is dropped.
- **Token typo at step 3:** `auth.test` fails, skill loops back to "paste again" without losing prior state.
- **Listener killed via Activity Monitor:** header pill flips to "disconnected" within one heartbeat (~30s); admin can re-start with one click.
- **6h TTL window:** DM, wait 7h, DM again — second DM creates a new ticket. Within 6h reuses.
- **Email missing from profile:** bot asks for email, admin pastes one, ticket files correctly with that email.

---

## Why this shape (vs. alternatives I considered)

- **Why not put the listener in Rust?** `@slack/socket-mode` is the official, battle-tested SDK; the Rust Slack ecosystem is patchier. The Node script also keeps the same dev pattern as `sync-push.mjs` — and an admin in a terminal without the OpenIT app could still run the bundle directly. Bundling addresses the dependency objection.
- **Why not OAuth instead of manifest-paste?** OAuth requires a public redirect URI we don't have (local-only). Manifest-paste is the canonical pattern for self-hosted bots; OpenClaw uses it.
- **Why not Bolt instead of `socket-mode` + `web-api` directly?** Bolt brings an HTTP listener + command router we don't need. Direct is ~150 fewer lines and ~30MB smaller.
- **Why not introduce a generic "transport plugin" abstraction now?** YAGNI for V1, but `TransportMeta` is a small enum so the second transport (Teams, Email) is a one-variant addition rather than a rewrite. The abstraction we *are* committing to is "transport metadata threads through `/chat/start` → `SessionData` → ticket stub" — that's load-bearing now and the right surface to grow.
- **Why durable session + delivery ledgers instead of "just restart fresh"?** Listener restarts are routine (laptop close, app update, crash recovery). A fresh start that forks an in-progress conversation into two tickets, or that re-blasts an admin's last 5 replies, would be a visible product bug to the admin. The cost is two small JSON files and ~50 lines of code.
- **Why no channel mentions in V1?** Would require `app_mentions:read` + channel history scopes we don't otherwise need, and channel UX (mention-gating, threading, allowlists) is its own design. DM-only mirrors the localhost web chat 1:1, which is the explicit V1 goal.
