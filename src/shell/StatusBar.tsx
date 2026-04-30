import type { SlackConfig, SlackStatus } from "../lib/api";
import { Chip, IntakeChip } from "../ui";

function basename(p: string): string {
  const parts = p.split("/").filter((s) => s.length > 0);
  return parts[parts.length - 1] ?? p;
}

/**
 * StatusChips — the live "what's going on right now" cluster.
 *
 * v5 (third pass): renders as a flat group of chips with no
 * surrounding rail. Mounted inside <StatusRail> directly below
 * the title rail. The variant color of each chip carries its
 * meaning (sage = healthy, ochre = paused, dashed = unset);
 * decorative LEDs were dropped to keep the rail quiet.
 *
 * The "uncommitted changes" count is intentionally NOT shown
 * here — the SYNC tab badge in the left pane already surfaces
 * it next to the actionable surface (the sync panel itself).
 */
export function StatusChips({
  repo,
  cloudConnected,
  orgName,
  intakeUrl,
  tunnelUrl,
  slackConfig,
  slackStatus,
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

  return (
    <>
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
          title={cloudConnected ? "Connected to Pinkfish Cloud" : "Local only"}
        >
          {cloudConnected ? `cloud ${cloudLabel}` : "local"}
        </Chip>
      )}

      <IntakeChip localUrl={intakeUrl} sharedUrl={tunnelUrl} />

      {/* Slack chip — three visual states distinguished by variant
          color (no LED): success (running), warn (configured but
          stopped), neutral-dashed (unset). Click in any state opens
          the /connect-slack skill canvas. */}
      <Chip
        variant={
          slackConfig
            ? slackRunning
              ? "success"
              : "warn"
            : "neutral"
        }
        dashed={!slackConfig}
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
          <>slack @{slackConfig.bot_name}</>
        ) : (
          "Connect Slack"
        )}
      </Chip>
    </>
  );
}
