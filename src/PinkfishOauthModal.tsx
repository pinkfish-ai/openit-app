import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { pinkfishListOrgs, projectBootstrap } from "./lib/api";
import {
  DEFAULT_TOKEN_URL,
  derivedUrls,
  loadCreds,
  refresh,
  saveCreds,
  type PinkfishCreds,
} from "./lib/pinkfishAuth";
import { resolveProjectDatastores, fetchDatastoreItems, syncDatastoresToDisk } from "./lib/datastoreSync";
import { resolveProjectAgents } from "./lib/agentSync";
import { resolveProjectWorkflows } from "./lib/workflowSync";
import { resolveProjectFilestores, startFilestoreSync } from "./lib/filestoreSync";

const SIGNUP_URL = "https://app.pinkfish.ai/coworker/public";

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
  const [syncing, setSyncing] = useState(false);
  const [syncLogs, setSyncLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const addLog = (msg: string) => {
    console.log(msg);
    setSyncLogs((prev) => [...prev, msg]);
  };

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
      // Validate by calling list_orgs and look up the bound org's display name.
      const urls = derivedUrls(creds.tokenUrl);
      const orgs = await pinkfishListOrgs({
        accessToken: token.accessToken,
        orgId: creds.orgId,
        accountUrl: urls.accountUrl,
      });
      const me = orgs.find((o) => o.id === creds.orgId);
      const orgName = me?.name ?? null;
      await saveCreds(creds);
      setSuccess(`Connected${orgName ? ` to ${orgName}` : ""}.`);
      
      // Start syncing all assets
      setSyncing(true);
      setSyncLogs([]);
      addLog("----BEGIN SYNC----");
      addLog("Syncing all assets...");

      let syncErrors = false;
      let repo = "";

      // Set a 60-second timeout for the entire sync process
      const syncTimeoutMs = 60_000;
      const timeoutHandle = setTimeout(() => {
        addLog("[sync] ✗ Sync timed out after 60 seconds");
        setSyncing(false);
        setError("Sync timed out. Check your connection and try again.");
        setBusy(false);
      }, syncTimeoutMs);

      try {
        // Bootstrap project to create repo directory
        addLog("[sync] Creating project directory...");
        try {
          const bootstrap = await projectBootstrap({
            orgName: orgName || creds.orgId,
            orgId: creds.orgId,
          });
          repo = bootstrap.path;
          addLog(`[sync] ✓ Project directory created at ${repo}`);
        } catch (e) {
          addLog(`[sync] ✗ Project bootstrap failed: ${e}`);
          syncErrors = true;
        }

        if (!syncErrors) {
          addLog("[sync] Resolving and syncing datastores...");
          try {
            const datastores = await resolveProjectDatastores(creds);
            addLog(`[sync] Found ${datastores.length} datastores`);

            // Fetch and sync data for each datastore
            const itemsByCollection: Record<string, { items: any[]; hasMore: boolean }> = {};
            for (const ds of datastores) {
              addLog(`[sync] Fetching items for ${ds.name}...`);
              const data = await fetchDatastoreItems(creds, ds.id);
              itemsByCollection[ds.id] = data;
              addLog(`[sync] Fetched ${data.items.length} items from ${ds.name}`);
            }

            // Write to disk
            await syncDatastoresToDisk(repo, datastores, itemsByCollection);
            addLog("[sync] ✓ Datastores synced to disk");
          } catch (e) {
            addLog(`[sync] ✗ Datastore sync failed: ${e}`);
            syncErrors = true;
          }
        }

        if (!syncErrors) {
          addLog("[sync] Resolving agents...");
          try {
            await resolveProjectAgents(creds);
            addLog("[sync] ✓ Agents resolved");
          } catch (e) {
            addLog(`[sync] ✗ Agent sync failed: ${e}`);
            syncErrors = true;
          }
        }

        if (!syncErrors) {
          addLog("[sync] Resolving workflows...");
          try {
            await resolveProjectWorkflows(creds);
            addLog("[sync] ✓ Workflows resolved");
          } catch (e) {
            addLog(`[sync] ✗ Workflow sync failed: ${e}`);
            syncErrors = true;
          }
        }

        if (!syncErrors) {
          addLog("[sync] Syncing filestore files...");
          try {
            await startFilestoreSync({ creds, repo });
            addLog("[sync] ✓ Filestore files synced to disk");
          } catch (e) {
            addLog(`[sync] ✗ Filestore sync failed: ${e}`);
            syncErrors = true;
          }
        }

        clearTimeout(timeoutHandle);
        
        if (syncErrors) {
          addLog("----END SYNC (FAILED)----");
          setSyncing(false);
          setError("Sync failed. Check logs above for details.");
          setBusy(false);
          return;
        }
        
        addLog("----END SYNC----");
        setSyncing(false);
        onConnected(orgName);
        setTimeout(onClose, 1000);
      } catch (syncErr) {
        clearTimeout(timeoutHandle);
        addLog(`[sync] Unexpected error: ${syncErr}`);
        setSyncing(false);
        setError(`Sync failed: ${syncErr}`);
        setBusy(false);
      }
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="confirm-modal" role="dialog" aria-label="Connect Pinkfish">
      <div className="confirm-modal-body wide">
        <h3>Connect Pinkfish</h3>
        
        {syncing ? (
          <div style={{ marginTop: "20px" }}>
            <p style={{ fontSize: "14px", marginBottom: "10px", color: "#666" }}>
              🔄 Syncing collections and resources...
            </p>
            <div
              style={{
                backgroundColor: "#f5f5f5",
                border: "1px solid #ddd",
                borderRadius: "4px",
                padding: "12px",
                fontSize: "12px",
                fontFamily: "monospace",
                maxHeight: "300px",
                overflowY: "auto",
                marginBottom: "15px",
                lineHeight: "1.6",
              }}
            >
              {syncLogs.map((log, i) => (
                <div key={i}>{log}</div>
              ))}
            </div>
          </div>
        ) : (
          <>
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
            {success && <div className="key-success">{success}</div>}
          </>
        )}
        
        <div className="key-actions">
          <button onClick={onClose} disabled={busy || syncing}>
            {syncing ? "Syncing..." : "Cancel"}
          </button>
          {!syncing && (
            <button
              onClick={submit}
              disabled={busy || !clientId || !clientSecret || !orgId}
              className="key-save"
            >
              {busy ? "Connecting…" : "Connect"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export { loadCreds };
