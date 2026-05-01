import { useCallback, useEffect, useRef, useState } from "react";
import { Minus, Plus, RefreshCw, Undo2 } from "lucide-react";
import {
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
import { pushAllEntities } from "../lib/pushAll";
import { Button } from "../ui";

type Props = {
  repo: string | null;
  /** True when the Sync tab is the active left-pane tab. Drives commit-msg
   *  pre-fill so the user lands on a ready-to-click form. */
  active?: boolean;
  onShowDiff: (text: string) => void;
  onSyncLine: (line: string) => void;
  onFsChange?: () => void;
  /** Called whenever the count of uncommitted changes changes — used to
   *  drive the badge on the Sync tab label. */
  onChangeCount?: (n: number) => void;
  /** Whether Pinkfish creds are loaded. Drives the Sync-to-Cloud button:
   *  push when true, CTA-to-connect when false. */
  cloudConnected: boolean;
  /** Called when the user clicks Sync to Cloud while not connected.
   *  App-level handler opens the OAuth flow. */
  onConnectRequest: () => void;
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
 * Auto-derived commit subject so the user can just click Commit without
 * typing. One-liner that names what changed; the user can override by
 * typing in the input.
 */
function defaultCommitMessage(files: GitFileStatus[]): string {
  if (files.length === 0) return "";
  const verbFor = (status: string) => {
    if (status === "?" || status === "A") return "add";
    if (status === "D") return "delete";
    return "update";
  };
  if (files.length === 1) {
    const f = files[0];
    return `${verbFor(f.status)} ${f.path}`;
  }
  // Mixed: pick the dominant verb based on majority status.
  const counts = files.reduce<Record<string, number>>((acc, f) => {
    const v = verbFor(f.status);
    acc[v] = (acc[v] ?? 0) + 1;
    return acc;
  }, {});
  const verb = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  return `${verb} ${files.length} files`;
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

export function SourceControl({ repo, active, onShowDiff, onSyncLine, onFsChange, onChangeCount, cloudConnected, onConnectRequest }: Props) {
  const [files, setFiles] = useState<GitFileStatus[]>([]);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [commitMsg, setCommitMsg] = useState("");
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(() => {
    if (!repo) {
      setFiles([]);
      setCommits([]);
      return;
    }
    gitStatusShort(repo).then(setFiles).catch(() => setFiles([]));
    gitLog(repo).then(setCommits).catch(() => setCommits([]));
  }, [repo]);

  /** User-triggered refresh — drives the spin animation on the icon.
   *  Distinct from the 3s background poll, which uses `refresh` directly
   *  and shouldn't flash the spinner on every tick. */
  const handleManualRefresh = useCallback(async () => {
    if (!repo || refreshing) return;
    setRefreshing(true);
    try {
      const [nextFiles, nextCommits] = await Promise.all([
        gitStatusShort(repo).catch(() => [] as GitFileStatus[]),
        gitLog(repo).catch(() => [] as GitCommit[]),
      ]);
      setFiles(nextFiles);
      setCommits(nextCommits);
    } finally {
      // Small floor so the animation reads as a real "I did something"
      // even when the calls resolve in <50ms.
      setTimeout(() => setRefreshing(false), 350);
    }
  }, [repo, refreshing]);

  useEffect(() => {
    refresh();
    if (!repo) return;
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, [refresh, repo]);

  const staged = files.filter((f) => f.staged);
  const unstaged = files.filter((f) => !f.staged);

  // Bubble the change count up so the Sync tab can show a badge.
  useEffect(() => {
    onChangeCount?.(files.length);
  }, [files.length, onChangeCount]);

  // Auto-fill the commit input once per "Sync tab focus session" — only when
  // the user has nothing typed and there are pending changes. After that we
  // leave it alone: clearing the input must stick, and we must not re-fill
  // with a stale message after a successful commit (when commitMsg is set
  // back to "" before the async refresh updates `files`).
  //
  // `commitMsg` is intentionally NOT in the dep array — that's how clearing
  // the input doesn't immediately re-trigger this effect. We read the latest
  // commitMsg from the closure (React re-renders capture it).
  const autoFilledRef = useRef(false);
  useEffect(() => {
    if (!active) {
      // Reset on tab leave so re-focusing gets a fresh auto-fill.
      autoFilledRef.current = false;
      return;
    }
    if (files.length === 0) {
      // Post-commit clean state. Reset the flag so the next change auto-fills.
      autoFilledRef.current = false;
      return;
    }
    if (autoFilledRef.current) return;
    if (commitMsg.trim().length > 0) return;
    setCommitMsg(defaultCommitMessage(files));
    autoFilledRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- commitMsg deliberately excluded; see comment above
  }, [active, files]);

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

  const handleStage = async (paths: string[]) => {
    if (!repo) return;
    try {
      await gitStage(repo, paths);
    } catch (e) {
      setError(`Stage failed: ${String(e)}`);
    }
    refresh();
  };

  const handleUnstage = async (paths: string[]) => {
    if (!repo) return;
    try {
      await gitUnstage(repo, paths);
    } catch (e) {
      setError(`Unstage failed: ${String(e)}`);
    }
    refresh();
  };

  const handleCommit = async () => {
    if (!repo) return;
    const hasPending = staged.length > 0 || unstaged.length > 0;

    // Local-mode + nothing pending → button is the connect CTA (there's
    // nothing to commit and no cloud to push to). Local-mode + pending
    // changes → just commit locally. Cloud-connected → today's commit
    // + push behavior.
    if (!cloudConnected && !hasPending) {
      onConnectRequest();
      return;
    }

    setCommitting(true);
    setError(null);
    try {
      if (hasPending) {
        // VSCode-style smart commit: when nothing is staged, stage
        // everything (the user clearly meant "commit it all"). When
        // something IS staged, only commit those — respect the user's
        // explicit selection.
        const committedSet = staged.length > 0 ? staged : files;
        if (staged.length === 0 && unstaged.length > 0) {
          await gitStage(repo, unstaged.map((f) => f.path));
        }
        const msg = commitMsg.trim() || defaultCommitMessage(committedSet);
        await gitCommitStaged(repo, msg);
        setCommitMsg("");
        refresh();
        onFsChange?.();
      }

      // Push only when connected — local-only mode has nothing to push
      // to. The push internals use content equality and catch silent
      // drift between local and remote (e.g. post-conflict-resolve
      // state where the merged content sits unpushed).
      if (cloudConnected) {
        await pushAllEntities(repo, onSyncLine);
        if (!hasPending) {
          // After push the engine's poll will detect the now-matching
          // content and the conflict aggregate will clear naturally.
          refresh();
        }
      }
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
          placeholder={
            files.length > 0
              ? defaultCommitMessage(staged.length > 0 ? staged : files)
              : "Commit message"
          }
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
        <Button
          variant="primary"
          size="sm"
          onClick={handleCommit}
          disabled={committing}
          loading={committing}
          title={
            files.length > 0
              ? cloudConnected
                ? "Commit and sync to Cloud"
                : "Commit locally (Connect to Cloud to also sync)"
              : cloudConnected
                ? "Sync with Cloud (catches silent content drift)"
                : "Connect to Cloud to enable sync"
          }
        >
          {committing
            ? "…"
            : files.length > 0
              ? "Commit"
              : "Sync with Cloud"}
        </Button>
      </div>
      {error && <div className="sc-error">{error}</div>}

      {/* Staged + Changes lists. VSCode-style — Staged renders only when
          something is actually staged; Changes is the persistent home so
          the header doesn't pop in/out as the user stages files. */}
      <div className="sc-changes">
        {staged.length > 0 && (
          <>
            <div className="sc-group-header">
              <span className="sc-group-label">Staged Changes</span>
              <span className="sc-count">{staged.length}</span>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                onClick={() => handleUnstage(staged.map((f) => f.path))}
                title="Unstage all changes"
                aria-label="Unstage all changes"
              >
                <Minus size={14} />
              </Button>
            </div>
            <ul className="sc-file-list">
              {staged.map((f) => (
                <li key={`staged-${f.path}`} className="sc-file-row">
                  <Button
                    variant="link"
                    className="sc-file-name"
                    onClick={() => handleFileDiff(f.path)}
                    title={f.path}
                  >
                    {f.path.split("/").pop()}
                  </Button>
                  <span className="sc-file-dir">{f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ""}</span>
                  <span className={`sc-badge ${statusColorClass(f.status)}`} title={statusTitle(f.status)}>
                    {statusLabel(f.status)}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    onClick={() => handleUnstage([f.path])}
                    title="Unstage changes"
                    aria-label="Unstage changes"
                  >
                    <Minus size={14} />
                  </Button>
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="sc-group-header">
          <span className="sc-group-label">Changes</span>
          <span className="sc-count">{unstaged.length}</span>
          {unstaged.length > 0 && (
            <>
              <Button
                variant="ghost"
                tone="destructive"
                size="sm"
                iconOnly
                onClick={() => handleDiscard(unstaged.map((f) => f.path))}
                title="Discard all changes"
                aria-label="Discard all changes"
              >
                <Undo2 size={14} />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                onClick={() => handleStage(unstaged.map((f) => f.path))}
                title="Stage all changes"
                aria-label="Stage all changes"
              >
                <Plus size={14} />
              </Button>
            </>
          )}
        </div>
        {unstaged.length > 0 ? (
          <ul className="sc-file-list">
            {unstaged.map((f) => (
              <li key={`unstaged-${f.path}`} className="sc-file-row">
                <Button
                  variant="link"
                  className="sc-file-name"
                  onClick={() => handleFileDiff(f.path)}
                  title={f.path}
                >
                  {f.path.split("/").pop()}
                </Button>
                <span className="sc-file-dir">{f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ""}</span>
                <span className={`sc-badge ${statusColorClass(f.status)}`} title={statusTitle(f.status)}>
                  {statusLabel(f.status)}
                </span>
                <Button
                  variant="ghost"
                  tone="destructive"
                  size="sm"
                  iconOnly
                  onClick={() => handleDiscard([f.path])}
                  title="Discard changes"
                  aria-label="Discard changes"
                >
                  <Undo2 size={14} />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  onClick={() => handleStage([f.path])}
                  title="Stage changes"
                  aria-label="Stage changes"
                >
                  <Plus size={14} />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="sc-empty-hint">
            {staged.length > 0 ? "All changes staged" : "No changes"}
          </div>
        )}
      </div>

      {/* Commit history */}
      <div className="sc-history">
        <div className="sc-group-header">
          <span className="sc-group-label">Commits</span>
          <span className="sc-count">{commits.length}</span>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            onClick={handleManualRefresh}
            disabled={refreshing}
            title="Refresh commits"
            aria-label="Refresh commits"
            className={refreshing ? "is-spinning" : undefined}
          >
            <RefreshCw size={14} />
          </Button>
        </div>
        <ul className="sc-commit-list">
          {commits.map((c) => (
            <li
              key={c.sha}
              className="sc-commit-row"
              onClick={() => repo && gitDiff(repo, c.sha).then(onShowDiff).catch(console.error)}
            >
              <div className="sc-timeline">
                <span className={commitDotClass(c.subject)} />
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
