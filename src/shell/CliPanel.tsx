import { useEffect, useMemo, useState } from "react";
import { CATALOG, type CatalogEntry } from "../lib/cliCatalog";
import {
  listInstalled,
  requestCliInstall,
  requestCliUninstall,
} from "../lib/cliInstall";
import styles from "./CliPanel.module.css";

/// CLI catalog rendered into the center pane via the `cli` entity
/// route. Click Install / Uninstall hands the request off to Claude in
/// the embedded session — Claude runs brew (or vendor fallback), debugs
/// failures, and edits CLAUDE.md per the marker convention. The card's
/// installed state comes from `which` detection so it reflects what's
/// actually on the machine, regardless of how it got there.
export function CliPanel({ projectRoot }: { projectRoot: string | null }) {
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [requestedId, setRequestedId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const refreshInstalled = async () => {
    if (!projectRoot) return;
    try {
      setInstalled(await listInstalled());
    } catch (e) {
      console.error("[CliPanel] listInstalled failed:", e);
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
            e.description.toLowerCase().includes(q) ||
            e.binary.toLowerCase().includes(q),
        )
      : CATALOG;
    return [...matched].sort((a, b) => {
      const aIns = installed.has(a.id) ? 0 : 1;
      const bIns = installed.has(b.id) ? 0 : 1;
      return aIns - bIns;
    });
  }, [search, installed]);

  const clearError = (id: string) =>
    setErrors((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });

  const flashRequested = (id: string) => {
    setRequestedId(id);
    // Brief feedback then clear — the actual install happens in the
    // chat, the user's eye should follow Claude there. Catalog
    // refreshes installed state when the panel is reopened.
    setTimeout(() => setRequestedId((curr) => (curr === id ? null : curr)), 4000);
  };

  const onInstall = async (entry: CatalogEntry) => {
    clearError(entry.id);
    const ok = await requestCliInstall(entry);
    if (!ok) {
      setErrors((prev) => ({
        ...prev,
        [entry.id]: "No active Claude session — start Claude in the right pane first.",
      }));
      return;
    }
    flashRequested(entry.id);
  };

  const onUninstall = async (entry: CatalogEntry) => {
    const ok = window.confirm(
      `Hand off uninstall of ${entry.name} to Claude? Claude will run \`brew uninstall ${entry.brewPkg}\` and remove the CLAUDE.md hint.`,
    );
    if (!ok) return;
    clearError(entry.id);
    const sent = await requestCliUninstall(entry);
    if (!sent) {
      setErrors((prev) => ({
        ...prev,
        [entry.id]: "No active Claude session — start Claude in the right pane first.",
      }));
      return;
    }
    flashRequested(entry.id);
  };

  if (!projectRoot) {
    return (
      <div className={styles.panel}>
        <p className={styles.empty}>Connect a project to install CLI tools.</p>
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      <h2 className={styles.heading}>Give your agent hands</h2>
      <p className={styles.tagline}>
        Install CLI tools so Claude can act on your IT systems via Bash. Click
        Install and Claude handles the rest in the chat — running brew, picking
        a fallback if needed, and updating <code>CLAUDE.md</code> so it knows the
        tool is available.
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
          <CliCard
            key={entry.id}
            entry={entry}
            installed={installed.has(entry.id)}
            requested={requestedId === entry.id}
            error={errors[entry.id]}
            onInstall={() => onInstall(entry)}
            onUninstall={() => onUninstall(entry)}
          />
        ))}
      </div>
    </div>
  );
}

function CliCard({
  entry,
  installed,
  requested,
  error,
  onInstall,
  onUninstall,
}: {
  entry: CatalogEntry;
  installed: boolean;
  requested: boolean;
  error?: string;
  onInstall: () => void;
  onUninstall: () => void;
}) {
  const primaryLabel = installed
    ? requested
      ? "Sent to Claude →"
      : "Uninstall"
    : requested
      ? "Sent to Claude →"
      : "Install locally";
  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <span className={styles.cardTitle}>
          {installed && <span className={styles.installedDot} aria-hidden />}
          {entry.name}
          <span className={styles.cardBinary}>{entry.binary}</span>
        </span>
        {installed && <span className={styles.installedPill}>Installed</span>}
      </div>
      <p className={styles.cardDesc}>{entry.description}</p>
      <div className={styles.cardActions}>
        <button
          type="button"
          className={`${styles.btn} ${installed ? styles.btnDanger : styles.btnPrimary}`}
          onClick={installed ? onUninstall : onInstall}
          disabled={requested}
        >
          {primaryLabel}
        </button>
        <a
          className={styles.docsLink}
          href={entry.docsUrl}
          target="_blank"
          rel="noreferrer"
        >
          docs ↗
        </a>
      </div>
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
