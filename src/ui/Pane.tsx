import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import styles from "./Pane.module.css";

export interface PaneProps extends HTMLAttributes<HTMLDivElement> {
  /** Use the dark warm surface (chat pane). */
  dark?: boolean;
  children: ReactNode;
}

/** Pane card — the rounded floating surface that holds a section
 *  bar + body. Replaces the inline `.left-pane`/`.center-pane`/
 *  `.right-pane` chrome in App.css. */
export const Pane = forwardRef<HTMLDivElement, PaneProps>(function Pane(
  { dark = false, className, children, ...rest },
  ref,
) {
  const cls = [styles.pane, dark && styles.dark, className].filter(Boolean).join(" ");
  return (
    <div ref={ref} className={cls} {...rest}>
      {children}
    </div>
  );
});

export interface SectionBarProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

/** Section bar — the 44px top rail of every pane. Tabs, breadcrumbs,
 *  viewer-head, and chat-head all sit inside this exact frame. */
export function SectionBar({ className, children, ...rest }: SectionBarProps) {
  const cls = [styles.sectionBar, className].filter(Boolean).join(" ");
  return (
    <div className={cls} {...rest}>
      {children}
    </div>
  );
}

/** Spacer that pushes subsequent section-bar children to the right. */
export function SectionBarSpacer() {
  return <div className={styles.spacer} />;
}

export interface PaneBodyProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

/** Scrollable pane body. */
export function PaneBody({ className, children, ...rest }: PaneBodyProps) {
  const cls = [styles.body, className].filter(Boolean).join(" ");
  return (
    <div className={cls} {...rest}>
      {children}
    </div>
  );
}
