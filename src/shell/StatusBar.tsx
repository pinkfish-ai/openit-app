import { openUrl } from "@tauri-apps/plugin-opener";
import type { SlackConfig, SlackStatus } from "../lib/api";

function basename(p: string): string {
  const parts = p.split("/").filter((s) => s.length > 0);
  return parts[parts.length - 1] ?? p;
}

/**
 * Bottom status rail. One quiet line of chips that surfaces the
 * "what's going on right now" state without stealing screen space.
 * Cmd-K hint lives only in the top header — not duplicated here.
 */
export function StatusBar({
  repo,
  cloudConnected,
  orgName,
  intakeUrl,
  slackConfig,
  slackStatus,
  changeCount,
  onOpenPalette,
}: {
  repo: string | null;
  cloudConnected: boolean;
  orgName: string | null;
  intakeUrl: string | null;
  slackConfig: SlackConfig | null;
  slackStatus: SlackStatus | null;
  changeCount: number;
  onOpenPalette: () => void;
}) {
  const projectName = repo ? basename(repo) : "no project";
  const slackRunning = !!slackStatus?.running;

  // When the project name and the cloud-state label are the same string
  // (e.g. fresh local-only install where basename(repo) === "local" and
  // the cloud chip would also say "local"), collapse them so we don't
  // render two pills both saying "local".
  const cloudLabel = cloudConnected ? orgName ?? "connected" : "local";
  const collapseProjectAndCloud =
    !cloudConnected && projectName.toLowerCase() === cloudLabel.toLowerCase();

  const intakeBare = intakeUrl?.replace(/^https?:\/\//, "");

  return (
    <div className="status-bar" role="status">
      <div className="status-bar-left">
        <button
          type="button"
          className={`status-chip status-chip-project ${
            collapseProjectAndCloud ? "status-chip-merged" : ""
          }`}
          title={
            collapseProjectAndCloud
              ? "Local-only project — click for the command palette"
              : "Project — click for the command palette"
          }
          onClick={onOpenPalette}
        >
          <span className="status-chip-glyph">◆</span>
          <span className="status-chip-label">
            {collapseProjectAndCloud ? `local · ${projectName}` : projectName}
          </span>
        </button>

        {!collapseProjectAndCloud && (
          <span
            className={`status-chip ${
              cloudConnected ? "status-chip-ok" : "status-chip-muted"
            }`}
            title={cloudConnected ? "Connected to Pinkfish Cloud" : "Local only"}
          >
            <span className="status-led" />
            <span className="status-chip-label">
              {cloudConnected ? `cloud · ${cloudLabel}` : "local"}
            </span>
          </span>
        )}

        {intakeUrl && (
          <button
            type="button"
            className="status-chip status-chip-info"
            title={`Intake form at ${intakeBare} — click to open in your browser`}
            onClick={() =>
              openUrl(intakeUrl).catch((e) =>
                console.warn("[status-bar] openUrl intake failed:", e),
              )
            }
          >
            <svg
              className="status-chip-icon"
              viewBox="0 0 14 14"
              width="11"
              height="11"
              aria-hidden
            >
              <rect x="2" y="2.5" width="10" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
              <line x1="4.5" y1="5.5" x2="9.5" y2="5.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              <line x1="4.5" y1="8" x2="8" y2="8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
            <span className="status-chip-label">
              Intake form · {intakeBare}
            </span>
          </button>
        )}

        {slackConfig && (
          <span
            className={`status-chip ${
              slackRunning ? "status-chip-ok" : "status-chip-warn"
            }`}
            title={
              slackRunning
                ? `Slack listener running (${
                    slackStatus?.last_heartbeat?.sessions ?? 0
                  } sessions)`
                : "Slack configured but not running"
            }
          >
            <span className="status-led" />
            <span className="status-chip-label">
              slack · @{slackConfig.bot_name}
              {slackRunning &&
                ` · ${slackStatus?.last_heartbeat?.sessions ?? 0}s`}
            </span>
          </span>
        )}

        {changeCount > 0 && (
          <span
            className="status-chip status-chip-warn"
            title="Uncommitted changes"
          >
            <span className="status-chip-glyph">●</span>
            <span className="status-chip-label">
              {changeCount} change{changeCount === 1 ? "" : "s"}
            </span>
          </span>
        )}
      </div>
    </div>
  );
}
