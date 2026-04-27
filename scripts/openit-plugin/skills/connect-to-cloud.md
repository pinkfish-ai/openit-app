---
name: connect-to-cloud
description: Walk the admin through connecting OpenIT to Pinkfish (the cloud companion). Once connected, the helpdesk can host the intake page on a public URL, run agents server-side so they answer when this app is closed, sync across devices, and ingest tickets from Slack/Teams/email. Slash-invoked from the welcome doc; admin-facing.
---

## When to use

The user wants to **make their intake page reachable from outside their machine** — share the URL with coworkers on a different network, accept tickets when their laptop is asleep, or hand the helpdesk to a teammate without spinning up ngrok. Connecting to Pinkfish is the path.

Also runs when the user wants any of these:

- **Channel ingest** — Slack/Teams/email/SMS questions land as tickets automatically.
- **Always-on agents** — the triage agent answers even when the desktop app is closed.
- **Multi-device sync** — same project on a phone, a second laptop, a coworker's machine.
- **Semantic KB search** — search by meaning, not filename.

If they just want to share their LOCAL intake URL on the same network, point them at ngrok / Cloudflare Tunnel instead — no Pinkfish needed.

## What you're walking the user through

This skill is **conversational** — you're the guide, they're the driver. Don't dump the whole list at once; do one step, confirm, move on. Each step has a "you do" (what the user clicks/types) and a "verify" (what should happen).

### Step 1 — Pinkfish account

> "First, do you have a Pinkfish account already, or do we need to make one?"

- **No account** → open `https://app.pinkfish.ai/signup` for them via the link below. Wait for them to confirm they've signed up.

  [**Sign up at pinkfish.ai**](https://app.pinkfish.ai/signup)

- **Has account** → great, move on.

### Step 2 — Connect this project

> "In the OpenIT header (top-right), click the **key icon** to open the connect-to-cloud modal. It'll open Pinkfish in your browser to authenticate, then bounce back here."

What should happen:
- Browser opens to Pinkfish auth.
- After they authorize, the modal closes and the key icon turns green/filled to indicate connected.
- The header shows their org name.

Ask them to confirm: *"Did the icon turn green? What org name is showing?"*

If something went wrong (icon stayed grey, error in modal, browser didn't open):
- Check `tauri::log` output if accessible.
- Confirm they completed the OAuth flow (some users close the browser tab before the redirect lands).
- Suggest they retry the modal.

### Step 3 — First sync

> "Now that you're connected, let's push your local helpdesk to the cloud so it actually exists up there too."

Tell them to click the **Deploy** tab on the left, then **Sync to Cloud**. Watch the sync log scroll. Verify:
- No red error rows.
- The summary line shows N items pushed (tickets, KB articles, agents, people).

If sync fails, common causes:
- Ticket schema mismatch (rare — check `_schema.json` was pushed first).
- A file path with characters that don't survive cloud encoding.

### Step 4 — Make intake public (the goal)

Once connected, the intake URL can move from `localhost:<port>` to a stable Pinkfish-hosted URL.

**Note: this part is V2 — not shipped yet.** When it lands, the connect flow will surface the public URL in the same header pill that currently shows localhost. Until then, the user can use ngrok / Cloudflare Tunnel against the localhost URL for a quick public share.

When you reach this step, tell the user honestly that the public-URL feature is on the roadmap and offer a tunneling alternative:

- **Cloudflare Tunnel** — free, persistent URL, no rate-limit gotchas: `cloudflared tunnel --url http://localhost:<port>`
- **Tailscale Funnel** — simplest if their team is already in a tailnet.
- **ngrok** — fastest for one-off testing.

### Step 5 — Optional: channel ingest

If they want Slack/email/Teams tickets, walk them through:

> "Open the **Connect more sources** modal from the header. We'll pick a channel (Slack is the most common starting point)."

OAuth flows for each channel are handled by Pinkfish; you're just guiding the click-through. After they auth a channel, mention that questions arriving on that channel will start landing as tickets in `databases/tickets/` automatically.

## Tone

- **You're a guide, not a wizard.** They're driving. Confirm at each step.
- **Don't dump steps.** One at a time. Wait for "ok" before the next.
- **Be honest about V2.** The "make intake public" piece isn't fully built; don't pretend it is.
- **Explain why.** Each step has a why ("this auth pops up so we can grant the OpenIT app permission to push your data"). Helps them understand instead of clicking blindly.

## Rules

- **Never store credentials.** Pinkfish OAuth handles tokens; never ask the user to paste an API key into a chat.
- **Stop on red.** If a sync errors out, fix the underlying cause before moving forward.
- **Skip what's already done.** If the user is already connected (key icon green), jump to step 3 or 4.
