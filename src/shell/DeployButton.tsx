import { useState } from "react";
import { onDeployExit, onDeployLine, pinkitDeploy } from "../lib/api";
import {
  getSyncStatus,
  kbHasServerShadowFiles,
  pullNow,
  pushAllToKb,
  startKbSync,
} from "../lib/kbSync";
import { loadCreds } from "../lib/pinkfishAuth";

export function DeployButton({
  repo,
  env,
  onLine,
  onExit,
  dirty = false,
  latestCommitSubject = null,
}: {
  repo: string | null;
  env: string;
  onLine: (line: string) => void;
  onExit: (code: number | null) => void;
  /** Working tree has uncommitted changes. When true, push is disabled. */
  dirty?: boolean;
  /** Subject of the most recent commit. Used to detect "nothing new to push". */
  latestCommitSubject?: string | null;
}) {
  const [running, setRunning] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // If the most recent commit is a sync/init commit, there's nothing the user
  // has done since the last pull or push that hasn't been replicated already.
  const nothingToPush =
    latestCommitSubject !== null &&
    (latestCommitSubject.startsWith("sync:") ||
      latestCommitSubject.startsWith("init:") ||
      latestCommitSubject.startsWith("pre-deploy"));

  const start = async () => {
    if (!repo) return;
    setRunning(true);

    let collection = getSyncStatus().collection;
    const creds = await loadCreds().catch(() => null);
    // If kb sync hasn't resolved a collection yet (e.g. user clicked Deploy
    // before the initial pull finished), kick it off inline before push.
    if (!collection && creds && repo) {
      onLine("▸ resolving knowledge base…");
      try {
        const slug = (repo.split("/").pop() ?? "").trim();
        await startKbSync({ creds, repo, orgSlug: slug, orgName: slug });
        collection = getSyncStatus().collection;
      } catch (e) {
        onLine(`✗ kb resolve failed: ${String(e)}`);
      }
    }
    if (collection && creds) {
      const shadowBefore = await kbHasServerShadowFiles(repo);
      if (shadowBefore) {
        onLine(
          "✗ kb: merge shadow files (.server.) still in knowledge-base/ — ask Claude to resolve, then deploy again.",
        );
        setRunning(false);
        return;
      }
      // Pull first so deploys don't blow away teammate edits with stale local state.
      onLine("▸ pulling knowledge base");
      try {
        await pullNow({ creds, repo, collection });
        const conflicts = getSyncStatus().conflicts;
        const hasShadow = await kbHasServerShadowFiles(repo);
        if (conflicts.length > 0 || hasShadow) {
          onLine(
            "✗ kb pull: merge conflict(s) — ask Claude to resolve (see File explorer), then deploy again:",
          );
          for (const c of conflicts) onLine(`  • ${c.filename}: ${c.reason}`);
          if (hasShadow && conflicts.length === 0) {
            onLine("  • server shadow files present under knowledge-base/ (remove after merge)");
          }
          setRunning(false);
          return;
        }
      } catch (e) {
        onLine(`✗ kb pull failed: ${String(e)}`);
        setRunning(false);
        return;
      }

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
    } else {
      onLine(`▸ kb push skipped (collection=${!!collection}, creds=${!!creds})`);
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
        disabled={!repo || running || dirty || nothingToPush}
        title={
          !repo
            ? "Open a project folder first"
            : dirty
            ? "Commit your changes first"
            : nothingToPush
            ? "Nothing new to push"
            : `Push to Pinkfish (${env})`
        }
      >
        {running ? "Pushing…" : "Push to Pinkfish"}
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
