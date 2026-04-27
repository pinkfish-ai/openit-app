---
name: connect-slack
description: Walk the admin through connecting OpenIT to a Slack workspace so employees can DM the bot for IT help. Local-only V1 — the listener runs alongside OpenIT on the admin's machine. Conversational walkthrough; one step at a time, confirm, advance.
---

## When to use

The admin wants employees in their company to be able to ask IT
questions over Slack DMs instead of (or in addition to) the
localhost intake URL. The bot they connect lives in their Slack
workspace as a regular bot user; OpenIT routes inbound DMs through
the same triage agent and KB the localhost chat uses, and ferries
admin replies back as Slack DMs.

**Local only in V1.** The bot is online while the OpenIT app is
running; closes when the app closes. That's fine for a small team
piloting OpenIT — when they're ready for 24/7 always-on, the path
is to connect to Pinkfish (cloud companion) and promote the bot
there. Don't pretend cloud is available now.

## What you're walking the user through

The walkthrough is **conversational** — one step, confirm, next.
Don't dump the whole list. Each step has a "you do" (what the user
clicks/types) and a "verify" (what should happen).

### Step 0 — Already connected?

Run `slack_config_read` (Tauri) — actually, since you can't call
Tauri commands directly, just check whether the file exists:

```bash
cat .openit/slack.json 2>/dev/null
```

If the file exists and the header shows a green Slack pill, the
admin is already connected. Ask: *"Looks like you're already
connected as @<botName> in <workspaceName>. Do you want to reset
that, or are we troubleshooting something specific?"*

### Step 1 — Slack workspace check

> "Do you have a Slack workspace where you want this bot to live?
> Usually that's your company's main workspace. You'll need to be
> a workspace admin or have permission to install custom apps."

If they don't have one, point them at https://slack.com/get-started
and pause until they confirm.

### Step 2 — Create the Slack app from manifest

> "Open https://api.slack.com/apps in a browser. Click **Create
> New App** → **From an app manifest**. Pick your workspace. Then
> paste this exact YAML and click Next, then Create:"

```yaml
display_information:
  name: OpenIT
  description: Local IT helpdesk bot
  background_color: "#2c2d72"
features:
  bot_user:
    display_name: OpenIT
    always_online: false
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
oauth_config:
  scopes:
    bot:
      - chat:write
      - im:history
      - im:read
      - im:write
      - users:read
      - users:read.email
      - team:read
settings:
  event_subscriptions:
    bot_events:
      - message.im
  interactivity:
    is_enabled: false
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
```

Wait for the user to confirm the app was created.

**Why these scopes:** `chat:write` to reply, `im:*` to receive
DMs, `users:read` + `users:read.email` to identify the asker and
file the ticket against the right email, `team:read` to confirm
the workspace at startup. Nothing for channels — V1 is DM-only.

**Why the `app_home` block:** without
`messages_tab_read_only_enabled: false`, Slack treats the bot's
DM Messages tab as read-only and the asker sees "Sending messages
to this app has been turned off." The bot can post to them, but
they can't reply. This block is the one Slack-side knob you have
to set or DMs are one-way.

**If they already created the app with an older manifest** (and
are now hitting "Sending messages turned off" in the bot DM):
they don't need to delete and recreate. Tell them to go to the
left sidebar → **App Manifest** → paste this updated YAML →
**Save Changes** → on the warning prompt, **Reinstall** the app
to apply the new permissions. The bot token doesn't change on
reinstall, so existing OpenIT config keeps working.

### Step 3 — Install & grab the bot token

> "1. Click **Install to Workspace** and approve the permissions.
> 2. The page reloads to **Installed App Settings** with the **Bot
>    User OAuth Token** shown right there — starts with `xoxb-`.
>    Copy it.
>
> Hold onto that token — don't paste it here. You'll enter it
> into a modal in the OpenIT header in a moment, where it goes
> straight into macOS Keychain."

(If for any reason the token isn't visible after install, they
can also find it in the left sidebar under **OAuth & Permissions
→ Bot User OAuth Token**. Same value either place.)

If they paste a token at you anyway, do NOT echo it back — tokens
stay out of the conversation log. Acknowledge it's in hand and
pivot to Step 4.

### Step 4 — Generate the app-level token (Socket Mode)

> "Now in the left sidebar, **Basic Information**, scroll to
> **App-Level Tokens** → **Generate Token and Scopes**. Name it
> `socket`, add the `connections:write` scope, click **Generate**.
> Copy the token (starts with `xapp-`) — keep it handy too."

### Step 5 — Paste tokens into OpenIT

> "Open the **Connect Slack** modal — click the dotted Slack pill
> in the OpenIT header (top-right, next to the Intake pill). Paste
> both tokens there and click **Connect**. The modal will validate
> the bot token against Slack, store both tokens in macOS
> Keychain, write a `.openit/slack.json` pointer file, and start
> the listener."

What should happen:
- The pill turns green and shows your bot name.
- You should see "Slack: @OpenIT • 0 sessions" in the header.

If the pill stays grey or the modal shows an error, the most
common causes are:
- Bot token typo (extra space, wrong half copied) → `auth.test`
  fails, modal shows "invalid_auth".
- App token typo → modal accepts it (no validation pre-start)
  but the listener fails to come up within 10s and the modal
  reports the error from the listener's first stderr line.

### Step 6 — Verify roundtrip

> "All set on the wiring. Click **Send intro DM** in the modal —
> the bot will DM you 'Hi, I'm the OpenIT triage bot — try asking
> me a question.' Open Slack, find the message, ask anything (e.g.
> 'how do I reset my Mac password?'). Tell me when you've seen the
> reply."

A couple of things to flag for them, in plain language:

> Two heads-ups: (1) the bot will treat *your own* DMs the same as
> any employee's — that's the point; you're testing the asker
> experience. If you ask a question, it'll file a ticket against
> your own email and the escalation banner will fire when no KB
> article matches. (2) The bot is online while OpenIT is running.
> If you close the app, the bot goes offline; DMs sent while it's
> offline are not replayed when you reopen. That's V1 by design —
> the always-on path is to connect to Pinkfish later.

### Step 7 — Tell the team

Once roundtrip works, tell the user:

> "From here, anyone in your Slack workspace can DM @OpenIT and
> file an IT ticket. New tickets show up in your ticket list with
> `askerChannel: "slack"`. When you escalate one and write a reply
> via `/answer-ticket`, the reply is delivered automatically as a
> Slack DM — no copy-paste."

## Tone

- **You're a guide, not a wizard.** They're driving. Confirm at
  each step before moving on.
- **Don't dump steps.** One at a time. Wait for "ok" or a paste
  before the next.
- **Be honest about V1.** Local-only. Bot offline when OpenIT is
  closed. Channel mentions / threads / slash commands not
  supported. Don't invent capabilities.
- **Don't store credentials.** Tokens belong in keychain via the
  modal, never in the conversation. If the user pastes a token at
  you, acknowledge it's been received and pivot them to the
  modal — don't echo it back.

## Rules

- **Never call `slack_connect` yourself.** That command exists for
  the React modal. The skill walks the admin to the modal; the
  modal does the actuation. Same pattern `connect-to-cloud` uses
  with the key icon.
- **Stop on red.** If `auth.test` fails or the listener won't come
  up, fix the underlying cause (almost always a token typo or
  wrong app config) before continuing. Don't paper over with a
  retry loop.
- **Skip what's already done.** If the project is already
  connected (Step 0), jump to Step 6 (verify) or to whatever the
  user actually came in for.
