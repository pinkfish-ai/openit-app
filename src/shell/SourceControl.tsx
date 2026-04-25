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
import { DeployButton } from "./DeployButton";

type Props = {
  repo: string | null;
  env: string;
  onShowDiff: (text: string) => void;
  onDeployLine: (line: string) => void;
  onDeployExit: (code: number | null) => void;
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
  if (subject.startsWith("sync: deployed")) return "sc-commit-dot dot-push";
  if (subject.startsWith("init:") || subject.startsWith("pre-deploy")) return "sc-commit-dot dot-init";
  return "sc-commit-dot";
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

export function SourceControl({ repo, env, onShowDiff, onDeployLine, onDeployExit, onFsChange }: Props) {
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

  // User commits since the last sync — i.e. commits the user authored that
  // haven't been replicated to Pinkfish yet. Stops counting at the first
  // sync:/init:/pre-deploy commit. If the log has none, every commit counts.
  const isSyncCommit = (subject: string) =>
    subject.startsWith("sync:") ||
    subject.startsWith("init:") ||
    subject.startsWith("pre-deploy");
  const firstSyncIdx = commits.findIndex((c) => isSyncCommit(c.subject));
  const pendingCount = firstSyncIdx === -1 ? commits.length : firstSyncIdx;

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
      if (created) {
        setCommitMsg("");
      } else {
        setError("Nothing to commit");
      }
      refresh();
      onFsChange?.();
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

      <div className="sc-deploy-row">
        <DeployButton
          repo={repo}
          env={env}
          onLine={onDeployLine}
          onExit={onDeployExit}
          dirty={files.length > 0}
          pendingCount={pendingCount}
        />
      </div>

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
