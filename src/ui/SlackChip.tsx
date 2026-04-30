import type { SlackConfig, SlackStatus } from "../lib/api";
import styles from "./Chip.module.css";

export interface SlackChipProps {
  config: SlackConfig | null;
  status: SlackStatus | null;
  /** Click handler — kicks off the connect-slack skill canvas
   *  (setup if no config, manage if configured). */
  onConnect: () => void;
  className?: string;
}

/** Segmented chip — Slack listener status, mirroring the IntakeChip
 *  layout: a serif italic label on the left, a button on the right.
 *  Three behavioural states (unset / configured-stopped / running)
 *  are signalled in the value text rather than chip color, keeping
 *  the rail visually quiet. */
export function SlackChip({ config, status, onConnect, className }: SlackChipProps) {
  const running = !!status?.running;

  let value: string;
  let title: string;
  if (!config) {
    value = "connect";
    title = "Connect Slack — bring DM-style support requests into your inbox";
  } else if (running) {
    value = `@${config.bot_name}`;
    const sessions = status?.last_heartbeat?.sessions ?? 0;
    title = `Slack listener running (${sessions} sessions). Click to manage.`;
  } else {
    value = `@${config.bot_name} (paused)`;
    title = "Slack configured but not running. Click to manage.";
  }

  const cls = [styles.segment, className].filter(Boolean).join(" ");
  return (
    <span className={cls} role="group" aria-label="Slack">
      <span className={styles.label}>slack</span>
      <button type="button" title={title} onClick={onConnect}>
        {value}
      </button>
    </span>
  );
}
