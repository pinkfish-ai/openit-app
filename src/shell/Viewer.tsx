import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { fsRead } from "../lib/api";

export type ViewerSource =
  | { kind: "file"; path: string }
  | { kind: "deploy"; lines: string[] }
  | { kind: "diff"; text: string }
  | null;

type ViewMode = "rendered" | "raw";

function isMarkdown(path: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(path);
}

export function Viewer({ source }: { source: ViewerSource }) {
  const [content, setContent] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ViewMode>("rendered");

  useEffect(() => {
    setError(null);
    if (!source) {
      setContent("");
      return;
    }
    if (source.kind === "file") {
      let cancelled = false;
      // Default to rendered when opening a new markdown file; raw for everything else.
      setMode(isMarkdown(source.path) ? "rendered" : "raw");
      fsRead(source.path)
        .then((c) => !cancelled && setContent(c))
        .catch((e) => !cancelled && setError(String(e)));
      return () => {
        cancelled = true;
      };
    }
    if (source.kind === "deploy") {
      setMode("raw");
      setContent(source.lines.join("\n"));
      return;
    }
    if (source.kind === "diff") {
      setMode("raw");
      setContent(source.text);
      return;
    }
  }, [source]);

  if (!source) {
    return <div className="viewer empty">Select a file from the explorer</div>;
  }
  if (error) {
    return <div className="viewer error">{error}</div>;
  }

  const title =
    source.kind === "file"
      ? source.path
      : source.kind === "deploy"
        ? "Deploy output"
        : "Git diff";

  const showTabs = source.kind === "file" && isMarkdown(source.path);

  return (
    <div className="viewer">
      <div className="viewer-header">
        <span className="viewer-title">{title}</span>
        {showTabs && (
          <div className="viewer-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={mode === "rendered"}
              className={`viewer-tab ${mode === "rendered" ? "active" : ""}`}
              onClick={() => setMode("rendered")}
            >
              Rendered
            </button>
            <button
              role="tab"
              aria-selected={mode === "raw"}
              className={`viewer-tab ${mode === "raw" ? "active" : ""}`}
              onClick={() => setMode("raw")}
            >
              Raw
            </button>
          </div>
        )}
      </div>
      {mode === "rendered" && showTabs ? (
        <div className="viewer-md">
          <ReactMarkdown>{content}</ReactMarkdown>
        </div>
      ) : (
        <pre className="viewer-content">{content}</pre>
      )}
    </div>
  );
}
