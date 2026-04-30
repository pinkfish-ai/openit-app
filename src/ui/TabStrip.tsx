import {
  forwardRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import styles from "./TabStrip.module.css";

export type TabStripVariant = "underline" | "segmented";

export interface TabStripProps extends HTMLAttributes<HTMLDivElement> {
  /** "underline" (default) — active tab gets a clay underline below.
   *  Used by the OVERVIEW/SYNC strip, viewer filter rows, etc.
   *  "segmented" — joined button group, active tab gets a fill.
   *  Used by View/Edit, Cards/Table toggles. */
  variant?: TabStripVariant;
  /** Tighter horizontal gap between tabs. Has no effect on
   *  segmented (which is flush). */
  compact?: boolean;
  children: ReactNode;
}

export const TabStrip = forwardRef<HTMLDivElement, TabStripProps>(
  function TabStrip(
    { variant = "underline", compact = false, className, children, ...rest },
    ref,
  ) {
    const cls = [
      styles.strip,
      variant === "segmented" ? styles.segmented : null,
      compact ? styles.compact : null,
      className,
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <div ref={ref} role="tablist" className={cls} {...rest}>
        {children}
      </div>
    );
  },
);

export interface TabProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Whether this tab is the currently selected one. Maps to
   *  aria-selected on the button. */
  active?: boolean;
  /** Optional count badge rendered after the label. */
  count?: number;
  children: ReactNode;
}

export const Tab = forwardRef<HTMLButtonElement, TabProps>(function Tab(
  { active = false, count, className, type, children, ...rest },
  ref,
) {
  const cls = [styles.tab, className].filter(Boolean).join(" ");
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      role="tab"
      aria-selected={active}
      className={cls}
      {...rest}
    >
      {children}
      {count !== undefined && count > 0 ? (
        <span className={styles.count}>{count}</span>
      ) : null}
    </button>
  );
});
