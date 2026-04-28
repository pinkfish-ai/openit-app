import { useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  CATALOG,
  PINKFISH_CONNECTIONS_URL,
  type CatalogEntry,
} from "../lib/mcpCatalog";
import { installServer, listInstalled, uninstallServer } from "../lib/mcpInstall";
import { requestSessionRestart } from "./activeSession";
import styles from "./ToolsPanel.module.css";

/// "Tools" left-pane tab. Lists the v1 MCP catalog with two CTAs per
/// card: install locally (one click — runs `claude mcp add`, restarts
/// Claude, auto-opens `/mcp` for the OAuth handshake) or connect through
/// Pinkfish (deep link). Installed entries float to the top with a green
/// dot. The "+ N more via Pinkfish" tile at the bottom is the breadth
/// pitch for the upsell.
export function ToolsPanel({ projectRoot }: { projectRoot: string | null }) {
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const refreshInstalled = async () => {
    if (!projectRoot) return;
    try {
      const ids = await listInstalled(projectRoot);
      setInstalled(ids);
    } catch (e) {
      console.error("[ToolsPanel] listInstalled failed:", e);
    }
  };

  useEffect(() => {
    refreshInstalled();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRoot]);

  const sortedFiltered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matched = q
      ? CATALOG.filter(
          (e) =>
            e.name.toLowerCase().includes(q) ||
            e.description.toLowerCase().includes(q),
        )
      : CATALOG;
    return [...matched].sort((a, b) => {
      const aIns = installed.has(a.id) ? 0 : 1;
      const bIns = installed.has(b.id) ? 0 : 1;
      return aIns - bIns;
    });
  }, [search, installed]);

  const onInstall = async (entry: CatalogEntry) => {
    if (!projectRoot) return;
    setPendingId(entry.id);
    setErrors((prev) => {
      const next = { ...prev };
      delete next[entry.id];
      return next;
    });
    try {
      await installServer(projectRoot, entry);
      // Restart the embedded Claude session and auto-open the /mcp
      // panel so the user lands directly on the OAuth Authenticate row.
      // PTY Enter is `\r` (carriage return), not `\n` — TUIs parse
      // keypresses and `\n` registers as a literal newline.
      requestSessionRestart("/mcp\r");
      await refreshInstalled();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErrors((prev) => ({ ...prev, [entry.id]: msg }));
    } finally {
      setPendingId(null);
    }
  };

  const onUninstall = async (entry: CatalogEntry) => {
    if (!projectRoot) return;
    const ok = window.confirm(
      `Uninstall ${entry.name}? This will restart your Claude session — any in-progress chat will be lost.`,
    );
    if (!ok) return;
    setPendingId(entry.id);
    setErrors((prev) => {
      const next = { ...prev };
      delete next[entry.id];
      return next;
    });
    try {
      await uninstallServer(projectRoot, entry);
      // Restart so Claude drops the removed server. No auto-`/mcp` —
      // the user removed it deliberately, no action expected next.
      requestSessionRestart();
      await refreshInstalled();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErrors((prev) => ({ ...prev, [entry.id]: msg }));
    } finally {
      setPendingId(null);
    }
  };

  const onPinkfishClick = (entry: CatalogEntry) => {
    const url = entry.pinkfishConnection
      ? `${PINKFISH_CONNECTIONS_URL}?provider=${encodeURIComponent(entry.pinkfishConnection)}`
      : PINKFISH_CONNECTIONS_URL;
    openUrl(url).catch(console.error);
  };

  const onMoreViaPinkfish = () => {
    openUrl(PINKFISH_CONNECTIONS_URL).catch(console.error);
  };

  if (!projectRoot) {
    return (
      <div className={styles.panel}>
        <p className={styles.empty}>
          Connect a project to install MCP tools.
        </p>
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      <h2 className={styles.heading}>Give your agent hands</h2>
      <p className={styles.tagline}>
        Install MCP servers so Claude can act on your IT systems without leaving
        OpenIT.
      </p>
      <input
        type="text"
        className={styles.search}
        placeholder="Search…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className={styles.grid}>
        {sortedFiltered.map((entry) => (
          <ToolCard
            key={entry.id}
            entry={entry}
            installed={installed.has(entry.id)}
            pending={pendingId === entry.id}
            error={errors[entry.id]}
            onInstall={() => onInstall(entry)}
            onUninstall={() => onUninstall(entry)}
            onPinkfish={() => onPinkfishClick(entry)}
          />
        ))}
        <button type="button" className={styles.pinkfishMore} onClick={onMoreViaPinkfish}>
          + 244 more via Pinkfish →
        </button>
      </div>
    </div>
  );
}

function ToolCard({
  entry,
  installed,
  pending,
  error,
  onInstall,
  onUninstall,
  onPinkfish,
}: {
  entry: CatalogEntry;
  installed: boolean;
  pending: boolean;
  error?: string;
  onInstall: () => void;
  onUninstall: () => void;
  onPinkfish: () => void;
}) {
  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <span className={styles.cardTitle}>
          {installed && <span className={styles.installedDot} aria-hidden />}
          {entry.name}
        </span>
        {installed && <span className={styles.installedPill}>Installed</span>}
      </div>
      <p className={styles.cardDesc}>{entry.description}</p>
      <div className={styles.cardActions}>
        {installed ? (
          <button
            type="button"
            className={`${styles.btn} ${styles.btnDanger}`}
            onClick={onUninstall}
            disabled={pending}
          >
            {pending ? "Uninstalling…" : "Uninstall"}
          </button>
        ) : (
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            onClick={onInstall}
            disabled={pending}
          >
            {pending ? "Installing…" : "Install locally"}
          </button>
        )}
        <button
          type="button"
          className={`${styles.btn} ${styles.btnSecondary}`}
          onClick={onPinkfish}
          title="15+ vetted tools, audit-ready policies"
        >
          Connect via Pinkfish
        </button>
      </div>
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
