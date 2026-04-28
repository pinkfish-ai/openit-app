# Skill Canvas — V1 (folded into the Slack PR)

**Date:** 2026-04-27
**Status:** Draft, implementing alongside
**Author:** Claude (with Sankalp)

## Vision in one paragraph

Today the OpenIT center pane is a passive file viewer. When the admin wants to do something interactive (connect Slack, answer a ticket, resolve a conflict), the experience splits into two surfaces — a wall-of-text walkthrough in the Claude chat pane on the right, plus a modal popped over the rest. **The Skill Canvas is a single primary surface in the center pane** — a clean checklist of steps with the contextual action inline, driven by Claude on one side and the admin's clicks on the other, with a shared on-disk state file as the source of truth. Connect Slack is the first user. The pattern generalizes to any future flow that's currently a wall of chat.

## Why now

Building a generic canvas to deliver one flow (connect-slack) is over-engineered for V1 in isolation. We're doing it anyway because (a) the modal we shipped is already getting feedback that it's the wrong surface, (b) the admin needs to copy a YAML manifest *to a Slack browser tab*, paste tokens *back into OpenIT*, then send an intro DM — three context-switches that a quiet checklist with the right button at the right moment handles vastly better than a modal, (c) the same pattern fits answer-ticket / resolve-conflict / generate-report / connect-to-cloud, so the second user is already lined up.

## How it works

```
                ┌─────────────────────────────────────────┐
                │  .openit/skill-state/<skill-name>.json  │  source of truth
                └──┬───────────────────────────────────────┘
                   │  read/write
       ┌───────────┼───────────────────────────────────┐
       │           │                                   │
       ▼           ▼                                   ▼
 ┌──────────┐  ┌──────────────────────┐  ┌────────────────────────┐
 │ Claude   │  │  React SkillCanvas   │  │ Tauri file watcher     │
 │ (skill)  │  │  (renders from JSON) │  │ (notifies React on     │
 │ — writes │  │  — user interactions │  │  state file changes)   │
 │   state  │  │    inject prompts    │  └────────────────────────┘
 │   to     │  │    back to Claude    │
 │   advance│  │    via               │
 │   steps  │  │    writeToActiveSession
 └──────────┘  └──────────────────────┘
```

Three loops that meet at the state file:

1. **Claude → state file**: when a step is done, the skill `Edit`s the JSON to flip `status: "active"` → `"completed"` on that step and `"pending"` → `"active"` on the next. The skill is the orchestrator.
2. **State file → React**: file watcher fires, React re-reads, canvas re-renders. Steps check off automatically.
3. **React → Claude**: user clicks a button or pastes tokens; React calls the relevant Tauri command (e.g. `slack_connect`) AND injects a short prompt into the Claude session (`writeToActiveSession`) so the skill knows progress was made out-of-band and can advance.

## State schema

`.openit/skill-state/<skill-name>.json`:

```json
{
  "skill": "connect-slack",
  "title": "Connect Slack",
  "subtitle": "Bring the OpenIT bot to your workspace",
  "active": true,
  "steps": [
    {
      "id": "workspace-check",
      "title": "Have a Slack workspace",
      "status": "completed",
      "body": "You confirmed: Acme workspace, you're an admin."
    },
    {
      "id": "create-app",
      "title": "Create the Slack app",
      "status": "active",
      "body": "Click the button to copy the manifest YAML, then paste it into Slack's New App → From an app manifest editor.",
      "action": { "kind": "copy-manifest" }
    },
    {
      "id": "install-and-grab-bot-token",
      "title": "Install + grab the bot token",
      "status": "pending",
      "body": "After install, copy the xoxb- token shown on the Install App page."
    },
    {
      "id": "generate-app-token",
      "title": "Generate the app-level token",
      "status": "pending"
    },
    {
      "id": "paste-tokens",
      "title": "Connect to OpenIT",
      "status": "pending",
      "action": { "kind": "token-input" }
    },
    {
      "id": "verify",
      "title": "Verify roundtrip",
      "status": "pending",
      "action": { "kind": "verify-dm" }
    }
  ]
}
```

`active: false` hides the canvas. Skill sets it to `false` when the user disconnects or completes the flow.

## Action kinds (V1)

Each `action.kind` maps to a small React component the canvas knows how to render under the active step:

| `kind` | What renders | What happens on use |
|---|---|---|
| `copy-manifest` | "Copy Slack app manifest" button | `navigator.clipboard.writeText(SLACK_APP_MANIFEST)`; injects `"✓ Manifest copied — pasting it into Slack now"` into chat. |
| `token-input` | Two password fields + Connect button | calls `slack_connect`; on success injects `"✓ Tokens received and validated. Connected to <workspace> as @<bot>."` into chat. |
| `verify-dm` | Email field + Send intro DM button | calls `slack_listener_send_intro`; injects `"✓ Intro DM sent to <email>. Waiting for the human to reply."` |
| `link` | A plain link with an external href | injects nothing; just opens the URL. |

Future kinds (out of V1): `confirm` (yes/no buttons), `select` (radio), `code` (read-only code block), `file-list` (pickable files for action). Adding a new kind = small new React component + skill writes a state with that kind.

## Where it lives

- **Plan:** this file.
- **Schema (TS types):** `src/lib/skillCanvas.ts` — `SkillCanvasState`, `SkillStep`, `SkillAction` discriminated union.
- **React component:** `src/SkillCanvas.tsx` + `src/SkillCanvas.css`. Renders the schema. Hosts the per-action sub-components.
- **Tauri commands** (in a new module `src-tauri/src/skill_canvas.rs` or folded into `state.rs` — TBD during impl):
  - `skill_state_read(repo, skill)` → `Option<Value>`
  - `skill_state_write(repo, skill, state)` → atomic write
  - State files live under `<repo>/.openit/skill-state/`. Watcher already covers `.openit/`.
- **Wiring in Shell:** when an active state file exists, the center pane swaps from `Viewer` to `SkillCanvas`. When `active: false` or no state file, swap back to viewer.
- **Slash-command injection:** `Connect Slack` bubble click → calls `writeToActiveSession("/connect-slack")` instead of opening the modal.

## What replaces the modal

`SlackConnectModal.tsx` and `SlackConnectModal.css` are deleted. All the interactions previously housed in the modal — paste tokens, send intro DM, disconnect, status display — move into action kinds inside the canvas. The header pill stays as the at-a-glance status indicator and click still does something useful: it writes `/manage-slack` (or just `/connect-slack`, idempotent) to the chat which causes the skill to render the canvas in "manage" mode (showing the running listener + a Disconnect step).

## Connect-slack skill rewrite

The skill becomes:

1. **Bootstrap** (first turn after `/connect-slack`): if no state file, write the default state with all six steps in `pending` and step 0 in `active`. If state file exists, read it and resume from `currentStep`.
2. **Drive the state machine**: per-step body text, advance on signals from the canvas (injected prompts from action use), occasional pauses to confirm with the admin in chat ("did the install land?").
3. **FAQ mode**: between steps and after completion, the skill is also an IT-admin Q&A surface. Common questions (quit behavior, no-static-IP, what-if-workspace-admin-removes-app, multi-project) get answered from the skill's bottom-of-file knowledge section without disturbing canvas state.

The skill text becomes shorter — most of the step-by-step instructions live in the canvas's `body` strings now. The skill is the orchestrator, not the narrator.

## Documentation requested

Both go into the rewritten `connect-slack.md`'s FAQ section AND a "Operational properties" sidebar in the plan:

> **What happens when I quit OpenIT?** Tokens stay in macOS Keychain. `.openit/slack.json` and the session/delivery ledgers stay on disk. Auto-start fires next launch — no setup re-do. Caveat: a force-quit (kill -9 / Force Quit / system crash) leaves the Node listener orphaned. Run `pkill -f slack-listen.bundle.cjs` before reopening, or you'll have two listeners colliding.
>
> **Do I need a static IP?** No. The listener uses Socket Mode — outbound websocket to Slack, never inbound. Works behind NAT, on coffee shop WiFi, after a DHCP reassignment. Locally the listener talks to `127.0.0.1:<random-port>` (the intake server); the port changes every OpenIT launch but the supervisor passes the current URL to the listener every time it spawns it, transparent to you.

## Out of V1

- Multi-canvas (one active skill at a time; if user starts a second skill, the first canvas is dismissed).
- Canvas history / "show me the connect-slack flow I ran last week".
- Visual skill editor or skill marketplace.
- Per-action animations or transitions.
- Cross-skill state sharing.

## Why this shape (vs. alternatives I considered)

- **Why not just stuff the checklist into the modal?** Modal is overlay; canvas is primary surface. The whole point of the rethink is to use the empty center pane.
- **Why state file vs. websocket / IPC events?** File on disk is the same pattern OpenIT uses everywhere else (tickets, conversations, kb articles). It's debuggable (`cat`/`vim`), git-trackable if we want, and the Claude side already knows how to Read/Write/Edit files. No new IPC contract.
- **Why generic vs. one-off for connect-slack?** The user said yes to over-engineering. The second user (answer-ticket) is already obvious; building the framework now means we don't refactor when the second one shows up.
- **Why inject prompts into chat for user actions vs. Claude polling the state file?** Both happen — Claude polls (well, re-reads) the state file when invoked, but a fresh injected prompt nudges Claude to look NOW instead of when the human next types. Faster perceived latency.
