import type { SlackConfig, SlackStatus } from "../lib/api";

function basename(p: string): string {
  const parts = p.split("/").filter((s) => s.length > 0);
  return parts[parts.length - 1] ?? p;
}

/**
 * Bottom status rail. One quiet line of chips that surfaces the
 * "what's going on right now" state without stealing screen space.
 * Replaces the impulse to keep stacking banners for every concern.
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

  return (
    <div className="status-bar" role="status">
      <div className="status-bar-left">
        <button
          type="button"
          className="status-chip status-chip-project"
          title="Project"
          onClick={onOpenPalette}
        >
          <span className="status-chip-glyph">◆</span>
          <span className="status-chip-label">{projectName}</span>
        </button>

        <span
          className={`status-chip ${
            cloudConnected ? "status-chip-ok" : "status-chip-muted"
          }`}
          title={cloudConnected ? "Connected to Pinkfish Cloud" : "Local only"}
        >
          <span className="status-led" />
          <span className="status-chip-label">
            {cloudConnected ? `cloud · ${orgName ?? "connected"}` : "local"}
          </span>
        </span>

        {intakeUrl && (
          <span className="status-chip status-chip-info" title="Intake server">
            <span className="status-chip-glyph">↳</span>
            <span className="status-chip-label">
              intake · {intakeUrl.replace(/^https?:\/\//, "")}
            </span>
          </span>
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

      <div className="status-bar-right">
        <button
          type="button"
          className="status-chip status-chip-cmdk"
          onClick={onOpenPalette}
          title="Command palette"
        >
          <kbd>⌘</kbd>
          <kbd>K</kbd>
          <span className="status-chip-label">commands</span>
        </button>
      </div>
    </div>
  );
}
