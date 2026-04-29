import type { HTMLAttributes, ReactNode } from "react";
import styles from "./TitleRail.module.css";

export interface TitleRailProps extends HTMLAttributes<HTMLDivElement> {
  /** Left region — typically the wordmark. The container is
   *  draggable; place buttons here via TitleRailItem if you need
   *  click-through. */
  left: ReactNode;
  /** Center region — current-view context (name + counters).
   *  Optional. Container is draggable. */
  center?: ReactNode;
  /** Right region — global actions (⌘K, Connect to Cloud).
   *  Buttons are click-through automatically. */
  right: ReactNode;
}

/** Merged macOS titlebar + app header. Sits above the panes row
 *  inside the shell. The native traffic lights float over the
 *  left padding (78px clearance via --layout-traffic-clear).
 *
 *  Requires `titleBarStyle: "Overlay"` + `hiddenTitle: true` in
 *  tauri.conf.json. The whole rail is draggable; <button>s and
 *  elements wrapped in <TitleRailItem> opt out so clicks land. */
export function TitleRail({ left, center, right, className, ...rest }: TitleRailProps) {
  const cls = [styles.rail, className].filter(Boolean).join(" ");
  return (
    <div className={cls} {...rest}>
      <div className={styles.left}>{left}</div>
      {center ? <div className={styles.center}>{center}</div> : null}
      <div className={styles.right}>{right}</div>
    </div>
  );
}

export interface TitleRailContextProps {
  /** Current view name — e.g. "Inbox", "Sync", "Reports". */
  name?: ReactNode;
  /** Optional supplementary metadata (italic). */
  detail?: ReactNode;
  /** Optional trailing chips (counters etc). */
  children?: ReactNode;
}

/** Composable center-context widget for the title rail.
 *  Keeps the typography consistent with the rest of v5 — display
 *  font for the name, italic serif for the detail. */
export function TitleRailContext({ name, detail, children }: TitleRailContextProps) {
  return (
    <div className={styles.context}>
      {name ? <span className={styles.contextName}>{name}</span> : null}
      {name && (detail || children) ? (
        <span className={styles.contextSep} aria-hidden>
          ·
        </span>
      ) : null}
      {detail ? <span className={styles.contextItalic}>{detail}</span> : null}
      {children}
    </div>
  );
}

/** Wrap a non-button element to make it click-through inside the
 *  draggable rail (e.g. a custom indicator or chip). */
export function TitleRailItem({
  children,
  className,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  const cls = [styles.nodrag, className].filter(Boolean).join(" ");
  return (
    <div className={cls} {...rest}>
      {children}
    </div>
  );
}
