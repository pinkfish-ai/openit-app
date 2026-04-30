import { useEffect, type ReactNode } from "react";
import styles from "./Modal.module.css";
import { Button } from "./Button";

export type ModalSize = "sm" | "md" | "lg";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  size?: ModalSize;
  children: ReactNode;
  footer?: ReactNode;
  /** When false, the backdrop click does NOT close the modal. */
  dismissOnBackdrop?: boolean;
}

/** Modal — backdrop + panel chrome. Used by future cmdk / confirm /
 *  onboard / oauth migrations. */
export function Modal({
  open,
  onClose,
  title,
  size = "md",
  children,
  footer,
  dismissOnBackdrop = true,
}: ModalProps) {
  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  const sizeClass = size === "sm" ? styles.sm : size === "lg" ? styles.lg : styles.md;

  return (
    <div
      className={styles.backdrop}
      onMouseDown={(e) => {
        if (!dismissOnBackdrop) return;
        // Only dismiss when the click started on the backdrop itself
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={[styles.panel, sizeClass].join(" ")}
        role="dialog"
        aria-modal="true"
      >
        {title ? (
          <header className={styles.header}>
            <h2 className={styles.title}>{title}</h2>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="Close"
              className={styles.close}
              onClick={onClose}
            >
              ×
            </Button>
          </header>
        ) : null}
        <div className={styles.body}>{children}</div>
        {footer ? <footer className={styles.footer}>{footer}</footer> : null}
      </div>
    </div>
  );
}
