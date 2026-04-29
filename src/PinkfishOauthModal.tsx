import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  connectAndValidate,
  DEFAULT_TOKEN_URL,
  loadCreds,
  type PinkfishCreds,
} from "./lib/pinkfishAuth";

const SIGNUP_URL = "https://app.pinkfish.ai/coworker/public";

// Manual paste fallback for the new browser-handoff flow. Demoted from
// the default Connect path to an "Advanced ›" disclosure on Onboarding,
// retained for headless dev / CI / troubleshooting where opening a
// browser isn't viable.
//
// V1 is auth-only: we validate the creds, store them, and fire
// `onConnected`. We do NOT chain any *Sync engines from here — sync is
// V2 (a dedicated re-verification pass against the local-first disk
// shapes). The `connectAndValidate` helper in pinkfishAuth.ts is the
// single source of truth for what "connected" means.
export function PinkfishOauthModal({
  initial,
  onClose,
  onConnected,
}: {
  initial: Partial<PinkfishCreds> | null;
  onClose: () => void;
  onConnected: (orgName: string | null) => void;
}) {
  const [clientId, setClientId] = useState(initial?.clientId ?? "");
  const [clientSecret, setClientSecret] = useState(initial?.clientSecret ?? "");
  const [orgId, setOrgId] = useState(initial?.orgId ?? "");
  const [tokenUrl, setTokenUrl] = useState(initial?.tokenUrl ?? DEFAULT_TOKEN_URL);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const creds: PinkfishCreds = {
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
      orgId: orgId.trim(),
      tokenUrl: tokenUrl.trim() || DEFAULT_TOKEN_URL,
    };
    try {
      const { orgName } = await connectAndValidate(creds);
      onConnected(orgName);
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="confirm-modal" role="dialog" aria-label="Connect Pinkfish (advanced)">
      <div className="confirm-modal-body">
        <h3>Connect Pinkfish — Advanced</h3>
        <p>
          Paste OAuth client credentials manually. Use this for headless dev or
          CI; for normal use, prefer the browser sign-in from the Connect
          button.{" "}
          <a
            href={SIGNUP_URL}
            onClick={(e) => {
              e.preventDefault();
              openUrl(SIGNUP_URL).catch(console.error);
            }}
          >
            Sign in or create an account
          </a>{" "}
          to find your client_id, client_secret, and org_id. Stored in your OS
          keychain — never on disk.
        </p>

        <label className="key-label">Client ID</label>
        <input
          autoFocus
          className="key-input"
          placeholder="d7lvo7pfgqvs73j8nnr0"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          disabled={busy}
        />

        <label className="key-label">Client Secret</label>
        <input
          type="password"
          className="key-input"
          placeholder="pf_live_..."
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          disabled={busy}
        />

        <label className="key-label">Org ID</label>
        <input
          className="key-input"
          placeholder="689584191634"
          value={orgId}
          onChange={(e) => setOrgId(e.target.value)}
          disabled={busy}
        />

        <label className="key-label">Token URL</label>
        <input
          className="key-input"
          placeholder={DEFAULT_TOKEN_URL}
          value={tokenUrl}
          onChange={(e) => setTokenUrl(e.target.value)}
          disabled={busy}
        />

        {error && <div className="key-error">{error}</div>}

        <div className="key-actions">
          <button onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy || !clientId || !clientSecret || !orgId}
            className="key-save"
          >
            {busy ? "Connecting…" : "Connect"}
          </button>
        </div>
      </div>
    </div>
  );
}

export { loadCreds };
