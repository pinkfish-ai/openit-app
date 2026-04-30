import type { SlackConfig, SlackStatus } from "../lib/api";
import { IntakeChip, SlackChip } from "../ui";

/**
 * StatusChips — the live "what's wired up right now" cluster.
 *
 * Two segmented chips, both rendered in the same `[label] [value]`
 * style: the public intake URL and the Slack listener. Project name
 * and cloud-binding state are NOT shown here — the right-side
 * "Connect to Cloud" / "Cloud · <org>" button in <TitleRail> already
 * carries that, and the project folder is fixed at `~/OpenIT/local/`
 * so the basename never varies.
 *
 * The "uncommitted changes" count is intentionally NOT shown here
 * either — the SYNC tab badge in the left pane already surfaces it
 * next to the actionable surface (the sync panel itself).
 */
export function StatusChips({
  tunnelUrl,
  slackConfig,
  slackStatus,
  onConnectSlack,
}: {
  tunnelUrl: string | null;
  slackConfig: SlackConfig | null;
  slackStatus: SlackStatus | null;
  /** Click handler for the Slack chip — kicks off the connect-slack
   *  skill-canvas flow (setup if no config, manage if configured). */
  onConnectSlack: () => void;
}) {
  return (
    <>
      <IntakeChip sharedUrl={tunnelUrl} />
      <SlackChip
        config={slackConfig}
        status={slackStatus}
        onConnect={onConnectSlack}
      />
    </>
  );
}
