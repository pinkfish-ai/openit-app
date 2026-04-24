import { useEffect, useState } from "react";
import { fsRead } from "../lib/api";

export type ViewerSource =
  | { kind: "file"; path: string }
  | { kind: "deploy"; lines: string[] }
  | { kind: "diff"; text: string }
  | null;

export function Viewer({ source }: { source: ViewerSource }) {
  const [content, setContent] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    if (!source) {
      setContent("");
      return;
    }
    if (source.kind === "file") {
      let cancelled = false;
      fsRead(source.path)
        .then((c) => !cancelled && setContent(c))
        .catch((e) => !cancelled && setError(String(e)));
      return () => {
        cancelled = true;
      };
    }
    if (source.kind === "deploy") {
      setContent(source.lines.join("\n"));
      return;
    }
    if (source.kind === "diff") {
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

  return (
    <div className="viewer">
      <div className="viewer-header">{title}</div>
      <pre className="viewer-content">{content}</pre>
    </div>
  );
}
