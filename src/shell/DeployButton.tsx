import { useState } from "react";
import { onDeployExit, onDeployLine, pinkitDeploy } from "../lib/api";
import { pushAllToKb, subscribeSync } from "../lib/kbSync";
import { loadCreds } from "../lib/pinkfishAuth";

export function DeployButton({
  repo,
  env,
  onLine,
  onExit,
}: {
  repo: string | null;
  env: string;
  onLine: (line: string) => void;
  onExit: (code: number | null) => void;
}) {
  const [running, setRunning] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const start = async () => {
    if (!repo) return;
    setRunning(true);

    // Step 1: push the local knowledge-base/ folder to Pinkfish before
    // running the deploy script. Skip silently if no creds / collection.
    let collection = null as Awaited<ReturnType<typeof getCollection>> | null;
    try {
      collection = await getCollection();
    } catch (e) {
      console.error("read kb sync state failed:", e);
    }
    const creds = await loadCreds().catch(() => null);
    if (collection && creds) {
      onLine("▸ pushing knowledge base");
      try {
        const { pushed, failed } = await pushAllToKb({
          creds,
          repo,
          collection,
          onLine,
        });
        onLine(`▸ kb push complete: ${pushed} ok, ${failed} failed`);
      } catch (e) {
        onLine(`✗ kb push failed: ${String(e)}`);
      }
    }

    onLine(`▸ pinkit deploy --env ${env}`);

    const unlistenLine = await onDeployLine((p) => onLine(p.line));
    const unlistenExit = await onDeployExit((p) => {
      onExit(p.code);
      setRunning(false);
      unlistenLine();
      unlistenExit();
    });

    try {
      await pinkitDeploy(repo, env);
    } catch (e) {
      onLine(`error: ${String(e)}`);
      setRunning(false);
      unlistenLine();
      unlistenExit();
    }
  };

  // Tiny helper: read the latest sync status to fish out the resolved
  // collection. subscribeSync replays current state synchronously.
  const getCollection = async () => {
    return await new Promise<{ id: string; name: string } | null>((resolve) => {
      const unsub = subscribeSync((s) => {
        unsub();
        resolve(s.collection);
      });
    });
  };

  const handleClick = () => {
    if (running) return;
    if (env === "prod") setConfirming(true);
    else start();
  };

  return (
    <>
      <button
        type="button"
        className="deploy-btn"
        onClick={handleClick}
        disabled={!repo || running}
        title={repo ? `Deploy to ${env}` : "Open a project folder to deploy"}
      >
        {running ? "Deploying…" : "Deploy"}
      </button>
      {confirming && (
        <div className="confirm-modal" role="dialog" aria-label="Confirm production deploy">
          <div className="confirm-modal-body">
            <h3>Deploy to production?</h3>
            <p>
              This will run <code>pinkit deploy --env prod</code> against the connected Pinkfish
              org. Type <strong>prod</strong> to confirm.
            </p>
            <ConfirmInput
              expected="prod"
              onConfirm={() => {
                setConfirming(false);
                start();
              }}
              onCancel={() => setConfirming(false)}
            />
          </div>
        </div>
      )}
    </>
  );
}

function ConfirmInput({
  expected,
  onConfirm,
  onCancel,
}: {
  expected: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  return (
    <div className="confirm-input">
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={expected}
      />
      <button onClick={onCancel}>Cancel</button>
      <button onClick={onConfirm} disabled={value !== expected}>
        Deploy
      </button>
    </div>
  );
}
