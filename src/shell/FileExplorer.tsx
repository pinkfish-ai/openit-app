import { useEffect, useState } from "react";
import { fsList, type FileNode } from "../lib/api";

export function FileExplorer({
  repo,
  onSelect,
}: {
  repo: string | null;
  onSelect: (path: string) => void;
}) {
  const [nodes, setNodes] = useState<FileNode[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!repo) {
      setNodes([]);
      return;
    }
    let cancelled = false;
    fsList(repo)
      .then((n) => {
        if (!cancelled) {
          setNodes(n);
          setError(null);
        }
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [repo]);

  if (!repo) {
    return <div className="explorer empty">No repo open</div>;
  }
  if (error) {
    return <div className="explorer error">{error}</div>;
  }

  return (
    <div className="explorer">
      <div className="explorer-header">{repo.split("/").pop()}</div>
      <ul className="tree">
        {nodes.map((n) => {
          const depth = n.path.replace(repo, "").split("/").length - 1;
          return (
            <li
              key={n.path}
              className={n.is_dir ? "tree-item dir" : "tree-item file"}
              style={{ paddingLeft: 8 + depth * 12 }}
              onClick={() => !n.is_dir && onSelect(n.path)}
            >
              {n.is_dir ? "▸ " : ""}
              {n.name}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
