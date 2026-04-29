import { openUrl } from "@tauri-apps/plugin-opener";
import type { SlackConfig, SlackStatus } from "../lib/api";
import { Chip } from "../ui";

function basename(p: string): string {
  const parts = p.split("/").filter((s) => s.length > 0);
  return parts[parts.length - 1] ?? p;
}

/**
 * Bottom status rail. One quiet line of chips that surfaces the
 * "what's going on right now" state without stealing screen space.
 *
 * v5: rebuilt on top of the unified <Chip> primitive. The rail
 * itself is transparent (Quieter B) — no white strip, no hard
 * top border. Cmd-K hint lives only in the top TitleRail — never
 * duplicated here.
 */
export function StatusBar({
  repo,
  cloudConnected,
  orgName,
  intakeUrl,
  tunnelUrl,
  slackConfig,
  slackStatus,
  changeCount,
  onOpenPalette,
  onConnectSlack,
}: {
  repo: string | null;
  cloudConnected: boolean;
  orgName: string | null;
  intakeUrl: string | null;
  tunnelUrl: string | null;
  slackConfig: SlackConfig | null;
  slackStatus: SlackStatus | null;
  changeCount: number;
  onOpenPalette: () => void;
  /** Click handler for the Slack chip — kicks off the connect-slack
   *  skill-canvas flow (setup if no config, manage if configured). */
  onConnectSlack: () => void;
}) {
  const projectName = repo ? basename(repo) : "no project";
  const slackRunning = !!slackStatus?.running;

  // When the project name and the cloud-state label are the same string
  // (e.g. fresh local-only install where basename(repo) === "local" and
  // the cloud chip would also say "local"), collapse them so we don't
  // render two chips both saying "local".
  const cloudLabel = cloudConnected ? orgName ?? "connected" : "local";
  const collapseProjectAndCloud =
    !cloudConnected && projectName.toLowerCase() === cloudLabel.toLowerCase();

  const intakeBare = intakeUrl?.replace(/^https?:\/\//, "");
  const tunnelBare = tunnelUrl?.replace(/^https?:\/\//, "");

  return (
    <div className="v5-shell-status" role="status">
      <div className="v5-shell-status-left">
        <Chip
          variant="strong"
          glyph="◆"
          onClick={onOpenPalette}
          title={
            collapseProjectAndCloud
              ? "Local-only project — click for the command palette"
              : "Project — click for the command palette"
          }
        >
          {collapseProjectAndCloud ? `local · ${projectName}` : projectName}
        </Chip>

        {!collapseProjectAndCloud && (
          <Chip
            variant={cloudConnected ? "success" : "neutral"}
            led
            title={cloudConnected ? "Connected to Pinkfish Cloud" : "Local only"}
          >
            {cloudConnected ? `cloud · ${cloudLabel}` : "local"}
          </Chip>
        )}

        {intakeUrl && intakeBare && (
          <Chip
            variant="info"
            keyLabel="intake"
            title={`Intake form at ${intakeBare} — click to open in your browser`}
            onClick={() =>
              openUrl(intakeUrl).catch((e) =>
                console.warn("[status-bar] openUrl intake failed:", e),
              )
            }
          >
            {intakeBare}
          </Chip>
        )}

        {tunnelUrl && tunnelBare && (
          <Chip
            variant="info"
            keyLabel="share"
            title={`Public tunnel at ${tunnelBare} — share this with your team. Dies when OpenIT closes.`}
            onClick={() =>
              openUrl(tunnelUrl).catch((e) =>
                console.warn("[status-bar] openUrl tunnel failed:", e),
              )
            }
          >
            {tunnelBare}
          </Chip>
        )}

        {/* Slack chip — always rendered. Three visual states:
              - configured + listener running → sage LED + "@bot · Ns"
              - configured + listener stopped → ochre LED + "@bot"
              - not configured                → dashed neutral, "Connect Slack"
            Click in any state opens the /connect-slack skill canvas
            (setup vs manage is decided by the canvas itself). */}
        <Chip
          variant={
            slackConfig
              ? slackRunning
                ? "success"
                : "warn"
              : "neutral"
          }
          dashed={!slackConfig}
          led={!!slackConfig}
          onClick={onConnectSlack}
          title={
            !slackConfig
              ? "Connect Slack — bring DM-style support requests into your inbox"
              : slackRunning
                ? `Slack listener running (${
                    slackStatus?.last_heartbeat?.sessions ?? 0
                  } sessions). Click to manage.`
                : "Slack configured but not running. Click to manage."
          }
        >
          {slackConfig ? (
            <>
              slack · @{slackConfig.bot_name}
              {slackRunning &&
                ` · ${slackStatus?.last_heartbeat?.sessions ?? 0}s`}
            </>
          ) : (
            "Connect Slack"
          )}
        </Chip>

        {changeCount > 0 && (
          <Chip variant="warn" led title="Uncommitted changes">
            {changeCount} change{changeCount === 1 ? "" : "s"}
          </Chip>
        )}
      </div>
    </div>
  );
}
