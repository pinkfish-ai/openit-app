import { openUrl } from "@tauri-apps/plugin-opener";
import styles from "./Chip.module.css";

export interface IntakeChipProps {
  /** Public tunnel URL (localhost.run). Present once the tunnel is up. */
  sharedUrl: string | null;
  className?: string;
}

function strip(u: string | null): string | null {
  if (!u) return null;
  return u.replace(/^https?:\/\//, "");
}

/** Segmented chip — the intake form, surfacing the public tunnel URL. */
export function IntakeChip({ sharedUrl, className }: IntakeChipProps) {
  if (!sharedUrl) return null;

  const sharedBare = strip(sharedUrl);
  if (!sharedBare) return null;

  const cls = [styles.segment, className].filter(Boolean).join(" ");
  return (
    <span className={cls} role="group" aria-label="Intake form">
      <span className={styles.label}>intake form</span>
      <button
        type="button"
        title={`Intake form: ${sharedBare}. Anyone with this link can submit a ticket.`}
        onClick={() =>
          openUrl(sharedUrl).catch((e) =>
            console.warn("[intake-chip] openUrl failed:", e),
          )
        }
      >
        {sharedBare}
      </button>
    </span>
  );
}
