import { useEffect, useState } from "react";
import { gitDiff, gitLog, type GitCommit } from "../lib/api";

function commitIcon(subject: string): string {
  if (subject.startsWith("sync: pull")) return "↓";
  if (subject.startsWith("sync: deployed")) return "↑";
  if (subject.startsWith("init:")) return "●";
  return "";
}

export function VersionsDrawer({
  repo,
  open,
  onClose,
  onShowDiff,
}: {
  repo: string | null;
  open: boolean;
  onClose: () => void;
  onShowDiff: (text: string) => void;
}) {
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !repo) return;
    let cancelled = false;
    gitLog(repo)
      .then((c) => {
        if (!cancelled) {
          setCommits(c);
          setError(null);
        }
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [open, repo]);

  if (!open) return null;

  return (
    <div className="versions-drawer">
      <div className="versions-header">
        <span>Versions</span>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close versions drawer">
          ×
        </button>
      </div>
      {error && <div className="versions-error">{error}</div>}
      <ul className="versions-list">
        {commits.map((c) => {
          const icon = commitIcon(c.subject);
          return (
            <li
              key={c.sha}
              className="commit"
              onClick={() => repo && gitDiff(repo, c.sha).then(onShowDiff).catch(console.error)}
            >
              <code className="sha">{c.short_sha}</code>
              <span className="subject">
                {icon ? (
                  <span className="commit-sync-icon" title="Sync">
                    {icon}{" "}
                  </span>
                ) : null}
                {c.subject}
              </span>
              <span className="meta">
                {c.author} · {c.date.split("T")[0]}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
