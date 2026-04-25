import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { claudeDetect } from "./lib/api";
import { PinkfishOauthModal } from "./PinkfishOauthModal";
import type { PinkfishCreds } from "./lib/pinkfishAuth";

const CLAUDE_INSTALL_DOCS = "https://docs.anthropic.com/claude/docs/claude-code";

type StepProps = {
  n: number;
  title: string;
  state: "pending" | "active" | "done" | "skipped";
  detail?: React.ReactNode;
  action?: React.ReactNode;
};

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

  useEffect(() => {
    claudeDetect()
      .then((p) => setClaudePath(p))
      .catch(() => setClaudePath(null));
  }, []);

  const claudeReady = typeof claudePath === "string" && claudePath !== null;
  const canContinue = pinkfishConnected;

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
          title="Connect Slack or Teams"
          state="skipped"
          detail="Coming soon. Skip for now — you can connect later from settings."
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
