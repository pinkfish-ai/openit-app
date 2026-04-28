// Default Skill Canvas state for the connect-slack skill.
//
// We pre-write this from the React layer (App.tsx pill click)
// rather than having Claude `Write` it on first invocation. Two
// reasons:
//
//   1. The content is static — there's nothing for Claude to
//      decide on a fresh setup. Asking Claude to recreate the
//      same JSON on every project just earns the user a
//      permission-prompt for no value.
//   2. Putting the schema in TypeScript makes it type-checked
//      against `SkillCanvasState`. Skill-side JSON-in-markdown
//      can drift; the constants here can't.
//
// The skill's role becomes pure orchestration: read the existing
// file, advance step `status` in response to (canvas)-prefixed
// prompts. It never has to scaffold.

import type { SlackConfig } from './api';
import type { SkillCanvasState } from './skillCanvas';

/// State for a fresh setup — no .openit/slack.json yet. Four
/// steps, the first marked active. Pill click writes this, the
/// canvas renders it, the skill drives it forward.
///
/// Paste-as-you-go ordering: the bot-token field lives on the
/// install step (paste as soon as you copy it from Slack) and
/// the app-token field lives on the app-token step (paste as
/// soon as Slack generates it). No more "remember this token
/// across two more steps" friction.
///
/// Bodies are intentionally detailed: most OpenIT admins haven't
/// installed a Slack app before, so each step spells out the
/// click-by-click navigation. Use `**bold**` for the exact UI
/// labels they need to find, `inline code` for tokens / scope
/// names, and `\n` between numbered sub-steps so they render
/// line-by-line in the canvas.
export function buildSetupState(): SkillCanvasState {
  return {
    skill: 'connect-slack',
    title: 'Connect Slack',
    subtitle: 'Bring the OpenIT bot to your workspace',
    active: true,
    steps: [
      {
        id: 'create-app',
        title: 'Create the Slack app from a manifest',
        status: 'active',
        body: "1. Click **Copy Slack app manifest** below — the YAML lands in your clipboard.\n2. Open https://api.slack.com/apps in your browser.\n3. Click **Create New App** (top right of the page).\n4. Choose **From an app manifest**.\n5. Pick the Slack workspace where you want the bot to live, then click **Next**.\n6. Clear anything in the YAML editor (Cmd+A, Delete) and paste your clipboard.\n7. Click **Next**, review, then **Create**.\n\nYou need to be a workspace admin (or have permission to install custom apps). If you're not, ask whoever owns your Slack workspace to set this up.",
        action: { kind: 'copy-manifest' },
      },
      {
        id: 'install',
        title: 'Install the app and paste the bot token',
        status: 'pending',
        body: "1. After Slack creates the app it lands on the app's settings page. In the left sidebar under **Settings**, click **Install App**.\n2. Click **Install to <your workspace>** and approve the permissions Slack lists.\n3. The page reloads to **Installed App Settings** and shows your **Bot User OAuth Token** right at the top — it starts with `xoxb-`.\n4. Click **Copy** next to the token, then come back here and paste it into the field below.\n\nClick **Save bot token**. OpenIT validates the token against Slack right away (so you catch typos before generating the second token), and stages it in memory until you have the app-level token in the next step. Tokens never go into chat history.",
        action: { kind: 'bot-token-input' },
      },
      {
        id: 'app-token',
        title: 'Generate the app-level token and connect',
        status: 'pending',
        body: "Slack's Socket Mode uses a second token (an app-level token, prefix `xapp-`) so the listener can open a websocket without a public webhook URL. Generate it now:\n\n1. In the left sidebar under **Settings**, click **Basic Information**.\n2. Scroll down to the **App-Level Tokens** section (it's below **Display Information**).\n3. Click **Generate Token and Scopes**.\n4. Give the token a **Token Name** like `socket` (anything works — it's just a label).\n5. Click **Add Scope** and pick `connections:write`. That's the only scope it needs.\n6. Click **Generate**.\n7. Copy the token Slack shows you (it starts with `xapp-`) and paste it below.\n\nClick **Connect** to combine this token with the staged bot token, store both in macOS Keychain, write the `.openit/slack.json` pointer file, and auto-start the listener.",
        action: { kind: 'app-token-input' },
      },
      {
        id: 'verify',
        title: 'Verify roundtrip',
        status: 'pending',
        body: "Send yourself an intro DM to prove the bot is wired up end-to-end:\n\n1. Enter your own work email below (the email Slack has on file for you in this workspace).\n2. Click **Send intro DM**. The listener will look you up by email via `users.lookupByEmail` and DM you 'Hi! I'm the OpenIT triage bot...'.\n3. Open Slack, find the DM from your bot, and reply with a real-ish question — try `how do I reset my Mac password?`. The bot will either answer from your knowledge base (if there's an article) or escalate the ticket to OpenIT (if there isn't).\n\nThe bot will treat your DMs exactly the same as any employee's — that's the point. You're test-driving the asker experience.",
        action: { kind: 'verify-dm' },
      },
    ],
    freeform:
      'Heads-up: the bot is online while OpenIT is running. Force-quitting OpenIT can leave the listener orphaned.',
  };
}

/// State for an already-connected project — three actions: re-verify,
/// disconnect, and a status hint that points at the header pill for
/// live counts. The skill renders this when `.openit/slack.json`
/// already exists at pill-click time.
export function buildManageState(config: SlackConfig): SkillCanvasState {
  return {
    skill: 'connect-slack',
    title: 'Slack',
    subtitle: `Connected to ${config.workspace_name} as @${config.bot_name}`,
    active: true,
    steps: [
      {
        id: 'status',
        title: 'Listener status',
        status: 'active',
        body: 'Live counts (sessions, open tickets) live on the Slack pill in the header. Click the pill to refresh; right-click it for stop / start.',
      },
      {
        id: 'verify',
        title: 'Re-verify roundtrip',
        status: 'pending',
        body: 'DM yourself an intro to confirm the bot still responds end-to-end.',
        action: { kind: 'verify-dm' },
      },
      {
        id: 'disconnect',
        title: 'Disconnect',
        status: 'pending',
        body: "Stops the listener, removes both tokens from Keychain, deletes .openit/slack.json. You'll need to reconnect to use Slack again.",
        action: {
          kind: 'button',
          label: 'Disconnect Slack',
          injectOnClick:
            '(canvas) admin clicked Disconnect Slack — please confirm and run the disconnect',
        },
      },
    ],
  };
}
