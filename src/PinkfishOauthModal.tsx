import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { pinkfishTestCall } from "./lib/api";
import {
  DEFAULT_TOKEN_URL,
  loadCreds,
  refresh,
  saveCreds,
  type PinkfishCreds,
} from "./lib/pinkfishAuth";

const SIGNUP_URL = "https://app.pinkfish.ai/coworker/public";

export function PinkfishOauthModal({
  initial,
  onClose,
  onConnected,
}: {
  initial: Partial<PinkfishCreds> | null;
  onClose: () => void;
  onConnected: () => void;
}) {
  const [clientId, setClientId] = useState(initial?.clientId ?? "");
  const [clientSecret, setClientSecret] = useState(initial?.clientSecret ?? "");
  const [orgId, setOrgId] = useState(initial?.orgId ?? "");
  const [tokenUrl, setTokenUrl] = useState(initial?.tokenUrl ?? DEFAULT_TOKEN_URL);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setSuccess(null);
    const creds: PinkfishCreds = {
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
      orgId: orgId.trim(),
      tokenUrl: tokenUrl.trim() || DEFAULT_TOKEN_URL,
    };
    try {
      const token = await refresh(creds);
      // Smoke-test the token against the public weather MCP.
      try {
        await pinkfishTestCall({
          accessToken: token.accessToken,
          orgId: creds.orgId,
        });
      } catch (testErr) {
        // Token exchange worked but the test call failed — surface but don't roll back.
        // The user may not have weather access; offer to save anyway.
        setError(
          `Got a token, but the test call failed: ${String(testErr)}\nSaved anyway — check your scope/permissions.`,
        );
        await saveCreds(creds);
        setSuccess(null);
        setBusy(false);
        return;
      }
      await saveCreds(creds);
      setSuccess("Connected. Token will auto-refresh before expiry.");
      onConnected();
      setTimeout(onClose, 800);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="confirm-modal" role="dialog" aria-label="Connect Pinkfish">
      <div className="confirm-modal-body wide">
        <h3>Connect Pinkfish</h3>
        <p>
          OAuth client credentials for your Pinkfish org.{" "}
          <a
            href={SIGNUP_URL}
            onClick={(e) => {
              e.preventDefault();
              openUrl(SIGNUP_URL).catch(console.error);
            }}
          >
            Create an account or sign in
          </a>{" "}
          to get your client_id, client_secret, and org id. Stored in your OS keychain — never on disk.
        </p>

        <label className="key-label">Client ID</label>
        <input
          autoFocus
          className="key-input"
          placeholder="d7lvo7pfgqvs73j8nnr0"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
        />

        <label className="key-label">Client Secret</label>
        <input
          type="password"
          className="key-input"
          placeholder="pf_live_..."
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
        />

        <label className="key-label">Org ID</label>
        <input
          className="key-input"
          placeholder="689584191634"
          value={orgId}
          onChange={(e) => setOrgId(e.target.value)}
        />

        <label className="key-label">Token URL</label>
        <input
          className="key-input"
          placeholder={DEFAULT_TOKEN_URL}
          value={tokenUrl}
          onChange={(e) => setTokenUrl(e.target.value)}
        />

        {error && <div className="key-error">{error}</div>}
        {success && <div className="key-success">{success}</div>}
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
