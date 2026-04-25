import { useCallback, useEffect, useState } from "react";
import {
  gitCommitStaged,
  gitDiff,
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

function commitIcon(subject: string): string {
  if (subject.startsWith("sync: pull")) return "↓";
  if (subject.startsWith("sync: deployed")) return "↑";
  if (subject.startsWith("init:")) return "●";
  return "";
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

export function SourceControl({ repo, env, onShowDiff, onDeployLine, onDeployExit }: Props) {
  const [files, setFiles] = useState<GitFileStatus[]>([]);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [commitMsg, setCommitMsg] = useState("");
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    } catch (e) {
      setError(String(e));
    } finally {
      setCommitting(false);
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
          placeholder="Commit message"
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleCommit();
            }
          }}
          disabled={committing}
        />
        <button
          type="button"
          className="sc-commit-btn"
          onClick={handleCommit}
          disabled={committing || !commitMsg.trim() || staged.length === 0}
          title={staged.length === 0 ? "Stage files first" : "Commit staged changes"}
        >
          {committing ? "…" : "Commit"}
        </button>
      </div>
      {error && <div className="sc-error">{error}</div>}

      {/* Deploy = push to main */}
      <div className="sc-deploy-row">
        <DeployButton repo={repo} env={env} onLine={onDeployLine} onExit={onDeployExit} />
        <span className="sc-deploy-hint">Push to Pinkfish</span>
      </div>

      {/* Staged changes */}
      <div className="sc-section">
        <div className="sc-section-header">
          <span className="sc-section-title">
            Staged Changes
            {staged.length > 0 && <span className="sc-count">{staged.length}</span>}
          </span>
          {staged.length > 0 && (
            <button
              type="button"
              className="sc-action"
              onClick={handleUnstageAll}
              title="Unstage all"
            >
              −
            </button>
          )}
        </div>
        {staged.length === 0 && <div className="sc-empty-hint">No staged changes</div>}
        <ul className="sc-file-list">
          {staged.map((f) => (
            <li key={`s-${f.path}`} className="sc-file-row">
              <button
                type="button"
                className="sc-file-name"
                onClick={() => handleFileDiff(f.path)}
                title={f.path}
              >
                {f.path.split("/").pop()}
              </button>
              <span className="sc-file-dir">{f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ""}</span>
              <span className={`sc-badge ${statusColorClass(f.status)}`} title={statusTitle(f.status)}>
                {statusLabel(f.status)}
              </span>
              <button
                type="button"
                className="sc-action"
                onClick={() => handleUnstage([f.path])}
                title="Unstage"
              >
                −
              </button>
            </li>
          ))}
        </ul>
      </div>

      {/* Unstaged changes */}
      <div className="sc-section">
        <div className="sc-section-header">
          <span className="sc-section-title">
            Changes
            {unstaged.length > 0 && <span className="sc-count">{unstaged.length}</span>}
          </span>
          {unstaged.length > 0 && (
            <button
              type="button"
              className="sc-action"
              onClick={handleStageAll}
              title="Stage all"
            >
              +
            </button>
          )}
        </div>
        {unstaged.length === 0 && <div className="sc-empty-hint">No changes</div>}
        <ul className="sc-file-list">
          {unstaged.map((f) => (
            <li key={`u-${f.path}`} className="sc-file-row">
              <button
                type="button"
                className="sc-file-name"
                onClick={() => handleFileDiff(f.path)}
                title={f.path}
              >
                {f.path.split("/").pop()}
              </button>
              <span className="sc-file-dir">{f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ""}</span>
              <span className={`sc-badge ${statusColorClass(f.status)}`} title={statusTitle(f.status)}>
                {statusLabel(f.status)}
              </span>
              <button
                type="button"
                className="sc-action"
                onClick={() => handleStage([f.path])}
                title="Stage"
              >
                +
              </button>
            </li>
          ))}
        </ul>
      </div>

      {/* Commit history */}
      <div className="sc-section sc-history">
        <div className="sc-section-header">
          <span className="sc-section-title">Commits</span>
        </div>
        <ul className="sc-commit-list">
          {commits.map((c) => {
            const icon = commitIcon(c.subject);
            return (
              <li
                key={c.sha}
                className="sc-commit-row"
                onClick={() => repo && gitDiff(repo, c.sha).then(onShowDiff).catch(console.error)}
              >
                <div className="sc-commit-subject">
                  {icon && <span className="sc-commit-icon">{icon}</span>}
                  {c.subject}
                </div>
                <div className="sc-commit-meta">
                  <code className="sc-sha">{c.short_sha}</code>
                  <span>{relativeTime(c.date)}</span>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
