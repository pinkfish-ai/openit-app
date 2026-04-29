import { useEffect, useRef, useState } from "react";

/// Lightweight ephemeral toast for confirming file actions
/// (uploaded, deleted, renamed). Renders nothing until `show()` is
/// called via the returned setter; auto-dismisses after 2.5s. Single
/// active message at a time — a new call replaces the current toast
/// rather than queuing, which matches how users perceive these
/// "did my action take?" confirmations.
export function useToast(): {
  toast: string | null;
  show: (msg: string) => void;
} {
  const [toast, setToast] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  function show(msg: string) {
    setToast(msg);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), 2500);
  }
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  return { toast, show };
}

export function ToastView({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="toast-notice">{message}</div>;
}
