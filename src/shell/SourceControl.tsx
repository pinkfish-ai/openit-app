import { useCallback, useEffect, useState } from "react";
import {
  claudeDetect,
  claudeGenerateCommitMessage,
  gitCommitStaged,
  gitDiff,
  gitDiscard,
  gitFileDiff,
  gitLog,
  gitStage,
  gitStatusShort,
  gitUnstage,
  type GitCommit,
  type GitFileStatus,
} from "../lib/api";
import { getSyncStatus, kbHasServerShadowFiles, pullNow, pushAllToKb, startKbSync } from "../lib/kbSync";
import { pushAllToFilestore, getFilestoreSyncStatus } from "../lib/filestoreSync";
import { pushAllToDatastores } from "../lib/datastoreSync";
import { loadCreds } from "../lib/pinkfishAuth";

type Props = {
  repo: string | null;
  onShowDiff: (text: string) => void;
  onSyncLine: (line: string) => void;
  onFsChange?: () => void;
};

function statusLabel(s: string): string {
  if (s === "?") return "U";
  if (s === "UU") return "C";
  return s;
}

function statusTitle(s: string): string {
  if (s === "?") return "Untracked";
  if (s === "M") return "Modified";
  if (s === "A") return "Added";
  if (s === "D") return "Deleted";
  if (s === "UU") return "Conflict";
  return s;
}

function statusColorClass(s: string): string {
  if (s === "?") return "sc-badge-untracked";
  if (s === "M") return "sc-badge-modified";
  if (s === "A") return "sc-badge-added";
  if (s === "D") return "sc-badge-deleted";
  if (s === "UU") return "sc-badge-conflict";
  return "";
}

function commitDotClass(subject: string): string {
  if (subject.startsWith("sync: pull")) return "sc-commit-dot dot-pull";
  if (subject.startsWith("sync: push")) return "sc-commit-dot dot-push";
  if (subject.startsWith("init:")) return "sc-commit-dot dot-init";
  return "sc-commit-dot";
}

/**
 * After a successful local commit, push every bidirectional entity to
 * Pinkfish. KB and filestore use their existing push functions; datastores
 * use the new pushAllToDatastores. We pre-pull KB to avoid clobbering
 * teammate edits, then push each entity in parallel and stream results.
 */
async function pushOnCommit(
  repo: string,
  onLine: (line: string) => void,
): Promise<void> {
  const creds = await loadCreds().catch(() => null);
  if (!creds) {
    onLine("✗ sync: not authenticated");
    return;
  }

  onLine("▸ sync: starting push to Pinkfish");

  // KB requires a resolved collection; if sync hasn't run yet (e.g. user
  // commits before the initial pull completes), kick it off inline.
  let kbCollection = getSyncStatus().collection;
  if (!kbCollection) {
    onLine("▸ sync: resolving knowledge base");
    try {
      const slug = (repo.split("/").pop() ?? "").trim();
      await startKbSync({ creds, repo, orgSlug: slug, orgName: slug });
      kbCollection = getSyncStatus().collection;
    } catch (e) {
      onLine(`✗ sync: kb resolve failed: ${String(e)}`);
    }
  }

  // KB: pre-pull to detect remote/local conflicts before we clobber anything.
  if (kbCollection) {
    const shadowBefore = await kbHasServerShadowFiles(repo);
    if (shadowBefore) {
      onLine(
        "✗ sync: kb has unresolved merge shadow (.server.) files — resolve and commit again",
      );
    } else {
      onLine("▸ sync: kb pre-push pull");
      try {
        await pullNow({ creds, repo, collection: kbCollection });
        const conflicts = getSyncStatus().conflicts;
        const hasShadow = await kbHasServerShadowFiles(repo);
        if (conflicts.length > 0 || hasShadow) {
          onLine(
            "✗ sync: kb pull surfaced conflicts — resolve in Claude, then commit again:",
          );
          for (const c of conflicts) onLine(`  • ${c.filename}: ${c.reason}`);
          if (hasShadow && conflicts.length === 0) {
            onLine("  • server shadow files present under knowledge-base/");
          }
        } else {
          onLine("▸ sync: kb pushing");
          try {
            const { pushed, failed } = await pushAllToKb({
              creds,
              repo,
              collection: kbCollection,
              onLine,
            });
            onLine(`▸ sync: kb push complete — ${pushed} ok, ${failed} failed`);
          } catch (e) {
            onLine(`✗ sync: kb push failed: ${String(e)}`);
          }
        }
      } catch (e) {
        onLine(`✗ sync: kb pull failed: ${String(e)}`);
      }
    }
  } else {
    onLine("▸ sync: kb skipped (no collection)");
  }

  // Filestore push.
  const fsCollections = getFilestoreSyncStatus().collections;
  if (fsCollections.length > 0) {
    onLine("▸ sync: filestore pushing");
    for (const collection of fsCollections) {
      try {
        const { pushed, failed } = await pushAllToFilestore({
          creds,
          repo,
          collection,
          onLine,
        });
        onLine(
          `▸ sync: filestore push (${collection.name}) — ${pushed} ok, ${failed} failed`,
        );
      } catch (e) {
        onLine(`✗ sync: filestore push (${collection.name}) failed: ${String(e)}`);
      }
    }
  } else {
    onLine("▸ sync: filestore skipped (no collections)");
  }

  // Datastore push.
  onLine("▸ sync: datastores pushing");
  try {
    const { pushed, failed } = await pushAllToDatastores({ creds, repo, onLine });
    onLine(`▸ sync: datastore push complete — ${pushed} ok, ${failed} failed`);
  } catch (e) {
    onLine(`✗ sync: datastore push failed: ${String(e)}`);
  }

  onLine("▸ sync: done");
}

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffSec = Math.floor((now - then) / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return dateStr.split("T")[0];
}

export function SourceControl({ repo, onShowDiff, onSyncLine, onFsChange }: Props) {
  const [files, setFiles] = useState<GitFileStatus[]>([]);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [commitMsg, setCommitMsg] = useState("");
  const [committing, setCommitting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [claudeAvailable, setClaudeAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    claudeDetect().then((p) => setClaudeAvailable(!!p)).catch(() => setClaudeAvailable(false));
  }, []);

  const refresh = useCallback(() => {
    if (!repo) {
      setFiles([]);
      setCommits([]);
      return;
    }
    gitStatusShort(repo).then(setFiles).catch(() => setFiles([]));
    gitLog(repo).then(setCommits).catch(() => setCommits([]));
  }, [repo]);

  useEffect(() => {
    refresh();
    if (!repo) return;
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, [refresh, repo]);

  const staged = files.filter((f) => f.staged);
  const unstaged = files.filter((f) => !f.staged);

  const handleStage = async (paths: string[]) => {
    if (!repo) return;
    await gitStage(repo, paths);
    refresh();
  };

  const handleUnstage = async (paths: string[]) => {
    if (!repo) return;
    await gitUnstage(repo, paths);
    refresh();
  };

  const handleStageAll = () => handleStage(unstaged.map((f) => f.path));
  const handleUnstageAll = () => handleUnstage(staged.map((f) => f.path));

  const handleDiscard = async (paths: string[]) => {
    if (!repo) return;
    try {
      await gitDiscard(repo, paths);
    } catch (e) {
      setError(`Discard failed: ${String(e)}`);
    }
    refresh();
    onFsChange?.();
  };

  const handleDiscardAll = () => handleDiscard(unstaged.map((f) => f.path));

  const handleCommit = async () => {
    if (!repo || !commitMsg.trim() || staged.length === 0) return;
    setCommitting(true);
    setError(null);
    try {
      const created = await gitCommitStaged(repo, commitMsg.trim());
      if (!created) {
        setError("Nothing to commit");
        return;
      }
      setCommitMsg("");
      refresh();
      onFsChange?.();

      // Auto-push to Pinkfish across all bidirectional entities.
      await pushOnCommit(repo, onSyncLine);
    } catch (e) {
      setError(String(e));
    } finally {
      setCommitting(false);
    }
  };

  const handleGenerate = async () => {
    if (!repo || generating || staged.length === 0) return;
    setGenerating(true);
    setError(null);
    try {
      const subject = await claudeGenerateCommitMessage(repo);
      setCommitMsg(subject);
    } catch (e) {
      setError(`Generate failed: ${String(e)}`);
    } finally {
      setGenerating(false);
    }
  };

  const handleFileDiff = async (path: string) => {
    if (!repo) return;
    try {
      const diff = await gitFileDiff(repo, path);
      onShowDiff(diff || `(no diff for ${path})`);
    } catch {
      onShowDiff(`(could not diff ${path})`);
    }
  };

  if (!repo) {
    return <div className="sc-panel sc-empty">No project open</div>;
  }

  return (
    <div className="sc-panel">
      {/* Commit input */}
      <div className="sc-commit-box">
        <input
          className="sc-commit-input"
          placeholder={generating ? "Generating commit message…" : "Commit message"}
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleCommit();
            }
          }}
          disabled={committing || generating}
        />
        {claudeAvailable && (
          <button
            type="button"
            className={`sc-sparkle-btn${generating ? " is-generating" : ""}`}
            onClick={handleGenerate}
            disabled={generating || committing || staged.length === 0}
            aria-busy={generating}
            aria-label="Generate commit message with Claude"
            title={
              staged.length === 0
                ? "Stage files first"
                : generating
                ? "Asking Claude…"
                : "Generate commit message with Claude"
            }
          >
            {generating ? <span className="sc-spinner" aria-hidden="true" /> : "✨"}
          </button>
        )}
        <button
          type="button"
          className="sc-commit-btn"
          onClick={handleCommit}
          disabled={committing || generating || !commitMsg.trim() || staged.length === 0}
          title={staged.length === 0 ? "Stage files first" : "Commit staged changes"}
        >
          {committing ? "…" : "Commit"}
        </button>
      </div>
      {error && <div className="sc-error">{error}</div>}

      {/* Staged + Changes — tight VS Code-style layout, no dividers */}
      <div className="sc-changes">
        {staged.length > 0 && (
          <>
            <div className="sc-group-header">
              <span className="sc-group-label">Staged Changes</span>
              <span className="sc-count">{staged.length}</span>
              <button type="button" className="sc-hdr-action" onClick={handleUnstageAll} title="Unstage all">−</button>
            </div>
            <ul className="sc-file-list">
              {staged.map((f) => (
                <li key={`s-${f.path}`} className="sc-file-row">
                  <button type="button" className="sc-file-name" onClick={() => handleFileDiff(f.path)} title={f.path}>
                    {f.path.split("/").pop()}
                  </button>
                  <span className="sc-file-dir">{f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ""}</span>
                  <span className={`sc-badge ${statusColorClass(f.status)}`} title={statusTitle(f.status)}>
                    {statusLabel(f.status)}
                  </span>
                  <button type="button" className="sc-row-action" onClick={() => handleUnstage([f.path])} title="Unstage">−</button>
                </li>
              ))}
            </ul>
          </>
        )}

        {unstaged.length > 0 && (
          <>
            <div className="sc-group-header">
              <span className="sc-group-label">Changes</span>
              <span className="sc-count">{unstaged.length}</span>
              <button type="button" className="sc-hdr-action sc-hdr-discard" onClick={handleDiscardAll} title="Discard all changes">↺</button>
              <button type="button" className="sc-hdr-action" onClick={handleStageAll} title="Stage all">+</button>
            </div>
            <ul className="sc-file-list">
              {unstaged.map((f) => (
                <li key={`u-${f.path}`} className="sc-file-row">
                  <button type="button" className="sc-file-name" onClick={() => handleFileDiff(f.path)} title={f.path}>
                    {f.path.split("/").pop()}
                  </button>
                  <span className="sc-file-dir">{f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ""}</span>
                  <span className={`sc-badge ${statusColorClass(f.status)}`} title={statusTitle(f.status)}>
                    {statusLabel(f.status)}
                  </span>
                  <button type="button" className="sc-row-action sc-row-discard" onClick={() => handleDiscard([f.path])} title="Discard changes">↺</button>
                  <button type="button" className="sc-row-action" onClick={() => handleStage([f.path])} title="Stage">+</button>
                </li>
              ))}
            </ul>
          </>
        )}

        {staged.length === 0 && unstaged.length === 0 && (
          <div className="sc-empty-hint">No changes</div>
        )}
      </div>

      {/* Commit history */}
      <div className="sc-history">
        <div className="sc-group-header">
          <span className="sc-group-label">Commits</span>
          <span className="sc-count">{commits.length}</span>
          <button type="button" className="sc-hdr-action" onClick={refresh} title="Refresh commits">↻</button>
        </div>
        <ul className="sc-commit-list">
          {commits.map((c, i) => (
            <li
              key={c.sha}
              className="sc-commit-row"
              onClick={() => repo && gitDiff(repo, c.sha).then(onShowDiff).catch(console.error)}
            >
              <div className="sc-timeline">
                <span className={commitDotClass(c.subject)} />
                {i < commits.length - 1 && <span className="sc-timeline-line" />}
              </div>
              <div className="sc-commit-body">
                <div className="sc-commit-subject">{c.subject}</div>
                <div className="sc-commit-meta">
                  <code className="sc-sha">{c.short_sha}</code>
                  <span>{relativeTime(c.date)}</span>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
