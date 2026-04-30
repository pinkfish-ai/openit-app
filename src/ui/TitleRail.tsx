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
 *  tauri.conf.json.
 *
 *  Drag: macOS WebKit doesn't honor `-webkit-app-region: drag`, so we
 *  use Tauri 2's `data-tauri-drag-region` attribute (the CSS rule on
 *  `.rail` is kept for Windows/Linux where Chromium-based webviews do
 *  honor it). Tauri's drag handler ignores native interactive
 *  elements (button, input, …) so chips and buttons keep working
 *  without an opt-out. */
export function TitleRail({ left, right, className, ...rest }: TitleRailProps) {
  const cls = [styles.rail, className].filter(Boolean).join(" ");
  return (
    <div className={cls} data-tauri-drag-region {...rest}>
      <div className={styles.left} data-tauri-drag-region>{left}</div>
      <div className={styles.right} data-tauri-drag-region>{right}</div>
    </div>
  );
}
