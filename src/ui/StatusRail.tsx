import type { ReactNode } from "react";
import styles from "./StatusRail.module.css";

export interface StatusRailProps {
  children: ReactNode;
  className?: string;
}

/** A thin transparent row directly below the TitleRail. Hosts the
 *  live status chips on cream — separate from the title rail's
 *  actions so the chips don't compete with the macOS chrome above. */
export function StatusRail({ children, className }: StatusRailProps) {
  const cls = [styles.rail, className].filter(Boolean).join(" ");
  return (
    <div className={cls}>
      <div className={styles.cluster}>{children}</div>
    </div>
  );
}
