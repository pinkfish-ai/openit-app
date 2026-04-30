import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import styles from "./Button.module.css";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "ghost"
  | "subtle"
  | "link"
  | "linkMuted"
  | "cmdk";

export type ButtonSize = "sm" | "md" | "lg";

export type ButtonTone = "default" | "destructive";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Color intent. Layers on top of the variant. Use `destructive`
   *  on `ghost` for delete icon buttons; on `secondary` for outline
   *  danger; on `primary` for filled red CTA. */
  tone?: ButtonTone;
  /** Renders the button as a square icon-only control. Width = height. */
  iconOnly?: boolean;
  /** When true, shows a spinner in place of children, sets aria-busy,
   *  and changes cursor to progress. The button is interactively
   *  disabled (clicks ignored) but remains visually present (no
   *  opacity dim). */
  loading?: boolean;
  children?: ReactNode;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: styles.primary,
  secondary: styles.secondary,
  ghost: styles.ghost,
  subtle: styles.subtle,
  link: styles.link,
  linkMuted: styles.linkMuted,
  cmdk: styles.cmdk,
};

/** OpenIT's canonical button. Every clickable thing in the app
 *  should be a Button — CTAs, icon buttons, paste-token actions,
 *  delete icons, "add to chat →", ⌘K hints, prompt bubbles.
 *
 *  See Button.module.css for the variant/tone matrix. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = "secondary",
      size = "md",
      tone = "default",
      iconOnly = false,
      loading = false,
      className,
      type,
      onClick,
      disabled,
      children,
      ...rest
    },
    ref,
  ) {
    const cls = [
      styles.btn,
      styles[size],
      VARIANT_CLASS[variant],
      tone === "destructive" && styles.destructive,
      iconOnly && styles.icon,
      loading && styles.loading,
      className,
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <button
        ref={ref}
        type={type ?? "button"}
        className={cls}
        disabled={disabled}
        aria-busy={loading || undefined}
        onClick={(e) => {
          if (loading) {
            // Swallow clicks while busy so the consumer's onClick
            // doesn't double-fire mid-async-op.
            e.preventDefault();
            return;
          }
          onClick?.(e);
        }}
        {...rest}
      >
        <span className={styles.content}>{children}</span>
        {loading ? <span className={styles.spinner} aria-hidden /> : null}
      </button>
    );
  },
);
