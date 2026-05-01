import { useCallback, useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  claudeDetect,
  claudeInstall,
  pinkfishListConnections,
  type UserConnection,
} from "./lib/api";
import { Button } from "./ui";
import { PinkfishOauthModal } from "./PinkfishOauthModal";
import { stopFilestoreSync } from "./lib/filestoreSync";
import { stopKbSync } from "./lib/kbSync";
import { stopDatastoreSync } from "./lib/datastoreSync";
import { stopAgentSync } from "./lib/agentSync";
import { stopWorkflowSync } from "./lib/workflowSync";
import {
  DEFAULT_TOKEN_URL,
  derivedUrls,
  getToken,
  loadCreds,
  subscribeToken,
  type PinkfishCreds,
} from "./lib/pinkfishAuth";
import type { BrowserConnectState } from "./lib/useBrowserConnect";

const CLAUDE_INSTALL_DOCS = "https://docs.anthropic.com/claude/docs/claude-code";
const CONNECTIONS_NEW_URL = "https://app.pinkfish.ai/tools/connections/new";
const CONNECTIONS_MANAGE_URL = "https://app.pinkfish.ai/tools/connections";
const SLACK_ICON = "https://app.pinkfish.ai/connection_icons/slack.svg";
const TEAMS_ICON = "https://app.pinkfish.ai/connection_icons/microsoft-teams.svg";

function findChat(connections: UserConnection[]): {
  slack: UserConnection | null;
  teams: UserConnection | null;
} {
  const slack =
    connections.find(
      (c) => c.service_key.toLowerCase() === "slack" && c.status === "connected",
    ) ?? null;
  const teams =
    connections.find(
      (c) =>
        (c.service_key.toLowerCase() === "microsoft-teams" ||
          c.service_key.toLowerCase() === "teams") &&
        c.status === "connected",
    ) ?? null;
  return { slack, teams };
}

type StepProps = {
  n: number;
  title: string;
  state: "pending" | "active" | "done" | "skipped";
  detail?: React.ReactNode;
  action?: React.ReactNode;
};

function ChannelPill({
  icon,
  label,
  connected,
}: {
  icon: string;
  label: string;
  connected: boolean;
}) {
  const onClick = () => {
    openUrl(connected ? CONNECTIONS_MANAGE_URL : CONNECTIONS_NEW_URL).catch(console.error);
  };
  return (
    <span className={`chat-pill ${connected ? "" : "faint"}`}>
      <img src={icon} alt={label} />
      {label}
      <Button variant="subtle" size="sm" onClick={onClick}>
        {connected ? "manage" : "connect"}
      </Button>
    </span>
  );
}

function Step({ n, title, state, detail, action }: StepProps) {
  return (
    <div className={`onboard-step ${state}`}>
      <div className="onboard-step-num">{state === "done" ? "✓" : n}</div>
      <div className="onboard-step-body">
        <div className="onboard-step-title">{title}</div>
        {detail && <div className="onboard-step-detail">{detail}</div>}
      </div>
      {action && <div className="onboard-step-action">{action}</div>}
    </div>
  );
}

export function Onboarding({
  pinkfishConnected,
  pinkfishOrgName,
  initialCreds,
  onPinkfishConnected,
  onPinkfishDisconnected,
  onContinue,
  browserConnect,
  startBrowserConnect,
  cancelBrowserConnect,
}: {
  pinkfishConnected: boolean;
  pinkfishOrgName: string | null;
  initialCreds: Partial<PinkfishCreds> | null;
  onPinkfishConnected: (orgName: string | null) => void;
  onPinkfishDisconnected: () => void;
  onContinue: () => void;
  // Browser-handoff state hoisted to App so the in-shell cloud-cta and
  // the onboarding screen drive the same flow with shared state.
  browserConnect: BrowserConnectState;
  startBrowserConnect: () => void;
  cancelBrowserConnect: () => void;
}) {
  const [claudePath, setClaudePath] = useState<string | null | "loading" | "installing">(
    "loading",
  );
  const [claudeInstallError, setClaudeInstallError] = useState<string | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [chat, setChat] = useState<{
    state: "idle" | "loading" | "ready";
    slack: UserConnection | null;
    teams: UserConnection | null;
  }>({ state: "idle", slack: null, teams: null });

  // Auto-install Claude Code on first run if it's missing. The native
  // installer drops the binary at ~/.local/bin/claude and updates the user's
  // shell rc; the Rust side also probes that dir directly so the GUI app
  // sees the binary without a terminal restart.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const detected = await claudeDetect();
        if (cancelled) return;
        if (detected) {
          setClaudePath(detected);
          return;
        }
        setClaudePath("installing");
        setClaudeInstallError(null);
        try {
          const installed = await claudeInstall();
          if (cancelled) return;
          setClaudePath(installed);
        } catch (err) {
          if (cancelled) return;
          console.error("claude install failed:", err);
          setClaudeInstallError(
            err instanceof Error ? err.message : String(err),
          );
          setClaudePath(null);
        }
      } catch {
        if (!cancelled) setClaudePath(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const retryInstall = useCallback(async () => {
    setClaudePath("installing");
    setClaudeInstallError(null);
    try {
      const installed = await claudeInstall();
      setClaudePath(installed);
    } catch (err) {
      console.error("claude install retry failed:", err);
      setClaudeInstallError(err instanceof Error ? err.message : String(err));
      setClaudePath(null);
    }
  }, []);

  const refreshChat = useCallback(async () => {
    const token = getToken();
    if (!token) {
      setChat({ state: "idle", slack: null, teams: null });
      return;
    }
    setChat((c) => ({ ...c, state: "loading" }));
    try {
      const creds = await loadCreds();
      const urls = derivedUrls(creds?.tokenUrl ?? DEFAULT_TOKEN_URL);
      const conns = await pinkfishListConnections({
        accessToken: token.accessToken,
        connectionsUrl: urls.connectionsUrl,
      });
      const { slack, teams } = findChat(conns);
      setChat({ state: "ready", slack, teams });
    } catch (e) {
      console.error("list connections failed:", e);
      setChat({ state: "ready", slack: null, teams: null });
    }
  }, []);

  // Re-fetch connections whenever the token transitions (initial load or
  // after the user just connected Pinkfish).
  useEffect(() => {
    const unsub = subscribeToken(() => refreshChat());
    return () => {
      unsub();
    };
  }, [refreshChat]);

  // Stop background syncs while the auth modal is open
  useEffect(() => {
    if (authOpen) {
      stopKbSync();
      stopFilestoreSync();
      stopDatastoreSync();
      stopAgentSync();
      stopWorkflowSync();
    }
  }, [authOpen]);

  const claudeReady = typeof claudePath === "string" && claudePath !== null;
  // Continue is always enabled now: local-only is a valid end state, so
  // "Continue without Pinkfish" should bring the user into the shell
  // (Phase 3a's local bootstrap). The label changes when not connected
  // so the user understands they're skipping the cloud upgrade.
  const canContinue = true;
  const chatConnected = chat.slack !== null || chat.teams !== null;

  return (
    <div className="onboard">
      <div className="onboard-card">
        <div className="onboard-wordmark">
          <span className="onboard-title">OpenIT</span>
          <span className="onboard-tagline">get IT done</span>
        </div>
        <p className="onboard-subtitle">
          A Claude-powered IT cockpit for small teams. Local-first,
          cloud-optional.
        </p>

        <Step
          n={1}
          title={
            pinkfishConnected
              ? `Connected to ${pinkfishOrgName ?? "Pinkfish"}. Sync coming soon.`
              : "Connect to Cloud"
          }
          state={pinkfishConnected ? "done" : "active"}
          detail={
            pinkfishConnected ? null : browserConnect.kind === "waiting" ? (
              <>
                Authorize OpenIT in the browser tab that just opened.
                We'll detect the response automatically.
              </>
            ) : browserConnect.kind === "validating" ? (
              <>Validating credentials…</>
            ) : browserConnect.kind === "starting" ? (
              <>Opening your browser…</>
            ) : browserConnect.kind === "error" ? (
              <span style={{ color: "#b91c1c" }}>
                {browserConnect.message}
              </span>
            ) : (
              <>
                Open the browser to sign in to Pinkfish and authorize this
                machine. Or use{" "}
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    setAuthOpen(true);
                  }}
                >
                  advanced (paste credentials)
                </a>
                .
              </>
            )
          }
          action={
            pinkfishConnected ? (
              <span style={{ display: "inline-flex", gap: 6 }}>
                <Button variant="secondary" onClick={() => setAuthOpen(true)}>
                  Update
                </Button>
                <Button
                  variant="secondary"
                  tone="destructive"
                  onClick={async () => {
                    const ok = await ask(
                      "Disconnect from Pinkfish?\n\nYour local files stay. The credential on this machine is removed; Pinkfish-side, the API key remains until you delete it from Settings → API Credentials.",
                      { title: "Disconnect from Pinkfish?", kind: "warning" },
                    );
                    if (ok) onPinkfishDisconnected();
                  }}
                  title="Remove the Pinkfish credential from this machine"
                >
                  Disconnect
                </Button>
              </span>
            ) : browserConnect.kind === "waiting" ||
              browserConnect.kind === "starting" ||
              browserConnect.kind === "validating" ? (
              <Button variant="secondary" onClick={cancelBrowserConnect}>
                Cancel
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={startBrowserConnect}
                disabled={
                  browserConnect.kind !== "idle" &&
                  browserConnect.kind !== "error"
                }
              >
                Connect
              </Button>
            )
          }
        />

        <Step
          n={2}
          title={
            claudeReady
              ? "Claude Code installed"
              : claudePath === "installing"
                ? "Installing Claude Code…"
                : claudePath === "loading"
                  ? "Checking for Claude Code"
                  : "Install Claude Code"
          }
          state={
            claudePath === "loading" || claudePath === "installing"
              ? "active"
              : claudeReady
                ? "done"
                : "active"
          }
          detail={
            claudePath === "loading" ? (
              "Checking your PATH…"
            ) : claudePath === "installing" ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <span className="sc-spinner" aria-hidden="true" />
                <span>
                  Downloading from{" "}
                  <code>claude.ai/install.sh</code> — this takes a few seconds.
                </span>
              </span>
            ) : claudeReady ? (
              <code className="onboard-path">{claudePath as string}</code>
            ) : (
              <>
                <div style={{ color: "#b91c1c", marginBottom: 4 }}>
                  Auto-install failed. Retry, or{" "}
                  <a
                    href={CLAUDE_INSTALL_DOCS}
                    onClick={(e) => {
                      e.preventDefault();
                      openUrl(CLAUDE_INSTALL_DOCS).catch(console.error);
                    }}
                  >
                    install manually
                  </a>
                  .
                </div>
                {claudeInstallError ? (
                  <pre className="onboard-error-pre">{claudeInstallError}</pre>
                ) : null}
              </>
            )
          }
          action={
            !claudeReady &&
            claudePath !== "loading" &&
            claudePath !== "installing" ? (
              <Button variant="secondary" onClick={retryInstall}>
                Retry
              </Button>
            ) : null
          }
        />

        <Step
          n={3}
          title={chatConnected ? "Connected to channels" : "Connect channels"}
          state={
            !pinkfishConnected || chat.state === "loading"
              ? "active"
              : chatConnected
                ? "done"
                : "skipped"
          }
          detail={
            !pinkfishConnected ? (
              "Connect Pinkfish first to check your chat connections."
            ) : chat.state === "loading" ? (
              "Checking your connections…"
            ) : (
              <span className="chat-row">
                <ChannelPill
                  icon={SLACK_ICON}
                  label="Slack"
                  connected={chat.slack !== null}
                />
                <ChannelPill
                  icon={TEAMS_ICON}
                  label="Teams"
                  connected={chat.teams !== null}
                />
                {!chatConnected && (
                  <span className="chat-hint">optional, you can connect later</span>
                )}
              </span>
            )
          }
        />

        <div className="onboard-actions">
          <Button
            variant="primary"
            size="lg"
            onClick={onContinue}
            disabled={!canContinue}
            title={
              pinkfishConnected
                ? ""
                : "Continue without Pinkfish — your project stays local"
            }
          >
            {pinkfishConnected ? "Continue" : "Continue without Pinkfish"}
          </Button>
          {!pinkfishConnected && (
            <Button
              variant="secondary"
              size="lg"
              onClick={() =>
                openUrl("https://app.pinkfish.ai/signup").catch(console.error)
              }
            >
              Sign Up
            </Button>
          )}
        </div>
      </div>

      {authOpen && (
        <PinkfishOauthModal
          initial={initialCreds}
          onClose={() => setAuthOpen(false)}
          onConnected={onPinkfishConnected}
        />
      )}
    </div>
  );
}
