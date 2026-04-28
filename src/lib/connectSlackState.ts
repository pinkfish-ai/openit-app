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

import type { SkillCanvasState } from "./skillCanvas";
import type { SlackConfig } from "./api";

/// State for a fresh setup — no .openit/slack.json yet. Six steps,
/// the first marked active. Pill click writes this, the canvas
/// renders it, the skill drives it forward.
export function buildSetupState(): SkillCanvasState {
  return {
    skill: "connect-slack",
    title: "Connect Slack",
    subtitle: "Bring the OpenIT bot to your workspace",
    active: true,
    steps: [
      {
        id: "workspace-check",
        title: "Have a Slack workspace ready",
        status: "active",
        body: "You'll need a Slack workspace where you can install custom apps (workspace admin, or admin permission to install).",
      },
      {
        id: "create-app",
        title: "Create the Slack app from manifest",
        status: "pending",
        body: "Click Copy below, then in your browser go to api.slack.com/apps → Create New App → From an app manifest → pick your workspace → paste → Next → Create.",
        action: { kind: "copy-manifest" },
      },
      {
        id: "install",
        title: "Install + grab the bot token",
        status: "pending",
        body: "Click Install to Workspace and approve. The Bot User OAuth Token (xoxb-…) appears on the Install App page right after install. Copy it.",
      },
      {
        id: "app-token",
        title: "Generate the app-level token (Socket Mode)",
        status: "pending",
        body: "Basic Information → App-Level Tokens → Generate Token and Scopes. Add the connections:write scope, click Generate, copy the xapp-… token.",
      },
      {
        id: "paste-tokens",
        title: "Paste both tokens here",
        status: "pending",
        body: "Paste the bot token (xoxb-) and app token (xapp-) below. They go straight to macOS Keychain — never typed in the chat.",
        action: { kind: "token-input" },
      },
      {
        id: "verify",
        title: "Verify roundtrip",
        status: "pending",
        body: "Send yourself an intro DM. Reply with a question to confirm the bot answers. The bot will treat your DMs the same as any employee's — that's the point.",
        action: { kind: "verify-dm" },
      },
    ],
    freeform:
      "Heads-up: the bot is online while OpenIT is running. Force-quitting OpenIT can leave the listener orphaned — ask in the chat 'what happens when I quit?' if you hit that.",
  };
}

/// State for an already-connected project — three actions: re-verify,
/// disconnect, and a status hint that points at the header pill for
/// live counts. The skill renders this when `.openit/slack.json`
/// already exists at pill-click time.
export function buildManageState(config: SlackConfig): SkillCanvasState {
  return {
    skill: "connect-slack",
    title: "Slack",
    subtitle: `Connected to ${config.workspace_name} as @${config.bot_name}`,
    active: true,
    steps: [
      {
        id: "status",
        title: "Listener status",
        status: "active",
        body: "Live counts (sessions, open tickets) live on the Slack pill in the header. Click the pill to refresh; right-click it for stop / start.",
      },
      {
        id: "verify",
        title: "Re-verify roundtrip",
        status: "pending",
        body: "DM yourself an intro to confirm the bot still responds end-to-end.",
        action: { kind: "verify-dm" },
      },
      {
        id: "disconnect",
        title: "Disconnect",
        status: "pending",
        body: "Stops the listener, removes both tokens from Keychain, deletes .openit/slack.json. You'll need to reconnect to use Slack again.",
        action: {
          kind: "button",
          label: "Disconnect Slack",
          injectOnClick:
            "(canvas) admin clicked Disconnect Slack — please confirm and run the disconnect",
        },
      },
    ],
  };
}
