import { useEffect, useMemo, useState } from "react";
import { CATALOG, type CatalogEntry } from "../lib/cliCatalog";
import {
  installCli,
  listInstalled,
  removeHintOnly,
  requestInstallDebug,
  requestUninstallDebug,
  uninstallCli,
  UninstallError,
} from "../lib/cliInstall";
import styles from "./CliPanel.module.css";

/// CLI catalog rendered into the center pane via the `cli` entity
/// route. Programmatic install runs `brew install` directly (fast
/// happy path, deterministic UI state); on brew failure we surface the
/// captured stderr with an "Ask Claude to debug" button that hands
/// off to the agent with the actual error.

type CardStatus =
  | { kind: "idle" }
  | { kind: "busy"; verb: "install" | "uninstall" }
  | { kind: "failed"; verb: "install" | "uninstall"; stderr: string }
  | { kind: "handed-off" };

export function CliPanel({ projectRoot }: { projectRoot: string | null }) {
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [statuses, setStatuses] = useState<Record<string, CardStatus>>({});

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

  const setStatus = (id: string, status: CardStatus) =>
    setStatuses((prev) => ({ ...prev, [id]: status }));

  const onInstall = async (entry: CatalogEntry) => {
    if (!projectRoot) return;
    setStatus(entry.id, { kind: "busy", verb: "install" });
    try {
      await installCli(projectRoot, entry);
      setStatus(entry.id, { kind: "idle" });
      await refreshInstalled();
    } catch (e) {
      const stderr = e instanceof Error ? e.message : String(e);
      setStatus(entry.id, { kind: "failed", verb: "install", stderr });
    }
  };

  const onUninstall = async (entry: CatalogEntry) => {
    if (!projectRoot) return;
    const ok = window.confirm(
      `Uninstall ${entry.name}? This will run \`brew uninstall ${entry.brewPkg}\`.`,
    );
    if (!ok) return;
    setStatus(entry.id, { kind: "busy", verb: "uninstall" });
    try {
      await uninstallCli(projectRoot, entry);
      setStatus(entry.id, { kind: "idle" });
      await refreshInstalled();
    } catch (e) {
      // brew uninstall failed (probably not brew-managed). The
      // CLAUDE.md hint is already gone — refresh installed state and
      // surface the error with a debug-handoff button.
      const stderr = e instanceof UninstallError ? e.message : String(e);
      setStatus(entry.id, { kind: "failed", verb: "uninstall", stderr });
      await refreshInstalled();
    }
  };

  const onAskClaude = async (entry: CatalogEntry, status: CardStatus) => {
    if (status.kind !== "failed") return;
    const sent =
      status.verb === "install"
        ? await requestInstallDebug(entry, status.stderr)
        : await requestUninstallDebug(entry, status.stderr);
    if (!sent) {
      // No active Claude session; keep the failed state so the user
      // sees the error and can retry once Claude is up.
      return;
    }
    setStatus(entry.id, { kind: "handed-off" });
    setTimeout(() => {
      setStatuses((prev) => {
        if (prev[entry.id]?.kind !== "handed-off") return prev;
        const next = { ...prev };
        delete next[entry.id];
        return next;
      });
    }, 4000);
  };

  const onRemoveHintOnly = async (entry: CatalogEntry) => {
    if (!projectRoot) return;
    try {
      await removeHintOnly(projectRoot, entry);
      setStatus(entry.id, { kind: "idle" });
      await refreshInstalled();
    } catch (e) {
      const stderr = e instanceof Error ? e.message : String(e);
      setStatus(entry.id, { kind: "failed", verb: "uninstall", stderr });
    }
  };

  const onDismiss = (id: string) =>
    setStatuses((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });

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
        Install CLI tools so Claude can act on your IT systems via Bash. Brew
        runs the install; if it fails, hand the actual error to Claude and let
        it pick a fallback.
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
            status={statuses[entry.id] ?? { kind: "idle" }}
            onInstall={() => onInstall(entry)}
            onUninstall={() => onUninstall(entry)}
            onAskClaude={(s) => onAskClaude(entry, s)}
            onRemoveHintOnly={() => onRemoveHintOnly(entry)}
            onDismiss={() => onDismiss(entry.id)}
          />
        ))}
      </div>
    </div>
  );
}

function CliCard({
  entry,
  installed,
  status,
  onInstall,
  onUninstall,
  onAskClaude,
  onRemoveHintOnly,
  onDismiss,
}: {
  entry: CatalogEntry;
  installed: boolean;
  status: CardStatus;
  onInstall: () => void;
  onUninstall: () => void;
  onAskClaude: (s: CardStatus) => void;
  onRemoveHintOnly: () => void;
  onDismiss: () => void;
}) {
  const busy = status.kind === "busy";
  const handedOff = status.kind === "handed-off";

  let primaryLabel: string;
  let primaryHandler: () => void;
  let primaryDanger = false;
  if (handedOff) {
    primaryLabel = "Sent to Claude →";
    primaryHandler = () => {};
  } else if (busy) {
    primaryLabel = status.verb === "install" ? "Installing…" : "Uninstalling…";
    primaryHandler = () => {};
  } else if (installed) {
    primaryLabel = "Uninstall";
    primaryHandler = onUninstall;
    primaryDanger = true;
  } else {
    primaryLabel = "Install locally";
    primaryHandler = onInstall;
  }

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
          className={`${styles.btn} ${primaryDanger ? styles.btnDanger : styles.btnPrimary}`}
          onClick={primaryHandler}
          disabled={busy || handedOff}
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
      {status.kind === "failed" && (
        <div className={styles.error}>
          <span>
            {status.verb === "install"
              ? "Install failed."
              : "Uninstall failed (the CLAUDE.md hint was removed regardless)."}
          </span>
          <pre className={styles.errorStderr}>{status.stderr}</pre>
          <div className={styles.errorActions}>
            <button
              type="button"
              className={styles.errorRecovery}
              onClick={() => onAskClaude(status)}
            >
              Ask Claude to debug ↗
            </button>
            {status.verb === "uninstall" && (
              <button
                type="button"
                className={styles.errorRecovery}
                onClick={onRemoveHintOnly}
              >
                Just dismiss the hint
              </button>
            )}
            <button
              type="button"
              className={styles.errorDismiss}
              onClick={onDismiss}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
