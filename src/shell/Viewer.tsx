import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { fsRead, fsReadBytes, fsList } from "../lib/api";
import { loadCreds } from "../lib/pinkfishAuth";
import { fetchDatastoreItems } from "../lib/datastoreSync";
import type { MemoryItem } from "../lib/skillsApi";
import { DataTable } from "./DataTable";
import { ImageViewer } from "./viewers/ImageViewer";
import { PdfViewer } from "./viewers/PdfViewer";
import { SpreadsheetViewer } from "./viewers/SpreadsheetViewer";
import { OfficeViewer } from "./viewers/OfficeViewer";
import { writeToActiveSession } from "./activeSession";
import type { ViewerSource } from "./types";

export type { ViewerSource };

type ViewMode = "rendered" | "raw" | "table";

function isMarkdown(path: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(path);
}

function isImage(path: string): boolean {
  return /\.(jpg|jpeg|png|gif|webp)$/i.test(path);
}

function isPdf(path: string): boolean {
  return /\.pdf$/i.test(path);
}

function isSpreadsheet(path: string): boolean {
  return /\.(xlsx|csv)$/i.test(path);
}

function isOfficeDoc(path: string): boolean {
  return /\.(docx|pptx)$/i.test(path);
}

function mimeForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
  };
  return map[ext] ?? "application/octet-stream";
}

export function Viewer({ source, repo, fsTick }: { source: ViewerSource; repo: string; fsTick?: number }) {
  const [content, setContent] = useState<string>("");
  const [binaryData, setBinaryData] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ViewMode>("rendered");

  // Self-loaded table data for datastore-table
  const [tableItems, setTableItems] = useState<MemoryItem[]>([]);
  const [tableHasMore, setTableHasMore] = useState(false);
  const [tableLoading, setTableLoading] = useState(false);

  // Live override of the row content for datastore-row sources. Source
  // captures the row at click time; this gets populated when the
  // on-disk file changes (fsTick) so the table/raw view updates
  // without re-clicking.
  const [rowOverride, setRowOverride] = useState<MemoryItem | null>(null);
  // Reset on source change so a new click clears the previous override.
  useEffect(() => setRowOverride(null), [source]);

  useEffect(() => {
    setError(null);
    setBinaryData(null);
    if (!source) {
      setContent("");
      return;
    }
    if (source.kind === "file") {
      let cancelled = false;
      const path = source.path;

      if (isImage(path) || isPdf(path) || isSpreadsheet(path)) {
        setMode("rendered");
        fsReadBytes(path)
          .then((bytes) => !cancelled && setBinaryData(bytes))
          .catch((e) => !cancelled && setError(String(e)));
        return () => { cancelled = true; };
      }
      if (isOfficeDoc(path)) {
        setMode("rendered");
        setContent("");
        return;
      }
      setMode(isMarkdown(path) ? "rendered" : "raw");
      fsRead(path)
        .then((c) => !cancelled && setContent(c))
        .catch((e) => !cancelled && setError(String(e)));
      return () => { cancelled = true; };
    }
    if (source.kind === "sync") {
      setMode("raw");
      setContent(source.lines.join("\n"));
      return;
    }
    if (source.kind === "diff") {
      setMode("raw");
      setContent(source.text);
      return;
    }
    if (source.kind === "datastore-table") {
      setMode("table");
      setContent("");
      setTableItems(source.items ?? []);
      setTableHasMore(source.hasMore ?? false);
      // Only fetch from API if we have a real collection ID
      if (source.collection.id) {
        setTableLoading(true);
        let cancelled = false;
        loadCreds().then(async (creds) => {
          if (!creds || cancelled) { setTableLoading(false); return; }
          try {
            const resp = await fetchDatastoreItems(creds, source.collection.id, 100, 0);
            if (!cancelled) {
              setTableItems(resp.items);
              setTableHasMore(resp.pagination.hasNextPage);
            }
          } catch (e) {
            console.warn("[Viewer] failed to load table items:", e);
          } finally {
            if (!cancelled) setTableLoading(false);
          }
        });
        return () => { cancelled = true; };
      }
      return;
    }
    if (source.kind === "datastore-row") {
      // Default to the table-style key/value view — easier to read at a
      // glance than raw JSON. Users who want raw JSON can click the
      // Raw tab.
      setMode("table");
      const raw = source.item.content;
      if (raw == null) {
        setContent("{}");
      } else if (typeof raw === "object") {
        setContent(JSON.stringify(raw, null, 2));
      } else {
        try {
          setContent(JSON.stringify(JSON.parse(raw), null, 2));
        } catch {
          setContent(String(raw));
        }
      }
      return;
    }
    if (source.kind === "datastore-schema") {
      setMode("raw");
      setContent(JSON.stringify(source.collection.schema, null, 2));
      return;
    }
    if (source.kind === "agent") {
      setMode("rendered");
      setContent("");
      return;
    }
    if (source.kind === "workflow") {
      setMode("rendered");
      setContent("");
      return;
    }
  }, [source]);

  // Re-read the single-row file from disk when fsTick fires. Lets edits
  // by Claude (or any process touching the .json file) reflect in the
  // viewer without the user having to re-click the row.
  useEffect(() => {
    if (!source || source.kind !== "datastore-row" || !repo) return;
    if (fsTick === 0) return;
    const filePath = `${repo}/databases/${source.collection.name}/${source.item.key || source.item.id}.json`;
    let cancelled = false;
    (async () => {
      try {
        const raw = await fsRead(filePath);
        const parsed = JSON.parse(raw);
        if (cancelled) return;
        const merged: MemoryItem = {
          ...source.item,
          content: parsed,
        };
        setRowOverride(merged);
        // Also update raw-mode content so the Raw tab stays current.
        setContent(JSON.stringify(parsed, null, 2));
      } catch (e) {
        // File might have been deleted (server-delete propagated) —
        // leave the existing view rather than error.
        console.warn("[Viewer] row reload failed:", e);
      }
    })();
    return () => { cancelled = true; };
  }, [fsTick, source, repo]);

  // Re-read disk-based datastore tables when filesystem changes (fsTick from native watcher)
  useEffect(() => {
    if (!source || source.kind !== "datastore-table" || source.collection.id || !repo) return;
    // Skip the initial render (fsTick === 0 is handled by the source-loading effect above)
    if (fsTick === 0) return;
    const dirPath = `${repo}/databases/${source.collection.name}`;
    let cancelled = false;

    (async () => {
      try {
        const nodes = await fsList(dirPath);
        const items: MemoryItem[] = [];
        for (const node of nodes) {
          if (node.is_dir || node.name === "_schema.json") continue;
          // Skip conflict shadow files — they're a local-only artifact
          // (`<key>.server.json` written when both sides edit the same
          // row) and showing them as separate table rows misleads the
          // user into thinking the remote has two rows.
          if (node.name.includes(".server.")) continue;
          try {
            const raw = await fsRead(node.path);
            const content = JSON.parse(raw);
            const key = node.name.replace(/\.json$/, "");
            items.push({ id: key, key, content, createdAt: "", updatedAt: "" });
          } catch { /* skip unparseable */ }
        }
        if (!cancelled) setTableItems(items);
      } catch (e) {
        console.warn("[Viewer] fs change reload failed:", e);
      }
    })();

    return () => { cancelled = true; };
  }, [fsTick, source, repo]);

  if (!source) {
    return <div className="viewer empty">Select a file from the explorer</div>;
  }
  if (error) {
    return <div className="viewer error">{error}</div>;
  }

  // --- Title ---
  const getTitle = (): string => {
    switch (source.kind) {
      case "file": return source.path;
      case "sync": return "Sync output";
      case "diff": return "Git diff";
      case "datastore-table": return source.collection?.name ?? "Datastore";
      case "datastore-schema": return `${source.collection?.name ?? "Datastore"} — Schema`;
      case "datastore-row": return `${source.collection?.name ?? "Datastore"} / ${source.item?.key || source.item?.id || "Row"}`;
      case "agent": return source.agent?.name ?? "Agent";
      case "workflow": return source.workflow?.name ?? "Workflow";
      default: return "";
    }
  };
  const title = getTitle();

  // --- Tabs ---
  const showFileTabs = source.kind === "file" && isMarkdown(source.path);
  const showRowTabs = source.kind === "datastore-row";
  // The sync stream and the diff view are the two cases where the
  // user's natural next step is "paste this into Claude". A copy
  // button here saves a triple-click + ⌘C and avoids selection
  // accidentally truncating long output.
  const showCopy = source.kind === "sync" || source.kind === "diff";
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");
  const copyableText =
    source.kind === "sync"
      ? source.lines.join("\n")
      : source.kind === "diff"
      ? source.text
      : "";
  const handleCopy = async () => {
    if (!copyableText) return;
    try {
      await navigator.clipboard.writeText(copyableText);
      setCopyState("copied");
      setTimeout(() => setCopyState("idle"), 1500);
    } catch (e) {
      console.error("[viewer] clipboard write failed:", e);
    }
  };

  // --- Render body ---
  const renderBody = () => {
    // File viewers
    if (source.kind === "file") {
      if (isImage(source.path) && binaryData) {
        return <ImageViewer data={binaryData} mimeType={mimeForPath(source.path)} />;
      }
      if (isPdf(source.path) && binaryData) {
        return <PdfViewer data={binaryData} />;
      }
      if (isSpreadsheet(source.path) && binaryData) {
        return <SpreadsheetViewer data={binaryData} filename={source.path} />;
      }
      if (isOfficeDoc(source.path)) {
        return <OfficeViewer filename={source.path} />;
      }
      if (mode === "rendered" && isMarkdown(source.path)) {
        return (
          <div className="viewer-md">
            <ReactMarkdown>{content}</ReactMarkdown>
          </div>
        );
      }
      return <pre className="viewer-content">{content}</pre>;
    }

    // Datastore table view
    if (source.kind === "datastore-table") {
      if (tableLoading && tableItems.length === 0) {
        return <div className="viewer-content" style={{ opacity: 0.5 }}>Loading table data...</div>;
      }
      return (
        <DataTable
          collection={source.collection}
          items={tableItems}
          hasMore={tableHasMore}
          onLoadMore={async () => {
            const creds = await loadCreds();
            if (!creds) return;
            try {
              const resp = await fetchDatastoreItems(creds, source.collection.id, 100, tableItems.length);
              setTableItems((prev) => [...prev, ...resp.items]);
              setTableHasMore(resp.pagination.hasNextPage);
            } catch (e) {
              console.warn("[Viewer] load more failed:", e);
            }
          }}
          onRowClick={(key) => {
            const filePath = `${repo}/databases/${source.collection.name}/${key}.json`;
            writeToActiveSession(filePath + " ");
          }}
        />
      );
    }

    // Datastore row view
    if (source.kind === "datastore-row") {
      const liveItem = rowOverride ?? source.item;
      if (mode === "table") {
        return (
          <DataTable
            collection={source.collection}
            items={[liveItem]}
            onRowClick={(key) => {
              const filePath = `${repo}/databases/${source.collection.name}/${key}.json`;
              writeToActiveSession(filePath + " ");
            }}
          />
        );
      }
      return <pre className="viewer-content">{content}</pre>;
    }

    // Agent summary
    if (source.kind === "agent") {
      const a = source.agent;
      return (
        <div className="viewer-summary">
          <h2>{a.name}</h2>
          {a.description && <p className="summary-desc">{a.description}</p>}
          <div className="summary-section">
            <h3>Details</h3>
            <table className="summary-table">
              <tbody>
                {a.selectedModel && (
                  <tr><td>Model</td><td>{a.selectedModel}</td></tr>
                )}
                {a.isShared !== undefined && (
                  <tr><td>Shared</td><td>{a.isShared ? "Yes" : "No"}</td></tr>
                )}
                <tr><td>ID</td><td><code>{a.id}</code></td></tr>
              </tbody>
            </table>
          </div>
          {a.instructions && (
            <div className="summary-section">
              <h3>Instructions</h3>
              <div className="viewer-md">
                <ReactMarkdown>{a.instructions}</ReactMarkdown>
              </div>
            </div>
          )}
        </div>
      );
    }

    // Workflow summary
    if (source.kind === "workflow") {
      const w = source.workflow;
      return (
        <div className="viewer-summary">
          <h2>{w.name}</h2>
          {w.description && <p className="summary-desc">{w.description}</p>}
          {w.inputs && w.inputs.length > 0 && (
            <div className="summary-section">
              <h3>Inputs</h3>
              <table className="summary-table">
                <thead>
                  <tr><th>Name</th><th>Type</th><th>Required</th></tr>
                </thead>
                <tbody>
                  {w.inputs.map((inp, i) => (
                    <tr key={i}>
                      <td>{inp.name}</td>
                      <td><code>{inp.type}</code></td>
                      <td>{inp.required ? "Yes" : "No"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {w.triggers && w.triggers.length > 0 && (
            <div className="summary-section">
              <h3>Triggers</h3>
              <ul>
                {w.triggers.map((t, i) => (
                  <li key={i}>
                    {t.name}
                    {t.url && <code className="trigger-url">{t.url}</code>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="summary-section">
            <h3>Details</h3>
            <table className="summary-table">
              <tbody>
                <tr><td>ID</td><td><code>{w.id}</code></td></tr>
              </tbody>
            </table>
          </div>
        </div>
      );
    }

    // Deploy / diff
    return <pre className="viewer-content">{content}</pre>;
  };

  return (
    <div className="viewer">
      <div className="viewer-header">
        <span className="viewer-title">{title}</span>
        {showFileTabs && (
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
        {showRowTabs && (
          <div className="viewer-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={mode === "raw"}
              className={`viewer-tab ${mode === "raw" ? "active" : ""}`}
              onClick={() => setMode("raw")}
            >
              Raw
            </button>
            <button
              role="tab"
              aria-selected={mode === "table"}
              className={`viewer-tab ${mode === "table" ? "active" : ""}`}
              onClick={() => setMode("table")}
            >
              Table
            </button>
          </div>
        )}
        {showCopy && (
          <button
            type="button"
            className="viewer-copy-btn"
            onClick={handleCopy}
            title="Copy contents to clipboard"
          >
            {copyState === "copied" ? "Copied!" : "Copy"}
          </button>
        )}
      </div>
      {renderBody()}
    </div>
  );
}
