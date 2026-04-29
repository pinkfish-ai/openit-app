import type { HTMLAttributes, ReactNode } from "react";
import styles from "./Banner.module.css";

export type BannerVariant = "info" | "success" | "warn" | "critical";

export interface BannerProps extends HTMLAttributes<HTMLDivElement> {
  variant?: BannerVariant;
  /** Italic Fraunces eyebrow above the main text. */
  eyebrow?: ReactNode;
  /** Short glyph in a square chip on the left. */
  icon?: ReactNode;
  /** Primary text — supports <strong> for emphasis. */
  children: ReactNode;
  /** Action buttons row below the text. */
  actions?: ReactNode;
  /** When provided, an × close button is rendered on the right. */
  onClose?: () => void;
  /** When parented inside a card with its own chrome, set to true to
   *  drop the banner's outer radius/borders so it hugs the card edges. */
  inline?: boolean;
  /** When parented inside a dark surface (e.g. the chat pane), set to
   *  true to use a dark-tinted variant that doesn't visually jolt. */
  onDark?: boolean;
}

const VARIANT_CLASS: Record<BannerVariant, string | undefined> = {
  info: undefined,
  success: styles.success,
  warn: styles.warn,
  critical: styles.critical,
};

/** Inline banner. Always rendered in document flow — never floats.
 *  Replaces ConflictBanner, AgentActivityBanner, and the floating
 *  EscalatedTicketBanner. Parent it to the surface it concerns. */
export function Banner({
  variant = "info",
  eyebrow,
  icon,
  children,
  actions,
  onClose,
  inline = false,
  onDark = false,
  className,
  role = "status",
  ...rest
}: BannerProps) {
  const cls = [
    styles.banner,
    VARIANT_CLASS[variant],
    inline && styles.inline,
    onDark && styles.onDark,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cls} role={role} {...rest}>
      {icon ? (
        <span className={styles.icon} aria-hidden>
          {icon}
        </span>
      ) : null}
      <div className={styles.body}>
        {eyebrow ? <div className={styles.eyebrow}>{eyebrow}</div> : null}
        <div className={styles.text}>{children}</div>
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </div>
      {onClose ? (
        <button
          type="button"
          className={styles.close}
          aria-label="Dismiss"
          onClick={onClose}
        >
          ×
        </button>
      ) : null}
    </div>
  );
}
