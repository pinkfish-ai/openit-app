// SkillActionDock — chat-anchored secret-paste affordance.
//
// Why this exists at all: tokens (Slack bot token / app-level
// token) can't go through chat history without ending up in
// scrollback, transcript files, or screen-shares. The dock is the
// carve-out — a button that appears under the chat at exactly the
// moment Claude asks for a token. Clicking it expands the row
// in-place to a password input; submit feeds the token straight
// into Keychain via Tauri commands. Claude sees a short natural-
// prose confirmation echoed back through the chat (no internal
// prefix like `(canvas)` — that leaked obsolete UI vocabulary
// into the user's scrollback).
//
// In-place expansion (rather than a modal) was a deliberate
// simplification — a modal felt heavier than the moment warrants.
// The dock is otherwise invisible. It's driven by a single field
// — `dock` — written by Claude (via the existing
// `.openit/skill-state/<skill>.json` side channel) when the chat
// reaches a paste step. Anywhere else the dock returns null.

import { useEffect, useState } from "react";
import {
  type SlackStatus,
  slackConnect,
  slackListenerStart,
  slackListenerStatus,
  slackValidateBotToken,
} from "../lib/api";
import {
  type DockKind,
  injectIntoChat,
} from "../lib/skillState";
import { useToast } from "../Toast";
import { Button } from "../ui";
import "./SkillActionDock.css";

type Props = {
  dock: DockKind | undefined;
  repo: string | null;
  orgId: string;
  intakeUrl: string | null;
  stagedBotToken: string | null;
  onStagedBotTokenChange: (t: string | null) => void;
};

export function SkillActionDock({
  dock,
  repo,
  orgId,
  intakeUrl,
  stagedBotToken,
  onStagedBotTokenChange,
}: Props) {
  // Are we showing the inline input or the trigger button? Reset
  // whenever the dock kind changes (so a stale "expanded" state
  // doesn't bleed into the next paste step).
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    setExpanded(false);
  }, [dock]);

  if (!repo) return null;
  if (dock !== "bot-token-paste" && dock !== "app-token-paste") return null;

  const isBot = dock === "bot-token-paste";

  if (!expanded) {
    return (
      <div className="skill-action-dock">
        <Button
          variant="subtle"
          onClick={() => setExpanded(true)}
          title={
            isBot
              ? "Paste your Slack bot token (xoxb-…)"
              : "Paste your Slack app-level token (xapp-…)"
          }
        >
          <span aria-hidden>🔒</span>
          <span>{isBot ? "Paste bot token" : "Paste app token"}</span>
        </Button>
        {stagedBotToken && isBot && (
          <span className="skill-action-dock-hint">
            bot token staged · waiting for app token
          </span>
        )}
      </div>
    );
  }

  return isBot ? (
    <BotTokenInline
      onCancel={() => setExpanded(false)}
      onStaged={(token) => {
        onStagedBotTokenChange(token);
        setExpanded(false);
      }}
    />
  ) : (
    <AppTokenInline
      repo={repo}
      orgId={orgId}
      intakeUrl={intakeUrl}
      stagedBotToken={stagedBotToken}
      onCancel={() => setExpanded(false)}
      onConnected={() => {
        onStagedBotTokenChange(null);
        setExpanded(false);
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Bot-token inline row — paste, validate, stage, inject
// confirmation back to Claude.
// ---------------------------------------------------------------------------

function BotTokenInline({
  onCancel,
  onStaged,
}: {
  onCancel: () => void;
  onStaged: (token: string) => void;
}) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  async function submit() {
    setError(null);
    if (!token.trim().startsWith("xoxb-")) {
      setError("Bot token should start with xoxb-");
      return;
    }
    setBusy(true);
    try {
      const meta = await slackValidateBotToken(token.trim());
      toast.show(`✓ Bot token validated for ${meta.workspace_name}`);
      await injectIntoChat(
        `Bot token saved — ${meta.workspace_name} as @${meta.bot_name}.`,
      );
      onStaged(token.trim());
    } catch (e) {
      setError(`Validate failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="skill-action-dock skill-action-dock-inline">
      <input
        type="password"
        className="skill-action-dock-input"
        placeholder="Paste xoxb-…"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        autoFocus
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") onCancel();
        }}
        disabled={busy}
      />
      <Button
        variant="primary"
        onClick={submit}
        disabled={busy}
        loading={busy}
      >
        {busy ? "Validating…" : "Save"}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        onClick={onCancel}
        disabled={busy}
        aria-label="Cancel"
      >
        ×
      </Button>
      {error && <span className="skill-action-dock-error">{error}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// App-token inline row — combines staged bot + this app token,
// calls slack_connect, starts the listener, injects confirmation.
// Two atomic halves so a bad app token surfaces at listener-start
// (the websocket handshake) instead of 5s later from a polling
// effect.
// ---------------------------------------------------------------------------

function AppTokenInline({
  repo,
  orgId,
  intakeUrl,
  stagedBotToken,
  onCancel,
  onConnected,
}: {
  repo: string;
  orgId: string;
  intakeUrl: string | null;
  stagedBotToken: string | null;
  onCancel: () => void;
  onConnected: () => void;
}) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<null | "connecting" | "starting">(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<SlackStatus | null>(null);
  const toast = useToast();

  useEffect(() => {
    let mounted = true;
    const tick = () =>
      slackListenerStatus()
        .then((s) => {
          if (mounted) setStatus(s);
        })
        .catch(() => {});
    tick();
    const id = setInterval(tick, 2_000);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, []);

  async function submit() {
    setError(null);
    if (!stagedBotToken) {
      setError("Paste the bot token first.");
      return;
    }
    if (!intakeUrl) {
      setError("Intake server isn't up yet — wait a moment and retry.");
      return;
    }
    if (!token.trim().startsWith("xapp-")) {
      setError("App token should start with xapp-");
      return;
    }
    setBusy("connecting");
    let meta;
    try {
      meta = await slackConnect({
        repo,
        orgId,
        botToken: stagedBotToken,
        appToken: token.trim(),
      });
    } catch (e) {
      setBusy(null);
      setError(`Connect failed: ${String(e)}`);
      return;
    }
    setBusy("starting");
    try {
      await slackListenerStart({ repo, intakeUrl, orgId });
      toast.show(`✓ Connected to ${meta.workspace_name} · listener up`);
      await injectIntoChat(
        `App token saved and listener up — connected to ${meta.workspace_name} as @${meta.bot_name}.`,
      );
      onConnected();
    } catch (e) {
      const msg = String(e);
      await injectIntoChat(
        `App token saved but listener failed to start: ${msg}. Most likely the xapp- token is wrong (typo, missing connections:write scope, or never generated). I can re-paste a fresh one.`,
      );
      setError(`Listener failed to start: ${msg}`);
    } finally {
      setBusy(null);
    }
  }

  const listenerDown = status !== null && !status.running;

  return (
    <div className="skill-action-dock skill-action-dock-inline">
      <input
        type="password"
        className="skill-action-dock-input"
        placeholder={stagedBotToken ? "Paste xapp-…" : "(paste bot token first)"}
        value={token}
        onChange={(e) => setToken(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        autoFocus
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") onCancel();
        }}
        disabled={busy !== null || !stagedBotToken}
      />
      <Button
        variant="primary"
        onClick={submit}
        disabled={busy !== null || !stagedBotToken}
        loading={busy !== null}
      >
        {busy === "connecting"
          ? "Validating…"
          : busy === "starting"
            ? "Starting listener…"
            : "Connect"}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        onClick={onCancel}
        disabled={busy !== null}
        aria-label="Cancel"
      >
        ×
      </Button>
      {error && <span className="skill-action-dock-error">{error}</span>}
      {!error && listenerDown && status?.last_error && (
        <span className="skill-action-dock-hint">
          last listener exit: {status.last_error}
        </span>
      )}
    </div>
  );
}
