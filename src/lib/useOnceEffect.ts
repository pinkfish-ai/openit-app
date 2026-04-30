import { useEffect, useRef, type DependencyList, type EffectCallback } from "react";

/// React 18+ StrictMode runs effect callbacks twice in development to
/// surface cleanup bugs. For effects whose body is intentionally
/// non-idempotent (bootstrap, one-shot setup, fire-and-forget cloud
/// requests that allocate server resources), the second run causes
/// double-creates and races. `useOnceEffect` wraps `useEffect` with a
/// ref guard so the body fires exactly once per component mount.
///
/// Use this only when the effect MUST be one-shot. For idempotent
/// effects (fetching data into state, subscribing to a store), the
/// standard `useEffect` is correct and you don't want this hook —
/// the StrictMode double-run is doing its job.
///
/// Note: there is no cleanup return path supported. If you need
/// teardown on unmount, capture it in a ref and run from a separate
/// effect, or don't use this hook.
export function useOnceEffect(effect: EffectCallback, deps?: DependencyList): void {
  const ranRef = useRef(false);
  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
    effect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
