import type { HTMLAttributes, ReactNode } from "react";
import styles from "./Badge.module.css";

export type BadgeTone = "accent" | "muted" | "success" | "warn" | "critical";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  children: ReactNode;
}

const TONE_CLASS: Record<BadgeTone, string | undefined> = {
  accent: undefined,
  muted: styles.muted,
  success: styles.success,
  warn: styles.warn,
  critical: styles.critical,
};

/** Count badge. Mono tabular numerals only — never used for static text. */
export function Badge({ tone = "accent", className, children, ...rest }: BadgeProps) {
  const cls = [styles.badge, TONE_CLASS[tone], className].filter(Boolean).join(" ");
  return (
    <span className={cls} {...rest}>
      {children}
    </span>
  );
}
