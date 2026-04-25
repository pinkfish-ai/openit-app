import { useCallback, useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { claudeDetect, pinkfishListConnections, type UserConnection } from "./lib/api";
import { PinkfishOauthModal } from "./PinkfishOauthModal";
import { getToken, subscribeToken, type PinkfishCreds } from "./lib/pinkfishAuth";

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
      <button type="button" className="chat-pill-btn" onClick={onClick}>
        {connected ? "manage" : "connect"}
      </button>
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
  onContinue,
}: {
  pinkfishConnected: boolean;
  pinkfishOrgName: string | null;
  initialCreds: Partial<PinkfishCreds> | null;
  onPinkfishConnected: (orgName: string | null) => void;
  onContinue: () => void;
}) {
  const [claudePath, setClaudePath] = useState<string | null | "loading">("loading");
  const [authOpen, setAuthOpen] = useState(false);
  const [chat, setChat] = useState<{
    state: "idle" | "loading" | "ready";
    slack: UserConnection | null;
    teams: UserConnection | null;
  }>({ state: "idle", slack: null, teams: null });

  useEffect(() => {
    claudeDetect()
      .then((p) => setClaudePath(p))
      .catch(() => setClaudePath(null));
  }, []);

  const refreshChat = useCallback(() => {
    const token = getToken();
    if (!token) {
      setChat({ state: "idle", slack: null, teams: null });
      return;
    }
    setChat((c) => ({ ...c, state: "loading" }));
    pinkfishListConnections({ accessToken: token.accessToken })
      .then((conns) => {
        const { slack, teams } = findChat(conns);
        setChat({ state: "ready", slack, teams });
      })
      .catch((e) => {
        console.error("list connections failed:", e);
        setChat({ state: "ready", slack: null, teams: null });
      });
  }, []);

  // Re-fetch connections whenever the token transitions (initial load or
  // after the user just connected Pinkfish).
  useEffect(() => {
    const unsub = subscribeToken(() => refreshChat());
    return () => {
      unsub();
    };
  }, [refreshChat]);

  const claudeReady = typeof claudePath === "string" && claudePath !== null;
  const canContinue = pinkfishConnected;
  const chatConnected = chat.slack !== null || chat.teams !== null;

  return (
    <div className="onboard">
      <div className="onboard-card">
        <h1 className="onboard-title">Welcome to OpenIT</h1>
        <p className="onboard-subtitle">
          A Claude Code powered IT solution.
        </p>

        <Step
          n={1}
          title={
            pinkfishConnected
              ? `Connected to ${pinkfishOrgName ?? "Pinkfish"}`
              : "Connect Pinkfish"
          }
          state={pinkfishConnected ? "done" : "active"}
          detail={
            pinkfishConnected ? null : (
              <>
                Sign in or create an account to get OAuth credentials, then paste them here.
              </>
            )
          }
          action={
            <button
              className={pinkfishConnected ? "icon-btn key-set" : "deploy-btn"}
              onClick={() => setAuthOpen(true)}
            >
              {pinkfishConnected ? "Update" : "Connect"}
            </button>
          }
        />

        <Step
          n={2}
          title={claudeReady ? "Claude Code detected" : "Install Claude Code"}
          state={
            claudePath === "loading" ? "active" : claudeReady ? "done" : "active"
          }
          detail={
            claudePath === "loading" ? (
              "Checking your PATH…"
            ) : claudeReady ? (
              <code className="onboard-path">{claudePath as string}</code>
            ) : (
              <>
                <code>claude</code> isn't on your PATH yet.{" "}
                <a
                  href={CLAUDE_INSTALL_DOCS}
                  onClick={(e) => {
                    e.preventDefault();
                    openUrl(CLAUDE_INSTALL_DOCS).catch(console.error);
                  }}
                >
                  Install instructions
                </a>
                {". After installing, click Re-check."}
              </>
            )
          }
          action={
            !claudeReady && claudePath !== "loading" ? (
              <button
                className="icon-btn"
                onClick={() => {
                  setClaudePath("loading");
                  claudeDetect().then(setClaudePath).catch(() => setClaudePath(null));
                }}
              >
                Re-check
              </button>
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
          <button
            className="deploy-btn onboard-continue"
            onClick={onContinue}
            disabled={!canContinue}
            title={canContinue ? "" : "Connect Pinkfish to continue"}
          >
            {pinkfishOrgName ? `Open ${pinkfishOrgName}` : "Continue to OpenIT"}
          </button>
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
