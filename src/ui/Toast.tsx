// Toast — single canonical implementation. Floating bottom-right,
// dark warm surface. Replaces both src/Toast.tsx and
// src/shell/Toast.tsx (the old src/Toast.tsx now re-exports from
// here to preserve the public ToastProvider/useToast API).
//
// Two trigger paths preserved from the old src/Toast.tsx:
//
//   1. React-side actions call `useToast().show(message)` directly
//      (or .show({ title, message, tone }) for the richer form).
//
//   2. Plugin scripts (Bash spawned by Claude) write a one-line
//      JSON file to `<repo>/.openit/flash.json`. App.tsx watches
//      it via the existing fs-watcher and forwards each new `ts`
//      to the toast. The file is monotonic; we de-dupe by `ts`.
//
// One toast at a time. New events replace the current one rather
// than queueing — the toast is a confirmation, not a log.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import styles from "./Toast.module.css";

export type ToastTone = "info" | "success" | "warn" | "critical";

export type ToastInput =
  | string
  | { title?: string; message: string; tone?: ToastTone };

interface ToastContextValue {
  show: (input: ToastInput) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const DEFAULT_DURATION_MS = 4000;

const TONE_CLASS: Record<ToastTone, string | undefined> = {
  info: undefined,
  success: styles.success,
  warn: styles.warn,
  critical: styles.critical,
};

const TONE_GLYPH: Record<ToastTone, string> = {
  info: "i",
  success: "✓",
  warn: "!",
  critical: "✕",
};

function normalize(input: ToastInput): {
  title?: string;
  message: string;
  tone: ToastTone;
} {
  if (typeof input === "string") {
    return { message: input, tone: "info" };
  }
  return { title: input.title, message: input.message, tone: input.tone ?? "info" };
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<ReturnType<typeof normalize> | null>(null);
  // Bump on every show() so consecutive calls with the same payload
  // still re-fire the dismiss timer + replay the slide-in animation.
  const [tick, setTick] = useState(0);
  const dismissRef = useRef<number | null>(null);

  const show = useCallback((input: ToastInput) => {
    setActive(normalize(input));
    setTick((t) => t + 1);
  }, []);

  // Memoized so consumers passing `[toast]` deps don't see a fresh
  // object every parent render (would re-fire effects unnecessarily).
  const value = useMemo(() => ({ show }), [show]);

  useEffect(() => {
    if (active === null) return;
    if (dismissRef.current) window.clearTimeout(dismissRef.current);
    dismissRef.current = window.setTimeout(() => {
      setActive(null);
      dismissRef.current = null;
    }, DEFAULT_DURATION_MS);
    return () => {
      if (dismissRef.current) {
        window.clearTimeout(dismissRef.current);
        dismissRef.current = null;
      }
    };
  }, [active, tick]);

  const onClose = useCallback(() => {
    if (dismissRef.current) {
      window.clearTimeout(dismissRef.current);
      dismissRef.current = null;
    }
    setActive(null);
  }, []);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {active !== null ? (
        <div className={styles.region} aria-live="polite" aria-atomic="true">
          <div
            key={tick}
            className={[styles.toast, TONE_CLASS[active.tone]].filter(Boolean).join(" ")}
            role="status"
          >
            <span className={styles.icon} aria-hidden>
              {TONE_GLYPH[active.tone]}
            </span>
            <div className={styles.body}>
              {active.title ? <p className={styles.title}>{active.title}</p> : null}
              <p className={styles.message}>{active.message}</p>
            </div>
            <button
              type="button"
              className={styles.close}
              aria-label="Dismiss"
              onClick={onClose}
            >
              ×
            </button>
          </div>
        </div>
      ) : null}
    </ToastContext.Provider>
  );
}

// Stable no-op so consumers without a provider get a stable reference
// (their deps arrays don't churn).
const NOOP_TOAST: ToastContextValue = { show: () => {} };

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  return ctx ?? NOOP_TOAST;
}
