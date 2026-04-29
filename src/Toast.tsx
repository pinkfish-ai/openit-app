// Toast — ephemeral confirmation banner that slides in from the
// bottom of the chat pane. Used to signal "side-effect happened"
// moments that the chat narration alone makes easy to miss:
// manifest copied to clipboard, token validated, listener restarted,
// etc.
//
// Two trigger paths:
//
//   1. React-side actions (the SkillActionDock paste flow) call
//      `useToast().show(message)` directly.
//
//   2. Plugin scripts (Bash spawned by Claude) write a one-line JSON
//      file to `<repo>/.openit/flash.json`. App.tsx watches it via
//      the existing fs-watcher and forwards each new `ts` to the
//      toast. The file is monotonic — scripts overwrite with a
//      fresh `{message, ts}`; we de-dupe by `ts`.
//
// One toast at a time. New events replace the current one rather
// than queueing — the toast is a confirmation, not a log; if a
// later event preempts an earlier one, the later one is what the
// user cares about.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import "./Toast.css";

type ToastContextValue = {
  show: (message: string) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  // Bump on every show() so a back-to-back call to show() with the
  // same message still re-fires the dismiss timer.
  const [tick, setTick] = useState(0);
  const dismissTimerRef = useRef<number | null>(null);

  const show = useCallback((m: string) => {
    setMessage(m);
    setTick((t) => t + 1);
  }, []);

  // Memoize the context value so consumers' deps arrays (e.g.
  // useEffect listing `toast` from useToast()) don't see a fresh
  // object reference on every parent render. Without this, a flash
  // watcher with `[repo, toast]` deps re-fires on every render and
  // tears down its fs subscription each time.
  const value = useMemo(() => ({ show }), [show]);

  useEffect(() => {
    if (message === null) return;
    if (dismissTimerRef.current) window.clearTimeout(dismissTimerRef.current);
    dismissTimerRef.current = window.setTimeout(() => {
      setMessage(null);
      dismissTimerRef.current = null;
    }, 3000);
    return () => {
      if (dismissTimerRef.current) {
        window.clearTimeout(dismissTimerRef.current);
        dismissTimerRef.current = null;
      }
    };
  }, [message, tick]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {message !== null && (
        <div
          className="openit-toast"
          role="status"
          aria-live="polite"
          // Re-mount on tick change so the slide-in animation
          // restarts when a new toast preempts the current one.
          key={tick}
        >
          {message}
        </div>
      )}
    </ToastContext.Provider>
  );
}

// Stable no-op fallback so the without-provider path returns the
// same reference every render (consumers' deps arrays stay stable).
const NOOP_TOAST: ToastContextValue = { show: () => {} };

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // Render-without-provider safety: never crash the app over a
    // missed wrap.
    return NOOP_TOAST;
  }
  return ctx;
}
