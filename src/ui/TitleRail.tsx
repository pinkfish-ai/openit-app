import type { HTMLAttributes, ReactNode } from "react";
import styles from "./TitleRail.module.css";

export interface TitleRailProps extends HTMLAttributes<HTMLDivElement> {
  /** Left-side content — typically the live status chips. Sits
   *  past the traffic-light clearance + a breathing gap. */
  left: ReactNode;
  /** Right-side actions — ⌘K, Getting Started, Connect to Cloud. */
  right: ReactNode;
}

/** Merged macOS-overlaid title rail. Left = status chips, right =
 *  actions. The chips are pushed past the traffic-light clearance
 *  with ~24px of breathing room so they don't visually coincide
 *  with the system controls.
 *  Requires `titleBarStyle: "Overlay"` + `hiddenTitle: true` in
 *  tauri.conf.json. */
export function TitleRail({ left, right, className, ...rest }: TitleRailProps) {
  const cls = [styles.rail, className].filter(Boolean).join(" ");
  return (
    <div className={cls} {...rest}>
      <div className={styles.left}>{left}</div>
      <div className={styles.right}>{right}</div>
    </div>
  );
}
