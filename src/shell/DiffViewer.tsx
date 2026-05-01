import type { KeyboardEvent } from "react";

/**
 * Renders unified-diff text VSCode-style: per-file blocks with header,
 * hunk separators, gutter line numbers, and per-line +/-/context tints.
 *
 * Input is the raw `git diff` / `git diff <sha>` output. Empty or
 * non-diff input falls back to a small italic placeholder so the
 * commit-list "no diff" case still reads sensibly.
 */
type DiffLine =
  | { kind: "context"; old: number; new: number; text: string }
  | { kind: "add"; new: number; text: string }
  | { kind: "del"; old: number; text: string }
  | { kind: "meta"; text: string };

type DiffHunk = {
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
};

type DiffFile = {
  oldPath: string;
  newPath: string;
  status: "modified" | "added" | "deleted" | "renamed";
  /** True when git emitted "Binary files ... differ" instead of a hunk
   *  body. Filestore images / PDFs hit this path. */
  binary: boolean;
  hunks: DiffHunk[];
};

function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  if (!text || !text.trim()) return files;

  const lines = text.split("\n");
  let i = 0;
  let hunk: DiffHunk | null = null;
  let oldLn = 0;
  let newLn = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("diff --git ")) {
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      const a = m?.[1] ?? "";
      const b = m?.[2] ?? "";
      const next: DiffFile = { oldPath: a, newPath: b, status: "modified", binary: false, hunks: [] };
      files.push(next);
      hunk = null;
      i++;
      continue;
    }
    const current = files.length > 0 ? files[files.length - 1] : null;
    if (!current) {
      i++;
      continue;
    }
    if (line.startsWith("new file mode")) {
      current.status = "added";
      i++;
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      current.status = "deleted";
      i++;
      continue;
    }
    if (line.startsWith("rename from") || line.startsWith("rename to")) {
      current.status = "renamed";
      i++;
      continue;
    }
    if (line.startsWith("--- ")) {
      const p = line.slice(4).replace(/^a\//, "");
      if (p && p !== "/dev/null") current.oldPath = p;
      i++;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).replace(/^b\//, "");
      if (p && p !== "/dev/null") current.newPath = p;
      i++;
      continue;
    }
    if (line.startsWith("@@")) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
      const oldStart = m ? Number(m[1]) : 0;
      const newStart = m ? Number(m[2]) : 0;
      hunk = { header: line, oldStart, newStart, lines: [] };
      current.hunks.push(hunk);
      oldLn = oldStart;
      newLn = newStart;
      i++;
      continue;
    }
    if (!hunk) {
      // Pre-hunk metadata (index ..., Binary files differ, etc.).
      i++;
      continue;
    }
    if (line.startsWith("\\ ")) {
      // "\ No newline at end of file" — render as meta.
      hunk.lines.push({ kind: "meta", text: line });
      i++;
      continue;
    }
    if (line.startsWith("+")) {
      hunk.lines.push({ kind: "add", new: newLn, text: line.slice(1) });
      newLn++;
      i++;
      continue;
    }
    if (line.startsWith("-")) {
      hunk.lines.push({ kind: "del", old: oldLn, text: line.slice(1) });
      oldLn++;
      i++;
      continue;
    }
    if (line.startsWith(" ") || line === "") {
      hunk.lines.push({
        kind: "context",
        old: oldLn,
        new: newLn,
        text: line.startsWith(" ") ? line.slice(1) : "",
      });
      oldLn++;
      newLn++;
      i++;
      continue;
    }
    // Unknown line — treat as meta.
    hunk.lines.push({ kind: "meta", text: line });
    i++;
  }

  return files;
}

function statusLabel(s: DiffFile["status"]): string {
  if (s === "added") return "Added";
  if (s === "deleted") return "Deleted";
  if (s === "renamed") return "Renamed";
  return "Modified";
}

export function DiffViewer({
  text,
  onOpenFile,
}: {
  text: string;
  /** Called with the repo-relative path when the user clicks the file
   *  header. Wires up the "click filename → open file in viewer +
   *  highlight in file explorer" flow. */
  onOpenFile?: (relPath: string) => void;
}) {
  const trimmed = text.trim();
  if (!trimmed) {
    return <div className="diff-empty">No diff.</div>;
  }
  const files = parseDiff(text);
  if (files.length === 0) {
    // Looks non-diff (e.g. an error message piped in). Fall back to
    // pre-formatted text so the user still sees what came back.
    return <pre className="diff-fallback">{text}</pre>;
  }

  return (
    <div className="diff-viewer">
      {files.map((file, idx) => {
        const path = file.newPath || file.oldPath;
        const renamed = file.status === "renamed" && file.oldPath !== file.newPath;
        // Deleted files no longer exist on disk — not openable.
        const openable = !!onOpenFile && file.status !== "deleted" && !!path;
        const headerClass = `diff-file-header status-${file.status}${openable ? " is-clickable" : ""}`;
        const headerProps = openable
          ? {
              role: "button" as const,
              tabIndex: 0,
              onClick: () => onOpenFile?.(path),
              onKeyDown: (e: KeyboardEvent) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onOpenFile?.(path);
                }
              },
              title: `Open ${path}`,
            }
          : { title: path };
        return (
          <section key={`${path}-${idx}`} className="diff-file">
            <header className={headerClass} {...headerProps}>
              <span className="diff-file-path">
                {path}
              </span>
              {renamed && (
                <span className="diff-file-rename" title={file.oldPath}>
                  ← {file.oldPath}
                </span>
              )}
              <span className="diff-file-status">{statusLabel(file.status)}</span>
            </header>
            {file.hunks.length === 0 ? (
              <div className="diff-empty-hunks">
                {file.status === "added"
                  ? "(new empty file)"
                  : file.status === "deleted"
                  ? "(file removed)"
                  : "(no textual changes)"}
              </div>
            ) : (
              file.hunks.map((h, hi) => (
                <div key={hi} className="diff-hunk">
                  <div className="diff-hunk-header" title={h.header}>
                    @@ −{h.oldStart} +{h.newStart} @@
                  </div>
                  <div className="diff-hunk-body" role="table">
                    {h.lines.map((l, li) => {
                      const cls =
                        l.kind === "add"
                          ? "diff-line add"
                          : l.kind === "del"
                          ? "diff-line del"
                          : l.kind === "meta"
                          ? "diff-line meta"
                          : "diff-line ctx";
                      const oldNo =
                        l.kind === "context" || l.kind === "del" ? String(l.old) : "";
                      const newNo =
                        l.kind === "context" || l.kind === "add" ? String(l.new) : "";
                      const sigil =
                        l.kind === "add" ? "+" : l.kind === "del" ? "−" : l.kind === "meta" ? "" : " ";
                      return (
                        <div key={li} className={cls} role="row">
                          <span className="diff-gutter old" role="cell">{oldNo}</span>
                          <span className="diff-gutter new" role="cell">{newNo}</span>
                          <span className="diff-sigil" role="cell">{sigil}</span>
                          <span className="diff-text" role="cell">{l.text}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </section>
        );
      })}
    </div>
  );
}
