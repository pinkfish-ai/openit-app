import { useCallback, useEffect, useRef, useState } from "react";
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
  type GitCommit,
  type GitFileStatus,
} from "../lib/api";
import { getSyncStatus, kbHasServerShadowFiles, pullNow, pushAllToKb, startKbSync } from "../lib/kbSync";
import {
  pushAllToFilestore,
  getFilestoreSyncStatus,
  pullOnce as filestorePullOnce,
} from "../lib/filestoreSync";
import { pushAllToDatastores, pullDatastoresOnce } from "../lib/datastoreSync";
import { loadCreds } from "../lib/pinkfishAuth";

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

  // Filestore: pre-push pull to detect remote-side edits before we
  // clobber them. Same pattern as KB above.
  const fsCollections = getFilestoreSyncStatus().collections;
  if (fsCollections.length > 0) {
    for (const collection of fsCollections) {
      onLine(`▸ sync: filestore (${collection.name}) pre-push pull`);
      let safe = true;
      try {
        const { ok, error, downloaded } = await filestorePullOnce({
          creds,
          repo,
          collection,
        });
        const conflicts = getFilestoreSyncStatus().conflicts;
        if (!ok) {
          // pullOnce never throws; check ok explicitly. Without this
          // a network/auth failure would leave conflicts empty AND no
          // catch fires — push would silently proceed and clobber.
          safe = false;
          onLine(
            `✗ sync: filestore (${collection.name}) pre-push pull failed: ${error ?? "unknown"}`,
          );
        } else if (conflicts.length > 0) {
          safe = false;
          onLine(
            `✗ sync: filestore (${collection.name}) pull surfaced conflicts — resolve in Claude, then commit again:`,
          );
          for (const c of conflicts) onLine(`  • ${c.filename}: ${c.reason}`);
        } else if (downloaded > 0) {
          onLine(`  ✓ pulled ${downloaded} file(s) before push`);
        }
      } catch (e) {
        safe = false;
        onLine(`✗ sync: filestore (${collection.name}) pre-push pull failed: ${String(e)}`);
      }
      if (!safe) continue;

      onLine(`▸ sync: filestore (${collection.name}) pushing`);
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

  // Datastore: pre-push pull. Without this, user A's edit silently
  // overwrites user B's remote edit when both sides changed since the
  // last sync.
  onLine("▸ sync: datastores pre-push pull");
  let datastorePushSafe = true;
  try {
    const { ok, error, pulled, conflicts } = await pullDatastoresOnce({ creds, repo });
    if (!ok) {
      // resolve / pull failures don't throw — they return ok: false.
      // Without checking, a transient network failure would let push
      // proceed and silently overwrite remote rows we never pulled.
      datastorePushSafe = false;
      onLine(`✗ sync: datastores pre-push pull failed: ${error ?? "unknown"}`);
    } else if (conflicts.length > 0) {
      datastorePushSafe = false;
      onLine(
        "✗ sync: datastores pull surfaced conflicts — resolve in Claude, then commit again:",
      );
      for (const c of conflicts) {
        onLine(`  • ${c.collectionName}/${c.key}.json: ${c.reason}`);
      }
    } else if (pulled > 0) {
      onLine(`  ✓ pulled ${pulled} row(s) before push`);
    }
  } catch (e) {
    datastorePushSafe = false;
    onLine(`✗ sync: datastores pre-push pull failed: ${String(e)}`);
  }

  if (datastorePushSafe) {
    onLine("▸ sync: datastores pushing");
    try {
      const { pushed, failed } = await pushAllToDatastores({ creds, repo, onLine });
      onLine(`▸ sync: datastore push complete — ${pushed} ok, ${failed} failed`);
    } catch (e) {
      onLine(`✗ sync: datastore push failed: ${String(e)}`);
    }
  }

  onLine("▸ sync: done");
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

export function SourceControl({ repo, active, onShowDiff, onSyncLine, onFsChange, onChangeCount }: Props) {
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

  const handleCommit = async () => {
    if (!repo) return;
    setCommitting(true);
    setError(null);
    try {
      // Commit-if-pending: when there are pending changes, stage and
      // commit them locally first. When the working tree is clean (e.g.
      // after a previous auto-commit swept up Claude's edits), skip the
      // commit step but STILL run the push — the push internals use
      // content equality and catch silent drift between local and
      // remote regardless of git state.
      const hasPending = staged.length > 0 || unstaged.length > 0;
      if (hasPending) {
        if (unstaged.length > 0) {
          await gitStage(repo, unstaged.map((f) => f.path));
        }
        const msg = commitMsg.trim() || defaultCommitMessage(files);
        await gitCommitStaged(repo, msg);
        setCommitMsg("");
        refresh();
        onFsChange?.();
      }

      // Always push, regardless of whether a git commit just landed —
      // this is the only path that detects + corrects content drift
      // between local and remote (e.g. post-conflict-resolve state
      // where the merged content sits unpushed).
      await pushOnCommit(repo, onSyncLine);
      if (!hasPending) {
        // After push the engine's poll will detect the now-matching
        // content and the conflict aggregate will clear naturally.
        refresh();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setCommitting(false);
    }
  };

  const handleGenerate = async () => {
    if (!repo || generating || files.length === 0) return;
    setGenerating(true);
    setError(null);
    try {
      // Sparkle reads the diff; auto-stage so it sees the user's actual changes.
      if (unstaged.length > 0) {
        await gitStage(repo, unstaged.map((f) => f.path));
      }
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
          placeholder={
            generating
              ? "Generating commit message…"
              : files.length > 0
              ? defaultCommitMessage(files)
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
          disabled={committing || generating}
        />
        {claudeAvailable && (
          <button
            type="button"
            className={`sc-sparkle-btn${generating ? " is-generating" : ""}`}
            onClick={handleGenerate}
            disabled={generating || committing || files.length === 0}
            aria-busy={generating}
            aria-label="Generate commit message with Claude"
            title={
              files.length === 0
                ? "No changes"
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
          disabled={committing || generating}
          title={
            files.length === 0
              ? "Push to Pinkfish (catches silent content drift)"
              : "Commit and push to Pinkfish"
          }
        >
          {committing
            ? "…"
            : files.length === 0
            ? "Sync to Pinkfish"
            : "Commit"}
        </button>
      </div>
      {error && <div className="sc-error">{error}</div>}

      {/* Single Changes list — Commit auto-stages everything. */}
      <div className="sc-changes">
        {files.length > 0 ? (
          <>
            <div className="sc-group-header">
              <span className="sc-group-label">Changes</span>
              <span className="sc-count">{files.length}</span>
              <button
                type="button"
                className="sc-hdr-action sc-hdr-discard"
                onClick={() => handleDiscard(files.map((f) => f.path))}
                title="Discard all changes"
              >
                ↺
              </button>
            </div>
            <ul className="sc-file-list">
              {files.map((f) => (
                <li key={f.path} className="sc-file-row">
                  <button type="button" className="sc-file-name" onClick={() => handleFileDiff(f.path)} title={f.path}>
                    {f.path.split("/").pop()}
                  </button>
                  <span className="sc-file-dir">{f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ""}</span>
                  <span className={`sc-badge ${statusColorClass(f.status)}`} title={statusTitle(f.status)}>
                    {statusLabel(f.status)}
                  </span>
                  <button
                    type="button"
                    className="sc-row-action sc-row-discard"
                    onClick={() => handleDiscard([f.path])}
                    title="Discard changes"
                  >
                    ↺
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
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
