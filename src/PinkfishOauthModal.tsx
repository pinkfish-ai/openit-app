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
import { resolveProjectAgents, syncAgentsToDisk } from "./lib/agentSync";
import { resolveProjectWorkflows, syncWorkflowsToDisk } from "./lib/workflowSync";
import { resolveProjectFilestores, pullOnce } from "./lib/filestoreSync";
import { startKbSync } from "./lib/kbSync";
import { syncSkillsToDisk } from "./lib/skillsSync";

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
  const [syncDone, setSyncDone] = useState(false);
  const [syncLogs, setSyncLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const copyLogs = async () => {
    try {
      await navigator.clipboard.writeText(syncLogs.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.error("copy failed:", e);
    }
  };

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
      addLog("─── connect sync ───");
      addLog("");

      let syncErrors = false;
      let repo = "";

      // Set a 60-second timeout for the entire sync process
      const syncTimeoutMs = 60_000;
      const timeoutHandle = setTimeout(() => {
        addLog("✗ sync timed out after 60s");
        setSyncing(false);
        setError("Sync timed out. Check your connection and try again.");
        setBusy(false);
      }, syncTimeoutMs);

      try {
        try {
          const bootstrap = await projectBootstrap({
            orgName: orgName || creds.orgId,
            orgId: creds.orgId,
          });
          repo = bootstrap.path;
          addLog(`✓ project   ${repo}`);
        } catch (e) {
          addLog(`✗ project bootstrap failed: ${e}`);
          syncErrors = true;
        }

        if (!syncErrors) {
          addLog("");
          addLog("▸ datastores");
          try {
            const datastores = await resolveProjectDatastores(creds, addLog);
            const itemsByCollection: Record<string, { items: any[]; hasMore: boolean }> = {};
            let totalItems = 0;
            for (const ds of datastores) {
              const data = await fetchDatastoreItems(creds, ds.id);
              itemsByCollection[ds.id] = data;
              totalItems += data.items.length;
            }
            const { written, unchanged } = await syncDatastoresToDisk(repo, datastores, itemsByCollection);
            addLog(`    ${datastores.length} collection(s), ${totalItems} item(s) — ${written} file(s) written, ${unchanged} unchanged`);
          } catch (e) {
            addLog(`    ✗ failed: ${e}`);
            syncErrors = true;
          }
        }

        if (!syncErrors) {
          addLog("");
          addLog("▸ agents");
          try {
            const agents = await resolveProjectAgents(creds);
            for (const a of agents) {
              addLog(`  ✓ ${a.name ?? "(unnamed)"}  (id: ${(a as any).id ?? "?"})`);
            }
            const a = await syncAgentsToDisk(repo, agents);
            addLog(`    ${agents.length} agent(s) — ${a.written} file(s) written, ${a.unchanged} unchanged`);
          } catch (e) {
            addLog(`    ✗ failed: ${e}`);
            syncErrors = true;
          }
        }

        if (!syncErrors) {
          addLog("");
          addLog("▸ workflows");
          try {
            const workflows = await resolveProjectWorkflows(creds);
            for (const w of workflows) {
              addLog(`  ✓ ${w.name}  (id: ${w.id})`);
            }
            const w = await syncWorkflowsToDisk(repo, workflows);
            addLog(`    ${workflows.length} workflow(s) — ${w.written} file(s) written, ${w.unchanged} unchanged`);
          } catch (e) {
            addLog(`    ✗ failed: ${e}`);
            syncErrors = true;
          }
        }

        if (!syncErrors) {
          addLog("");
          addLog("▸ filestores");
          try {
            const filestores = await resolveProjectFilestores(creds, addLog);
            let totalDownloaded = 0;
            let totalRemote = 0;
            for (const fs of filestores) {
              const r = await pullOnce({ creds, repo, collection: fs });
              totalDownloaded += r.downloaded;
              totalRemote += r.total;
            }
            addLog(`    ${filestores.length} collection(s), ${totalRemote} file(s) on remote — ${totalDownloaded} downloaded`);
          } catch (e) {
            addLog(`    ✗ failed: ${e}`);
            syncErrors = true;
          }
        }

        if (!syncErrors) {
          addLog("");
          addLog("▸ knowledge base");
          try {
            const orgSlug = repo.split("/").filter(Boolean).pop() ?? repo;
            const r = await startKbSync({
              creds,
              repo,
              orgSlug,
              orgName: orgName || creds.orgId,
              onLog: addLog,
            });
            const pulled = r?.pulled ?? 0;
            const total = r?.total ?? 0;
            addLog(`    ${total} file(s) on remote — ${pulled} downloaded`);
          } catch (e) {
            addLog(`    ✗ failed: ${e}`);
            syncErrors = true;
          }
        }

        if (!syncErrors) {
          addLog("");
          addLog("▸ plugin (Claude Code)");
          try {
            await syncSkillsToDisk(repo, creds, addLog);
          } catch (e) {
            addLog(`    ✗ failed: ${e}`);
            syncErrors = true;
          }
        }

        clearTimeout(timeoutHandle);
        
        if (syncErrors) {
          addLog("");
          addLog("─── sync failed ───");
          setSyncing(false);
          setSyncDone(true);
          setError("Sync failed. Check logs above for details.");
          setBusy(false);
          return;
        }

        addLog("");
        addLog("─── sync complete ───");
        setSyncing(false);
        setSyncDone(true);
        setBusy(false);
        onConnected(orgName);
      } catch (syncErr) {
        clearTimeout(timeoutHandle);
        addLog(`[sync] Unexpected error: ${syncErr}`);
        setSyncing(false);
        setSyncDone(true);
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
      <div className={`confirm-modal-body ${syncing || syncDone ? "wide" : ""}`}>
        <h3>Connect Pinkfish</h3>
        
        {syncing || syncDone ? (
          <div style={{ marginTop: "20px" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: "10px",
              }}
            >
              <p style={{ fontSize: "14px", color: "#666", margin: 0 }}>
                {syncing
                  ? "🔄 Syncing collections and resources..."
                  : error
                  ? "✗ Sync finished with errors. Review the log below."
                  : "✓ Sync complete. Review the log below."}
              </p>
              <button
                onClick={copyLogs}
                disabled={syncLogs.length === 0}
                style={{ fontSize: "12px", padding: "4px 10px" }}
              >
                {copied ? "✓ Copied" : "Copy log"}
              </button>
            </div>
            <div
              style={{
                backgroundColor: "#f5f5f5",
                border: "1px solid #ddd",
                borderRadius: "4px",
                padding: "12px",
                fontSize: "12px",
                fontFamily: "monospace",
                maxHeight: "300px",
                overflow: "auto",
                marginBottom: "15px",
                lineHeight: "1.6",
                whiteSpace: "pre",
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
            {syncing ? "Syncing..." : syncDone ? "Close" : "Cancel"}
          </button>
          {!syncing && !syncDone && (
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
