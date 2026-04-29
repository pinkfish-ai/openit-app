import { useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  CATALOG,
  PINKFISH_CONNECTIONS_URL,
  type CatalogEntry,
} from "../lib/cliCatalog";
import {
  installCli,
  listInstalled,
  removeHintOnly,
  uninstallCli,
  UninstallError,
} from "../lib/cliInstall";
import { requestSessionRestart } from "./activeSession";
import styles from "./ToolsPanel.module.css";

/// CLI-tools catalog rendered into the center pane via the Tools entity
/// route. Each card runs `brew install`/`brew uninstall` on click and
/// updates the project's CLAUDE.md so Claude knows the tool exists.
/// Detection of installed-vs-not is `which`-based, so tools the user
/// installed manually (or via prior brew) flip to "Installed" without
/// any tracking on our side.
export function ToolsPanel({ projectRoot }: { projectRoot: string | null }) {
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [errors, setErrors] = useState<
    Record<string, { msg: string; canRecover?: boolean }>
  >({});

  const refreshInstalled = async () => {
    if (!projectRoot) return;
    try {
      setInstalled(await listInstalled());
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

  const onInstall = async (entry: CatalogEntry) => {
    if (!projectRoot) return;
    setPendingId(entry.id);
    clearError(entry.id);
    try {
      await installCli(projectRoot, entry);
      requestSessionRestart();
      await refreshInstalled();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErrors((prev) => ({ ...prev, [entry.id]: { msg } }));
    } finally {
      setPendingId(null);
    }
  };

  const onUninstall = async (entry: CatalogEntry) => {
    if (!projectRoot) return;
    const ok = window.confirm(
      `Uninstall ${entry.name}? This will run \`brew uninstall ${entry.brewPkg}\` and restart your Claude session — any in-progress chat will be lost.`,
    );
    if (!ok) return;
    setPendingId(entry.id);
    clearError(entry.id);
    try {
      await uninstallCli(projectRoot, entry);
      requestSessionRestart();
      await refreshInstalled();
    } catch (e) {
      // brew uninstall failed (probably not brew-managed). The
      // CLAUDE.md hint is already gone — refresh + restart anyway,
      // but surface the error with a no-op-acknowledge button so the
      // user knows the binary is still on disk.
      const msg = e instanceof UninstallError ? e.message : String(e);
      setErrors((prev) => ({
        ...prev,
        [entry.id]: { msg, canRecover: true },
      }));
      requestSessionRestart();
      await refreshInstalled();
    } finally {
      setPendingId(null);
    }
  };

  const onRemoveHintOnly = async (entry: CatalogEntry) => {
    if (!projectRoot) return;
    setPendingId(entry.id);
    clearError(entry.id);
    try {
      await removeHintOnly(projectRoot, entry);
      requestSessionRestart();
      await refreshInstalled();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErrors((prev) => ({ ...prev, [entry.id]: { msg } }));
    } finally {
      setPendingId(null);
    }
  };

  const onPinkfishClick = (entry: CatalogEntry) => {
    openUrl(
      `${PINKFISH_CONNECTIONS_URL}?provider=${encodeURIComponent(entry.id)}`,
    ).catch(console.error);
  };

  const onMoreViaPinkfish = () => {
    openUrl(PINKFISH_CONNECTIONS_URL).catch(console.error);
  };

  if (!projectRoot) {
    return (
      <div className={styles.panel}>
        <p className={styles.empty}>
          Connect a project to install CLI tools.
        </p>
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      <h2 className={styles.heading}>Give your agent hands</h2>
      <p className={styles.tagline}>
        Install CLI tools so Claude can act on your IT systems via Bash. Zero
        token cost until used — installed tools surface in the project's
        <code> CLAUDE.md </code>so Claude knows when to reach for them.
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
            onRemoveHintOnly={() => onRemoveHintOnly(entry)}
          />
        ))}
        <button
          type="button"
          className={styles.pinkfishMore}
          onClick={onMoreViaPinkfish}
        >
          + 243 more via Pinkfish →
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
  onRemoveHintOnly,
}: {
  entry: CatalogEntry;
  installed: boolean;
  pending: boolean;
  error?: { msg: string; canRecover?: boolean };
  onInstall: () => void;
  onUninstall: () => void;
  onPinkfish: () => void;
  onRemoveHintOnly: () => void;
}) {
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
        <a
          className={styles.docsLink}
          href={entry.docsUrl}
          target="_blank"
          rel="noreferrer"
        >
          docs ↗
        </a>
      </div>
      {error && (
        <div className={styles.error}>
          <span>{error.msg}</span>
          {error.canRecover && (
            <button
              type="button"
              className={styles.errorRecovery}
              onClick={onRemoveHintOnly}
              disabled={pending}
            >
              Already removed — just dismiss the CLAUDE.md hint
            </button>
          )}
        </div>
      )}
    </div>
  );
}
