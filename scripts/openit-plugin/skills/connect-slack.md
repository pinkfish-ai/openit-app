---
name: connect-slack
description: Walk an IT admin through connecting OpenIT to a Slack workspace, in chat. Also handles disconnect and answers questions about how the Slack integration works (quit behavior, network requirements, multi-project setup, etc.). Local-only V1 — bot runs alongside OpenIT on the admin's machine.
---

## When to use

Slash-invoked from the OpenIT chat pane, or auto-injected when the
admin clicks the **Slack** pill in the bottom status bar. Two
different jobs:

1. **Walk the admin through setup** — chat-only conversational
   walkthrough, one beat at a time. There is no canvas, no
   checklist, no second narrator. You are the only voice.
2. **Run the disconnect** when the admin asks for it.
3. **Answer questions** from the FAQ at the bottom.

## The single rule that makes this work

**Each reply is one atomic instruction.** Tell the admin the next
thing to do (one Slack-side action), then stop. Wait for them to
report back before issuing the next one. Resist the urge to dump
multi-step plans — it's the thing that previously made this flow
confusing.

The exception: when an action of yours produces a meaningful
observation worth narrating (e.g. "manifest copied — bot is
@openclaw on pinkfishai"), that's part of the same atomic reply.

Tone: terse, conversational, trusting. Like a coworker over Slack,
not a tutorial. Avoid restating things the admin can see for
themselves. No emojis (except inside script-emitted toasts, which
the FE renders).

## How the FE supports you

**The chat-anchored dock.** Beneath the chat there's a single button
that appears at exactly the moment you ask for a token paste. You
control it via a tiny JSON file:

```bash
# Surface "Paste bot token" button:
echo '{"skill":"connect-slack","dock":"bot-token-paste"}' \
  > .openit/skill-state/connect-slack.json

# Surface "Paste app token" button:
echo '{"skill":"connect-slack","dock":"app-token-paste"}' \
  > .openit/skill-state/connect-slack.json

# Hide the dock:
echo '{"skill":"connect-slack","dock":null}' \
  > .openit/skill-state/connect-slack.json
```

When the admin pastes, the dock injects a short natural-prose
confirmation into the chat that you should treat as the trigger
to advance. The exact strings are listed under each step below.
There is no special prefix — the messages read like normal status
lines so they don't look like internal jargon in the user's
scrollback. Match on the first few words.

**Toasts.** The plugin scripts you'll run write `.openit/flash.json`
on success; OpenIT shows a small toast at the bottom-right. You
don't have to do anything for this — it just happens.

**Cmd-clickable URLs.** If you print `https://...`, the admin can
cmd-click in the chat to open it. Don't open URLs for them — let
them control the pace.

## Setup walkthrough

### Step 0 — invocation

When invoked (`/connect-slack`), first check whether they're already
connected:

```bash
cat .openit/slack.json 2>/dev/null
```

If the file exists with workspace info → they're connected. Reply:

> Already connected to **<workspace>** as @<bot>. Three things you
> might want: send a test DM (give me your work email), rotate a
> token, or disconnect.

If the file doesn't exist → fresh setup. The user just clicked
"Connect Slack" (or typed `/connect-slack`) so consent is implied —
don't ask whether they're ready. Orient them in one sentence,
then immediately run the first script. The orientation has to do
double duty: name the unfamiliar thing ("a Slack app") AND say
what it's for in human terms, because most OpenIT admins have
never created a Slack app before.

Open with this exact shape (substitute your own words but keep
the structure):

> Setting up Slack. You'll create a small Slack app and connect it
> to OpenIT — takes about 2 minutes.
>
> Copying the config to your clipboard now…

Then immediately run step 1.

### Step 1 — copy the manifest

```bash
node .claude/scripts/slack-copy-manifest.mjs
```

The script copies the YAML to clipboard and emits a toast. Reply
(one atomic instruction, no "when you're ready" or "tell me
when" — the one-reply-per-step rule already implies waiting):

> Done. Open https://api.slack.com/apps → **Create New App** →
> **From an app manifest**, pick your workspace, switch to the
> **YAML tab**, paste, **Next**, **Create**. Ping me when the
> app's settings page loads.

Wait for confirmation ("done" / "ok" / "next" / etc).

### Step 2 — install + paste bot token

Surface the dock:

```bash
echo '{"skill":"connect-slack","dock":"bot-token-paste"}' \
  > .openit/skill-state/connect-slack.json
```

Reply:

> Left sidebar: **Install App** → **Install to your workspace** →
> approve. You'll get a **Bot User OAuth Token** at the top (starts
> with `xoxb-`). Copy it and click **Paste bot token** below the
> chat — the field never echoes the token to chat history.

Wait for the dock's `Bot token saved — <ws> as @<bot>.` injection
in chat. When you see it, hide the dock and acknowledge:

```bash
echo '{"skill":"connect-slack","dock":null}' \
  > .openit/skill-state/connect-slack.json
```

> Got it — bot is **@<bot>** on **<ws>**. One more token.

### Step 3 — generate + paste app-level token

Surface the app-token dock:

```bash
echo '{"skill":"connect-slack","dock":"app-token-paste"}' \
  > .openit/skill-state/connect-slack.json
```

Reply:

> Same sidebar: **Basic Information** → scroll to **App-Level
> Tokens** → **Generate Token and Scopes**. Name it anything,
> add scope `connections:write`, click **Generate**. Copy the
> `xapp-` token and click **Paste app token** below.

Wait for `App token saved and listener up — connected to <ws> as
@<bot>.`. Hide the dock and reply:

> Connected to **<workspace>**. What email should I DM you to test?
> (Use whatever email Slack has on file for you.)

If you instead see `App token saved but listener failed to start:
...`, the app token is bad (typo, missing scope, or never
generated). Don't hide the dock — reply:

> The xapp- token didn't accept (`<reason>`). Re-paste a fresh one
> via the dock.

### Step 4 — verify

When they give an email:

```bash
node .claude/scripts/slack-send-intro.mjs --email <their-email>
```

On success, reply:

> Sent. Find the DM in Slack and reply like an employee asking for
> IT help — "I need access to Figma", "how do I get on the VPN",
> whatever. The bot answers from your knowledge base if it can,
> escalates to you here if it can't.
>
> Heads up: the bot is live in **<workspace>** now — anyone in the
> workspace can DM it as long as OpenIT is running on this machine.

You're done. (Don't write any more state files for this flow.)

If the script fails:

- `users_not_found` → email isn't in the workspace. Reply:
  > That email isn't in **<workspace>**. Use the email Slack has on
  > file for you (Slack → Profile → "About me").
- `listener not running` → reply:
  > Listener isn't up. Did the app-token step finish cleanly? Try
  > re-pasting the xapp- via the dock.
- Other → surface verbatim:
  > Slack rejected: `<error>`. What do you want to try next?

## Disconnect flow

When the admin says "disconnect slack" (or similar), confirm
once before tearing it down. Lead with the outcome (what they'll
no longer be able to do), not the implementation tour:

> This disconnects Slack — OpenIT will stop receiving DMs and
> you'll need to reconnect to use it again. Confirm?

On yes:

```bash
node .claude/scripts/slack-disconnect.mjs
```

Reply (one line, plus the optional follow-up):

> Done. The Slack app itself is still installed in your workspace.
> You can leave it idle, or remove it at https://api.slack.com/apps
> → your OpenIT app → Basic Information → bottom → **Delete App**.

## Token rotation

Less common, but supported via the same dock. If the admin says
"rotate the bot token" / "my bot token got revoked" / similar:

> Open https://api.slack.com/apps → your OpenIT app → **Install App**
> → **Reinstall to workspace**. Slack issues a fresh `xoxb-`. Copy
> it and click **Paste bot token** below.

Surface `dock: bot-token-paste`. The dock's existing flow restages
the bot token; you'll then need to also re-paste the existing app
token (since `slack_connect` requires both). For V1, the simplest
path is: walk the admin through both pastes again. Future work:
add a one-token rotation Tauri command.

For app-token rotation, similar pattern but Basic Information →
Generate, then `dock: app-token-paste`.

## Rules

- **Never echo tokens.** If the admin pastes `xoxb-...` or
  `xapp-...` into chat, refuse to acknowledge the actual
  characters: *"Tokens go in via the **Paste bot/app token**
  button, not chat — keeps them out of scrollback. Click that and
  paste, I'll see a redacted confirmation."*
- **One instruction per reply.** Don't preview future steps.
- **No emojis** in your chat output. Toasts emitted by scripts can
  use a leading glyph (`✓`, `📋`, etc) — that's fine, the FE
  renders them in a contained pill.
- **Trust scripts' JSON output.** Each script prints one line:
  `{"ok":true,...}` or `{"ok":false,"error":...}`. Branch on `.ok`.
- **The dock is the only token surface.** You never call
  `slack_validate_bot_token` / `slack_connect` /
  `slack_listener_start` yourself.
- **You write to the dock side-channel; nobody else does.** Clear
  it (`dock: null`) as soon as the dock has done its job, so a
  stale button doesn't linger after the relevant step.

---

# FAQ

## What happens when I quit OpenIT?

Tokens stay in macOS Keychain. `.openit/slack.json` and the
session/delivery ledgers stay on disk. The next time you launch
OpenIT, the listener auto-starts — no setup to redo.

**Caveat:** force-quit (kill -9 / Force Quit / system crash) can
leave the Node listener orphaned. The next launch then has two
listeners colliding (duplicate tickets and replies). Recovery:

```bash
pkill -f slack-listen.bundle.cjs
```

before reopening OpenIT. Regular Cmd+Q doesn't have this problem.

## Do I need a static IP, port forwarding, or any networking setup?

No. The listener uses Slack's **Socket Mode** — it opens an
outbound websocket to Slack and never accepts inbound connections.
Works behind NAT, on coffee shop WiFi, after a DHCP reassignment,
on a VPN, anywhere with internet egress to `slack.com`.

Locally the listener talks to `127.0.0.1:<random-port>` (the
intake server). The port changes every OpenIT launch but the Tauri
supervisor passes the current URL to the listener every time it
spawns it — invisible to you.

## What about the Slack-side config — does that survive across reboots?

Yes. Your Slack app at api.slack.com lives on Slack's servers and
persists indefinitely. The bot stays installed in the workspace
until someone (you or another workspace admin) removes it.

## What if my workspace admin uninstalls the OpenIT bot?

The next API call from the listener fails with `not_authed` or
`account_inactive`. Status pill flips amber and surfaces the
error. Recovery: reinstall the app at api.slack.com (the existing
bot token is invalidated; you'll need a new one) → run
`/connect-slack` and use the dock paste.

## Can I have multiple OpenIT projects each connected to a different Slack workspace?

Yes. Each project's Slack config (`.openit/slack.json`) is
project-local; tokens in Keychain are scoped per `orgId`. You'll
need a separate Slack app per project (one bot per workspace per
project). Run `/connect-slack` from inside each project and paste
distinct tokens via the dock.

## Why the bot doesn't reply to messages sent while OpenIT was closed

Socket Mode does not buffer events while the websocket is down.
DMs sent during a listener outage are lost — Slack does not
re-deliver them when the listener reconnects. This is a Slack
protocol property, not an OpenIT bug. The eventual fix is to host
the listener in Pinkfish cloud (always-on) — that's the
upgrade path.
