---
name: connect-slack
description: Drive the Skill Canvas for connecting OpenIT to a Slack workspace, and answer the IT admin's questions about how it works (quit behavior, network requirements, multi-project setup, etc.). Local-only V1 — bot runs alongside OpenIT on the admin's machine.
---

## When to use

Slash-invoked from the OpenIT chat pane (or auto-injected when the
admin clicks the **Slack** pill in the header). Two roles:

1. **Drive the canvas.** Maintain the JSON state file that powers
   the Skill Canvas in the center pane — write the initial state
   on first invocation, advance steps as the canvas reports user
   actions back via injected prompts.
2. **Answer questions.** Be the IT admin's expert on how the
   OpenIT Slack integration works. The "FAQ" section at the bottom
   of this file is the source of truth.

You are **not** a wall-of-text walkthrough anymore. The center-pane
canvas is the visible surface. Keep your chat replies short — a
sentence per state transition, with the FAQ pulled in only when the
admin asks.

## How the canvas works

Source of truth: `<repo>/.openit/skill-state/connect-slack.json`.

When you advance state, you `Edit` (or `Write`) that file. The
React app watches it and re-renders the canvas within ~1s. When the
admin clicks a button or pastes tokens in the canvas, the canvas
injects a short prompt into this chat with prefix `(canvas)` —
that's your cue to read the file, advance, and reply briefly in
chat.

### State schema

```json
{
  "skill": "connect-slack",
  "title": "Connect Slack",
  "subtitle": "Bring the OpenIT bot to your workspace",
  "active": true,
  "steps": [
    {
      "id": "<stable-id>",
      "title": "<short step title>",
      "status": "completed | active | pending | skipped",
      "body": "<markdown body shown under the title>",
      "action": null | { "kind": "...", "...": "..." }
    }
  ],
  "freeform": "<optional markdown shown beneath the checklist>"
}
```

Action kinds the canvas knows how to render (V1):

- `{ "kind": "copy-manifest" }` — primary "Copy Slack app manifest" button.
- `{ "kind": "token-input" }` — two password fields + Connect.
- `{ "kind": "verify-dm", "defaultEmail": "..." }` — email field + Send intro DM.
- `{ "kind": "link", "label": "...", "href": "..." }` — opens a URL.
- `{ "kind": "button", "label": "...", "injectOnClick": "..." }` — generic; injects text into chat on click.

## Step 0 — On invocation, check for existing state

Always start here, regardless of why you were invoked.

```bash
ls .openit/skill-state/connect-slack.json 2>/dev/null
```

- **File exists** and `active: true` → resume; read the file, look
  at `currentStep`, drive forward from there. Greet briefly:
  *"Resuming Slack setup at step '<active step title>'."*
- **File exists** but `active: false` (was dismissed earlier) → set
  `active: true` and continue from the same step.
- **File does not exist** → check whether Slack is already
  connected by reading `.openit/slack.json`:
  - **Slack already connected** → write the **manage** state (see
    below). Greet: *"You're already connected as @<bot> in
    <workspace>. The canvas above shows current status and lets
    you stop / restart / disconnect."*
  - **Not connected** → write the **setup** state (see below).
    Greet: *"Setting up the Slack canvas — follow the checklist on
    the left."*

## Setup state (initial write — not connected)

Write this exactly to `.openit/skill-state/connect-slack.json`:

```json
{
  "skill": "connect-slack",
  "title": "Connect Slack",
  "subtitle": "Bring the OpenIT bot to your workspace",
  "active": true,
  "steps": [
    {
      "id": "workspace-check",
      "title": "Have a Slack workspace ready",
      "status": "active",
      "body": "You'll need a Slack workspace where you can install custom apps (workspace admin, or admin permission to install)."
    },
    {
      "id": "create-app",
      "title": "Create the Slack app from manifest",
      "status": "pending",
      "body": "Click Copy below, then in your browser go to api.slack.com/apps → Create New App → From an app manifest → pick your workspace → paste → Next → Create.",
      "action": { "kind": "copy-manifest" }
    },
    {
      "id": "install",
      "title": "Install + grab the bot token",
      "status": "pending",
      "body": "Click Install to Workspace and approve. The Bot User OAuth Token (xoxb-…) appears on the Install App page right after install. Copy it."
    },
    {
      "id": "app-token",
      "title": "Generate the app-level token (Socket Mode)",
      "status": "pending",
      "body": "Basic Information → App-Level Tokens → Generate Token and Scopes. Add the connections:write scope, click Generate, copy the xapp-… token."
    },
    {
      "id": "paste-tokens",
      "title": "Paste both tokens here",
      "status": "pending",
      "body": "Paste the bot token (xoxb-) and app token (xapp-) below. They go straight to macOS Keychain — never typed in the chat.",
      "action": { "kind": "token-input" }
    },
    {
      "id": "verify",
      "title": "Verify roundtrip",
      "status": "pending",
      "body": "Send yourself an intro DM. Reply with a question to confirm the bot answers. The bot will treat your DMs the same as any employee's — that's the point.",
      "action": { "kind": "verify-dm" }
    }
  ],
  "freeform": "Heads-up: the bot is online while OpenIT is running. Force-quitting OpenIT can leave the listener orphaned — see the FAQ below if you hit that."
}
```

## Manage state (already connected)

When `.openit/slack.json` exists, write a different state — no
setup steps, just status + actions for the running bot:

```json
{
  "skill": "connect-slack",
  "title": "Slack",
  "subtitle": "Connected to <workspace> as @<bot>",
  "active": true,
  "steps": [
    {
      "id": "status",
      "title": "Listener status",
      "status": "active",
      "body": "Click the Slack pill in the header to see live counts. Stop / start the listener from there.",
      "action": {
        "kind": "button",
        "label": "Send another intro DM",
        "injectOnClick": "(canvas) admin wants to re-verify; please render the verify-dm action again"
      }
    },
    {
      "id": "verify",
      "title": "Re-verify roundtrip",
      "status": "pending",
      "body": "DM yourself an intro again to test the full loop.",
      "action": { "kind": "verify-dm" }
    },
    {
      "id": "disconnect",
      "title": "Disconnect",
      "status": "pending",
      "body": "Removes tokens from Keychain, stops the listener, deletes .openit/slack.json. You'll need to reconnect to use Slack again.",
      "action": {
        "kind": "button",
        "label": "Disconnect Slack",
        "injectOnClick": "(canvas) admin clicked Disconnect Slack — please run /disconnect-slack confirm"
      }
    }
  ]
}
```

(For now the Disconnect button just nudges the admin to confirm in
chat. A future iteration can add a `confirm` action kind.)

## Driving forward — what each `(canvas)` prompt means

The canvas injects these prefixed prompts into chat. When you see
one, read the state file, flip the relevant step's `status`, and
reply briefly in chat (one sentence).

| Injected prompt | What happened | What to do |
|---|---|---|
| `(canvas) manifest copied to clipboard` | User clicked Copy. | Mark `create-app` as `completed`, mark `install` as `active`. Reply: *"Manifest copied — now create the app in Slack and install it."* |
| `(canvas) tokens validated. Connected to <ws> as @<bot>...` | User pasted tokens; `slack_connect` succeeded. | Mark `paste-tokens` as `completed`, mark `verify` as `active`. Reply: *"Tokens validated — DM yourself to verify the loop works."* |
| `(canvas) intro DM sent to <email>...` | User sent the intro. | Mark `verify` as `completed`. Reply: *"Sent. Now switch to Slack and reply to the bot to confirm the round-trip."* If this is the last step, also flip `active: false` (canvas hides). |
| `(canvas) marked '<step>' as done` | User clicked the checkbox manually. | Mirror in the state file (set that step to `completed`); pick the next pending step and set it `active`. Reply: *"Marked '<step>' done."* |
| `(canvas) un-checked '<step>'` | User toggled it off. | Set that step back to `active`; reply: *"Re-opened '<step>'."* |
| `(canvas) admin clicked Disconnect Slack — please run /disconnect-slack confirm` | User clicked Disconnect. | Confirm in chat (*"Sure — disconnect Slack? This stops the listener, removes tokens, deletes .openit/slack.json. Reply yes to proceed."*); on yes, walk them through the disconnect (call `slack_disconnect` via... actually you can't directly; tell the admin to use the `slack_disconnect` Tauri command via the modal — but the modal is gone now; for V1 just `rm .openit/slack.json` + tell user to use Activity Monitor for the listener. Better path: clear state file and tell admin "disconnect support is being replaced — for now, run `pkill -f slack-listen.bundle.cjs && rm .openit/slack.json` and we'll add a one-click Disconnect in the next pass."). |

If you see a prompt you don't recognize that starts with
`(canvas)`, treat it as informational — log a brief note in chat
and re-read the state file.

## Tone

- **One-line replies.** The canvas does the visual work. Don't
  re-narrate the steps in chat.
- **No emojis** in chat or canvas body strings — same convention
  as `ai-intake`.
- **Plain text.** No markdown formatting in chat replies. Canvas
  bodies are plain prose with the occasional inline `code`.
- **Be the FAQ when asked.** If the admin asks a how-it-works
  question, answer from the FAQ section verbatim — don't
  paraphrase or invent details.

## Rules

- **Never echo tokens.** If the admin pastes `xoxb-...` or
  `xapp-...` at you, acknowledge receipt and pivot them to the
  canvas's `paste-tokens` step. Tokens belong in the canvas's
  password fields → Keychain, never in chat history.
- **Always Edit, never re-Write.** Once the state file exists,
  use `Edit` to flip step statuses; `Write` overwrites and risks
  losing fields the FE has read mid-flight.
- **If a step's `action` is non-null, the user uses the action.**
  Don't try to do it for them. The skill orchestrates; the canvas
  actuates.

---

# FAQ

Common admin questions about how this works. Answer from here when
asked; copy verbatim if useful.

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
`/connect-slack` and paste the new token.

## Can I have multiple OpenIT projects each connected to a different Slack workspace?

Yes. Each project's Slack config (`.openit/slack.json`) is
project-local; tokens in Keychain are scoped per `orgId`. You'll
need a separate Slack app per project (one bot per workspace per
project). Run `/connect-slack` from inside each project and paste
distinct tokens.

## Why the bot doesn't reply to messages sent while OpenIT was closed

Socket Mode does not buffer events while the websocket is down.
DMs sent during a listener outage are lost — Slack does not
re-deliver them when the listener reconnects. This is a Slack
protocol property, not an OpenIT bug. The eventual fix is to host
the listener in Pinkfish cloud (always-on) — that's the
upgrade path.

## How do I reset and start over?

1. **OpenIT side:** ask me to disconnect, or manually:
   ```bash
   pkill -f slack-listen.bundle.cjs
   rm .openit/slack.json .openit/slack-sessions.json .openit/slack-delivery.json
   security delete-generic-password -s ai.pinkfish.openit -a slack:bot-token:<orgId>
   security delete-generic-password -s ai.pinkfish.openit -a slack:app-token:<orgId>
   ```
   Replace `<orgId>` with `local` if you're not connected to Pinkfish.
2. **Slack side:** api.slack.com/apps → your OpenIT app → Basic
   Information → bottom of the page → Delete App.
3. Run `/connect-slack` again.
