import { useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  oauthCallbackAwait,
  oauthCallbackCancel,
  oauthCallbackStart,
} from "./api";
import {
  connectAndValidate,
  DEFAULT_TOKEN_URL,
} from "./pinkfishAuth";

// Where to send the browser for the OAuth-style handoff. Resolved per
// call (not at module scope) so a runtime localStorage override picks
// up without restarting the dev server. Useful when flipping between
// dev envs:
//
//   localStorage.setItem('openit.pinkfishWebUrl', 'https://dev20.pinkfish.dev')
//
// Precedence: localStorage → Vite env var (build-time) → prod default.
const LOCAL_OVERRIDE_KEY = "openit.pinkfishWebUrl";
function pinkfishWebUrl(): string {
  try {
    const local = window.localStorage.getItem(LOCAL_OVERRIDE_KEY);
    if (local) return local.replace(/\/$/, "");
  } catch {
    // ignore — running outside a real browser env (tests, etc.)
  }
  const fromEnv = import.meta.env.VITE_PINKFISH_WEB_URL as string | undefined;
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  return "https://app.pinkfish.ai";
}

export type BrowserConnectState =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "waiting" } // browser open, awaiting form-POST
  | { kind: "validating" } // creds in hand, refreshing JWT
  | { kind: "error"; message: string };

// Auto-name the account-key so the user can find it later in Settings
// → API Credentials. `navigator.platform` is good enough (e.g.
// "MacIntel"); the user can rename it any time.
function machineLabel(): string {
  return navigator.platform || "this machine";
}

// Hook owning the OAuth browser-handoff state machine. Hoisted here
// (rather than living inside Onboarding) so any UI surface — the
// onboarding screen, the in-shell cloud-cta button, the command
// palette — can drive the same flow with consistent state.
export function useBrowserConnect({
  onConnected,
}: {
  onConnected: (orgName: string | null) => void;
}) {
  const [state, setState] = useState<BrowserConnectState>({ kind: "idle" });

  // Set when the user clicks Cancel mid-flow. The in-flight `start`
  // task's catch checks this before transitioning to error — otherwise
  // it would overwrite the clean idle state with the rejection from
  // the now-shut-down listener (a confusing user-visible "listener
  // shut down before callback" message after a deliberate cancel).
  const cancelledRef = useRef(false);

  // Cancel any in-flight handoff when the host component unmounts so
  // the Rust listener doesn't sit there until its 5-min timeout.
  useEffect(() => {
    return () => {
      oauthCallbackCancel().catch(() => {
        // idempotent — fine to silently fail when nothing was running
      });
    };
  }, []);

  const start = useCallback(async () => {
    cancelledRef.current = false;
    setState({ kind: "starting" });
    try {
      const stateToken = crypto.randomUUID();
      const { url: cbUrl } = await oauthCallbackStart(stateToken);
      const params = new URLSearchParams({
        cb: cbUrl,
        state: stateToken,
        name: machineLabel(),
      });
      const target = `${pinkfishWebUrl()}/openit/connect?${params}`;
      await openUrl(target);
      setState({ kind: "waiting" });

      const creds = await oauthCallbackAwait();
      if (cancelledRef.current) return;
      setState({ kind: "validating" });

      const { orgName } = await connectAndValidate({
        clientId: creds.client_id,
        clientSecret: creds.client_secret,
        orgId: creds.org_id,
        tokenUrl: creds.token_url || DEFAULT_TOKEN_URL,
      });
      if (cancelledRef.current) return;
      onConnected(orgName);
      setState({ kind: "idle" });
    } catch (e) {
      if (cancelledRef.current) return;
      const message =
        e instanceof Error ? e.message : typeof e === "string" ? e : String(e);
      setState({ kind: "error", message });
    }
  }, [onConnected]);

  const cancel = useCallback(async () => {
    cancelledRef.current = true;
    try {
      await oauthCallbackCancel();
    } catch {
      // ignore
    }
    setState({ kind: "idle" });
  }, []);

  const reset = useCallback(() => setState({ kind: "idle" }), []);

  return { state, start, cancel, reset };
}
