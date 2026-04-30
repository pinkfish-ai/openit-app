import { openUrl } from "@tauri-apps/plugin-opener";
import styles from "./Chip.module.css";

export interface IntakeChipProps {
  /** Local intake URL — always present when the server is up. */
  localUrl: string | null;
  /** Public tunnel URL — present only when a tunnel is running. */
  sharedUrl: string | null;
  className?: string;
}

function strip(u: string | null): string | null {
  if (!u) return null;
  return u.replace(/^https?:\/\//, "");
}

/** Segmented chip — the intake form, with up to two endpoints (local
 *  and shared). Reads as ONE entity ("the intake form") with two
 *  scoped buttons. Replaces the previous two-chip layout where
 *  `intake` and `share` looked like unrelated items. */
export function IntakeChip({ localUrl, sharedUrl, className }: IntakeChipProps) {
  if (!localUrl && !sharedUrl) return null;

  const localBare = strip(localUrl);
  const sharedBare = strip(sharedUrl);

  const cls = [styles.segment, className].filter(Boolean).join(" ");
  return (
    <span className={cls} role="group" aria-label="Intake form">
      <span className={styles.label}>intake form</span>
      {localUrl && localBare && (
        <button
          type="button"
          title={`Local intake: ${localBare}. Click to open in your browser.`}
          onClick={() =>
            openUrl(localUrl).catch((e) =>
              console.warn("[intake-chip] openUrl local failed:", e),
            )
          }
        >
          <span className={styles.scope}>local</span>
          {localBare}
        </button>
      )}
      {sharedUrl && sharedBare && (
        <button
          type="button"
          title={`Public share: ${sharedBare}. Anyone with this link can submit a ticket.`}
          onClick={() =>
            openUrl(sharedUrl).catch((e) =>
              console.warn("[intake-chip] openUrl shared failed:", e),
            )
          }
        >
          <span className={styles.scope}>shared</span>
          {sharedBare}
        </button>
      )}
    </span>
  );
}
