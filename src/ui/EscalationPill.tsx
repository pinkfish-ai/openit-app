import type { ButtonHTMLAttributes, ReactNode } from "react";
import styles from "./EscalationPill.module.css";

export interface EscalationPillProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Number of tickets needing reply. Renders inside the count chip. */
  count: number;
  /** Optional preview text — typically the first ticket's subject.
   *  Truncated on overflow. */
  subject?: ReactNode;
}

/** A small pulsing amber pill, parented inside the chat pane just
 *  above the chat stream. Replaces the inline sage Banner — denser,
 *  more glanceable, glows warm against the dark surface. Click =
 *  fire the /answer-ticket flow.
 *
 *  Design intent: the user should immediately see "something needs
 *  your reply" but the pill must not occupy more than ~28px of
 *  vertical space — every pixel of chat stream is precious. */
export function EscalationPill({
  count,
  subject,
  className,
  type,
  children,
  ...rest
}: EscalationPillProps) {
  return (
    <div className={styles.wrap}>
      <button
        type={type ?? "button"}
        className={[styles.pill, className].filter(Boolean).join(" ")}
        aria-label={
          count === 1
            ? "1 ticket needs your reply — draft response with Claude"
            : `${count} tickets need your reply — draft response with Claude`
        }
        {...rest}
      >
        <span className={styles.glyph} aria-hidden>
          ✎
        </span>
        <span className={styles.count}>{count}</span>
        <span className={styles.text}>
          {subject ? (
            <>
              <em>{subject}</em>
              {count > 1 ? ` + ${count - 1}` : ""}
            </>
          ) : count === 1 ? (
            <>need your reply</>
          ) : (
            <>need your reply</>
          )}
          {children}
        </span>
        <span className={styles.arrow} aria-hidden>
          →
        </span>
      </button>
    </div>
  );
}
