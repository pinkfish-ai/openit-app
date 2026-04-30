import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";
import styles from "./Chip.module.css";

export type ChipVariant =
  | "neutral"
  | "strong"
  | "info"
  | "success"
  | "warn"
  | "critical";

interface ChipPropsBase {
  variant?: ChipVariant;
  /** Tiny italic prefix label (e.g. <em>intake</em> · 127.0.0.1). */
  keyLabel?: ReactNode;
  /** Decorative glyph before the label (e.g. ◆). */
  glyph?: ReactNode;
  /** Show a status LED before the label (only meaningful on success/warn/critical). */
  led?: boolean;
  /** Optional dismiss callback; when provided, renders an × button. */
  onDismiss?: () => void;
  /** Render with a dashed border to signal "click to set this up"
   *  (e.g. Slack chip in unconfigured state). */
  dashed?: boolean;
  children?: ReactNode;
}

type ChipAsSpan = ChipPropsBase &
  Omit<HTMLAttributes<HTMLSpanElement>, "onClick"> & {
    onClick?: undefined;
  };

type ChipAsButton = ChipPropsBase &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
    onClick: ButtonHTMLAttributes<HTMLButtonElement>["onClick"];
  };

export type ChipProps = ChipAsSpan | ChipAsButton;

const VARIANT_CLASS: Record<ChipVariant, string | undefined> = {
  neutral: undefined,
  strong: styles.strong,
  info: styles.info,
  success: styles.success,
  warn: styles.warn,
  critical: styles.critical,
};

/** One Chip. Six variants. Renders as <button> when onClick is set,
 *  <span> otherwise. Replaces .status-chip*, .intake-url-pill,
 *  .slack-pill-*, .bubble, .databases-list-tag, .org-sub-tag,
 *  .left-tab-badge*, .sc-badge, etc. */
export const Chip = forwardRef<HTMLElement, ChipProps>(function Chip(
  props,
  ref,
) {
  const {
    variant = "neutral",
    keyLabel,
    glyph,
    led,
    onDismiss,
    dashed,
    className,
    children,
    ...rest
  } = props;

  const cls = [styles.chip, VARIANT_CLASS[variant], dashed && styles.dashed, className]
    .filter(Boolean)
    .join(" ");

  const inner = (
    <>
      {led ? <span className={styles.led} aria-hidden /> : null}
      {glyph ? (
        <span className={styles.glyph} aria-hidden>
          {glyph}
        </span>
      ) : null}
      {keyLabel ? <span className={styles.key}>{keyLabel}</span> : null}
      {children}
      {onDismiss ? (
        <button
          type="button"
          className={styles.dismiss}
          aria-label="Remove"
          onClick={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
        >
          ×
        </button>
      ) : null}
    </>
  );

  if ("onClick" in props && props.onClick) {
    return (
      <button
        ref={ref as React.Ref<HTMLButtonElement>}
        type="button"
        className={cls}
        {...(rest as ButtonHTMLAttributes<HTMLButtonElement>)}
      >
        {inner}
      </button>
    );
  }

  return (
    <span
      ref={ref as React.Ref<HTMLSpanElement>}
      className={cls}
      {...(rest as HTMLAttributes<HTMLSpanElement>)}
    >
      {inner}
    </span>
  );
});
