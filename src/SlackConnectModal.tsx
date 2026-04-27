// Slack connect modal — token entry, validate, listener start, intro DM,
// disconnect. The /connect-slack skill walks the admin to the point where
// they have the two tokens, then tells them to click the Slack pill in the
// header to open this modal. The modal is the actuator; the skill is the
// guide. Same pattern as connect-to-cloud + the key icon.

import { useEffect, useState } from "react";
import {
  type SlackConfig,
  type SlackStatus,
  slackConnect,
  slackDisconnect,
  slackListenerSendIntro,
  slackListenerStart,
  slackListenerStatus,
  slackListenerStop,
} from "./lib/api";
import "./SlackConnectModal.css";

// Source of truth for the Slack app manifest the admin pastes into
// api.slack.com → Create New App → From an app manifest. Kept inline
// here so the Copy button is one click away — copying from the
// Claude terminal output is unreliable (line wrapping breaks the
// YAML, see incident with `messages_tab_read_only_enabled: false`
// getting split across lines). The connect-slack skill text mirrors
// this same content for human reference; if you change one, change
// both.
const SLACK_APP_MANIFEST = `display_information:
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
`;

type Props = {
  repo: string;
  orgId: string;
  intakeUrl: string;
  initialConfig: SlackConfig | null;
  initialStatus: SlackStatus | null;
  adminEmail: string | null;
  onClose: () => void;
  onChanged: () => void;
};

export function SlackConnectModal({
  repo,
  orgId,
  intakeUrl,
  initialConfig,
  initialStatus,
  adminEmail,
  onClose,
  onChanged,
}: Props) {
  // Three views drive everything:
  //   - "connect": no .openit/slack.json yet → show the two token inputs
  //   - "manage":  already connected → show meta, listener status, intro
  //                DM button, disconnect button
  //   - "starting" / "verifying": transient action states
  const [config, setConfig] = useState<SlackConfig | null>(initialConfig);
  const [status, setStatus] = useState<SlackStatus | null>(initialStatus);
  const [busy, setBusy] = useState<null | "connecting" | "starting" | "stopping" | "verifying" | "disconnecting">(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [introSent, setIntroSent] = useState(false);
  const [manifestCopied, setManifestCopied] = useState(false);
  const [botToken, setBotToken] = useState("");
  const [appToken, setAppToken] = useState("");
  const [introEmail, setIntroEmail] = useState(adminEmail ?? "");

  async function handleCopyManifest() {
    setError(null);
    try {
      await navigator.clipboard.writeText(SLACK_APP_MANIFEST);
      setManifestCopied(true);
      // Auto-clear the "copied!" pill after a few seconds so the
      // button reverts to its idle label and the user can copy
      // again if they accidentally clobbered the clipboard.
      window.setTimeout(() => setManifestCopied(false), 4_000);
    } catch (e) {
      setError(`Copy failed: ${String(e)}. Select the YAML manually from the skill output and copy with Cmd+C.`);
    }
  }

  // While the modal is open, poll status every 2s so the "running"
  // pill flips quickly after start/stop without needing the user to
  // close + reopen.
  useEffect(() => {
    let mounted = true;
    const tick = () =>
      slackListenerStatus()
        .then((s) => {
          if (mounted) setStatus(s);
        })
        .catch(() => {});
    const id = setInterval(tick, 2_000);
    tick();
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, []);

  const refreshConfigAndPropagate = async () => {
    onChanged();
  };

  async function handleConnect() {
    setError(null);
    if (!botToken.trim().startsWith("xoxb-")) {
      setError("Bot token should start with xoxb-");
      return;
    }
    if (!appToken.trim().startsWith("xapp-")) {
      setError("App token should start with xapp-");
      return;
    }
    setBusy("connecting");
    try {
      const meta = await slackConnect({
        repo,
        orgId,
        botToken: botToken.trim(),
        appToken: appToken.trim(),
      });
      setConfig({
        workspace_id: meta.workspace_id,
        workspace_name: meta.workspace_name,
        bot_user_id: meta.bot_user_id,
        bot_name: meta.bot_name,
        connected_at: meta.connected_at,
        allowed_domains: [],
      });
      setBotToken("");
      setAppToken("");
      // Auto-start the listener immediately — the connect step is
      // pointless if the bot isn't actually online afterwards.
      setBusy("starting");
      try {
        await slackListenerStart({ repo, intakeUrl, orgId });
      } catch (startErr) {
        setError(`Connected, but listener failed to start: ${String(startErr)}`);
      }
      await refreshConfigAndPropagate();
    } catch (e) {
      setError(`Connect failed: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  async function handleStart() {
    setError(null);
    setBusy("starting");
    try {
      await slackListenerStart({ repo, intakeUrl, orgId });
      await refreshConfigAndPropagate();
    } catch (e) {
      setError(`Start failed: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  async function handleStop() {
    setError(null);
    setBusy("stopping");
    try {
      await slackListenerStop();
      await refreshConfigAndPropagate();
    } catch (e) {
      setError(`Stop failed: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  async function handleSendIntro() {
    setError(null);
    setIntroSent(false);
    if (!introEmail.trim() || !introEmail.includes("@")) {
      setError("Enter the email of the Slack user to DM");
      return;
    }
    setBusy("verifying");
    try {
      await slackListenerSendIntro({
        targetEmail: introEmail.trim(),
        text:
          "Hi! I'm the OpenIT triage bot. Try asking me a question — e.g. \"how do I reset my Mac password?\" — and I'll either answer from your knowledge base or escalate to your IT team.",
      });
      setIntroSent(true);
    } catch (e) {
      setError(`Send intro failed: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  async function handleDisconnect() {
    if (
      !window.confirm(
        "Disconnect Slack? This stops the listener, removes the tokens from keychain, and deletes .openit/slack.json. You can reconnect anytime.",
      )
    ) {
      return;
    }
    setError(null);
    setBusy("disconnecting");
    try {
      await slackDisconnect({ repo, orgId });
      setConfig(null);
      setStatus(null);
      await refreshConfigAndPropagate();
    } catch (e) {
      setError(`Disconnect failed: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="slack-modal-backdrop" onClick={onClose}>
      <div className="slack-modal" onClick={(e) => e.stopPropagation()}>
        <header className="slack-modal-header">
          <h2>Connect Slack</h2>
          <button className="slack-modal-close" onClick={onClose} title="Close">
            ×
          </button>
        </header>

        {!config && (
          <section className="slack-modal-body">
            <p className="slack-modal-blurb">
              Run the <code>/connect-slack</code> skill in the chat pane for the
              full walkthrough. The short version is below.
            </p>
            <ol className="slack-modal-steps">
              <li>
                Click <strong>Copy Slack app manifest</strong> below.
              </li>
              <li>
                At <a
                  href="https://api.slack.com/apps"
                  target="_blank"
                  rel="noreferrer"
                >
                  api.slack.com/apps
                </a>{" "}
                → <strong>Create New App</strong> →{" "}
                <strong>From an app manifest</strong> → pick your workspace →
                paste → Next → Create.
              </li>
              <li>
                <strong>Install to Workspace</strong>. Copy the{" "}
                <code>xoxb-</code> bot token shown right after install.
              </li>
              <li>
                <strong>Basic Information</strong> → <strong>App-Level Tokens</strong>
                → Generate a token with <code>connections:write</code> scope. Copy
                the <code>xapp-</code>.
              </li>
              <li>Paste both tokens below and click <strong>Connect</strong>.</li>
            </ol>
            <button
              type="button"
              className="slack-modal-secondary"
              onClick={handleCopyManifest}
              disabled={busy !== null}
            >
              {manifestCopied ? "✓ Copied to clipboard" : "Copy Slack app manifest"}
            </button>
            <label className="slack-modal-field">
              <span>Bot User OAuth Token</span>
              <input
                type="password"
                placeholder="xoxb-..."
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label className="slack-modal-field">
              <span>App-Level Token (Socket Mode)</span>
              <input
                type="password"
                placeholder="xapp-..."
                value={appToken}
                onChange={(e) => setAppToken(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <button
              className="slack-modal-primary"
              onClick={handleConnect}
              disabled={busy !== null}
            >
              {busy === "connecting"
                ? "Validating tokens…"
                : busy === "starting"
                  ? "Starting listener…"
                  : "Connect"}
            </button>
          </section>
        )}

        {config && (
          <section className="slack-modal-body">
            <dl className="slack-modal-meta">
              <dt>Workspace</dt>
              <dd>
                {config.workspace_name}{" "}
                <code className="slack-modal-id">({config.workspace_id})</code>
              </dd>
              <dt>Bot</dt>
              <dd>
                @{config.bot_name}{" "}
                <code className="slack-modal-id">({config.bot_user_id})</code>
              </dd>
              <dt>Listener</dt>
              <dd>
                {status?.running ? (
                  <span className="slack-modal-running">
                    ● Running
                    {status.last_heartbeat && (
                      <>
                        {" "}
                        — {status.last_heartbeat.sessions} session
                        {status.last_heartbeat.sessions === 1 ? "" : "s"},{" "}
                        {status.last_heartbeat.open_tickets} open ticket
                        {status.last_heartbeat.open_tickets === 1 ? "" : "s"}
                      </>
                    )}
                  </span>
                ) : (
                  <span className="slack-modal-stopped">○ Stopped</span>
                )}
              </dd>
              {status?.last_error && (
                <>
                  <dt>Last error</dt>
                  <dd className="slack-modal-error-line">{status.last_error}</dd>
                </>
              )}
            </dl>

            <div className="slack-modal-actions">
              {status?.running ? (
                <button onClick={handleStop} disabled={busy !== null}>
                  {busy === "stopping" ? "Stopping…" : "Stop listener"}
                </button>
              ) : (
                <button
                  onClick={handleStart}
                  disabled={busy !== null}
                  className="slack-modal-primary"
                >
                  {busy === "starting" ? "Starting…" : "Start listener"}
                </button>
              )}
            </div>

            <hr className="slack-modal-rule" />

            <div className="slack-modal-verify">
              <h3>Verify roundtrip</h3>
              <p className="slack-modal-blurb">
                Send yourself an intro DM. Look up your Slack account by email
                — the listener will lookup your Slack user and DM you. Then
                reply with a test question and watch the bot answer.
              </p>
              <label className="slack-modal-field">
                <span>Slack user email to DM</span>
                <input
                  type="email"
                  placeholder="you@company.com"
                  value={introEmail}
                  onChange={(e) => setIntroEmail(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <button
                onClick={handleSendIntro}
                disabled={busy !== null || !status?.running}
                title={
                  !status?.running ? "Listener must be running to send intro" : ""
                }
              >
                {busy === "verifying" ? "Sending…" : "Send intro DM"}
              </button>
              {introSent && (
                <p className="slack-modal-success">
                  Sent. Check Slack — the bot should be in your DMs now.
                </p>
              )}
            </div>

            <hr className="slack-modal-rule" />

            <div className="slack-modal-danger">
              <button
                className="slack-modal-disconnect"
                onClick={handleDisconnect}
                disabled={busy !== null}
              >
                {busy === "disconnecting" ? "Disconnecting…" : "Disconnect Slack"}
              </button>
            </div>
          </section>
        )}

        {error && <div className="slack-modal-error">{error}</div>}
      </div>
    </div>
  );
}
