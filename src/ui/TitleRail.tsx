import type { HTMLAttributes, ReactNode } from "react";
import styles from "./TitleRail.module.css";

export interface TitleRailProps extends HTMLAttributes<HTMLDivElement> {
  /** Right-side actions — ⌘K hint, Getting Started, Connect to Cloud. */
  right: ReactNode;
}

/** Slim macOS-overlaid title rail. Hosts ONLY the right-side global
 *  actions; the left is traffic-light clearance. Live status chips
 *  live in <StatusRail> directly below this — see StatusRail.tsx.
 *  Requires `titleBarStyle: "Overlay"` + `hiddenTitle: true` in
 *  tauri.conf.json. */
export function TitleRail({ right, className, ...rest }: TitleRailProps) {
  const cls = [styles.rail, className].filter(Boolean).join(" ");
  return (
    <div className={cls} {...rest}>
      <div className={styles.spacer} />
      <div className={styles.right}>{right}</div>
    </div>
  );
}
