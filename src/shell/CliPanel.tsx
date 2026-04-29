import { useEffect, useMemo, useState } from "react";
import { CATALOG, type CatalogEntry } from "../lib/cliCatalog";
import {
  getTargetOs,
  installCli,
  listInstalled,
  removeHintOnly,
  requestAgentInstall,
  requestAgentUninstall,
  uninstallCli,
  UninstallError,
  type TargetOs,
} from "../lib/cliInstall";
import styles from "./CliPanel.module.css";

/// CLI catalog rendered into the center pane via the `cli` entity
/// route.
///
/// **macOS:** programmatic `brew install` runs directly so the UI sees
/// deterministic state. On brew failure the inline error block surfaces
/// the captured stderr and offers an "Ask Claude to debug" handoff.
///
/// **Windows / Linux:** there's no programmatic happy path — too much
/// per-OS, per-tool variation to maintain. Click Install hands off to
/// Claude immediately with the target OS as context; the card flips to
/// "Sent to Claude →" and the user watches the agent work.

type CardStatus =
  | { kind: "idle" }
  | { kind: "busy"; verb: "install" | "uninstall" }
  | {
      kind: "failed";
      verb: "install" | "uninstall";
      stderr: string;
      claudeSessionMissing?: boolean;
    }
  | { kind: "handed-off" };

export function CliPanel({ projectRoot }: { projectRoot: string | null }) {
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [statuses, setStatuses] = useState<Record<string, CardStatus>>({});
  const [targetOs, setTargetOs] = useState<TargetOs | null>(null);

  const refreshInstalled = async () => {
    if (!projectRoot) return;
    try {
      setInstalled(await listInstalled());
    } catch (e) {
      console.error("[CliPanel] listInstalled failed:", e);
    }
  };

  useEffect(() => {
    void getTargetOs().then(setTargetOs);
  }, []);

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

  /// Fire the "Sent to Claude" feedback transient. After 4s the card
  /// drops back to its baseline state — the user's eye is in the chat
  /// watching Claude work, and the catalog will reflect reality on
  /// next `listInstalled` refresh.
  const flashHandedOff = (id: string) => {
    setStatus(id, { kind: "handed-off" });
    setTimeout(() => {
      setStatuses((prev) => {
        if (prev[id]?.kind !== "handed-off") return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }, 4000);
  };

  const onInstall = async (entry: CatalogEntry) => {
    if (!projectRoot || !targetOs) return;
    if (targetOs !== "macos") {
      // Non-mac: hand off to Claude immediately. No brew on this box.
      const sent = await requestAgentInstall(entry, {
        kind: "non-macos",
        targetOs,
      });
      if (!sent) {
        setStatus(entry.id, {
          kind: "failed",
          verb: "install",
          stderr: "No active Claude session.",
          claudeSessionMissing: true,
        });
        return;
      }
      flashHandedOff(entry.id);
      return;
    }

    // macOS happy path: programmatic brew install.
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
    if (!projectRoot || !targetOs) return;
    if (targetOs !== "macos") {
      const ok = window.confirm(
        `Hand off uninstall of ${entry.name} to Claude? It'll pick the right uninstall method for ${targetOs}.`,
      );
      if (!ok) return;
      const sent = await requestAgentUninstall(entry, {
        kind: "non-macos",
        targetOs,
      });
      if (!sent) {
        setStatus(entry.id, {
          kind: "failed",
          verb: "uninstall",
          stderr: "No active Claude session.",
          claudeSessionMissing: true,
        });
        return;
      }
      flashHandedOff(entry.id);
      return;
    }

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
      const stderr = e instanceof UninstallError ? e.message : String(e);
      setStatus(entry.id, { kind: "failed", verb: "uninstall", stderr });
      await refreshInstalled();
    }
  };

  const onAskClaude = async (entry: CatalogEntry, status: CardStatus) => {
    if (status.kind !== "failed") return;
    // Brew-failed handoff carries the captured stderr. Same agent
    // path as the non-mac install, different context.
    const sent =
      status.verb === "install"
        ? await requestAgentInstall(entry, {
            kind: "brew-failed",
            stderr: status.stderr,
          })
        : await requestAgentUninstall(entry, {
            kind: "brew-failed",
            stderr: status.stderr,
          });
    if (!sent) {
      setStatus(entry.id, { ...status, claudeSessionMissing: true });
      return;
    }
    flashHandedOff(entry.id);
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
        Install CLI tools so Claude can act on your IT systems via Bash.
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
            targetOs={targetOs}
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
  targetOs,
  onInstall,
  onUninstall,
  onAskClaude,
  onRemoveHintOnly,
  onDismiss,
}: {
  entry: CatalogEntry;
  installed: boolean;
  status: CardStatus;
  targetOs: TargetOs | null;
  onInstall: () => void;
  onUninstall: () => void;
  onAskClaude: (s: CardStatus) => void;
  onRemoveHintOnly: () => void;
  onDismiss: () => void;
}) {
  const busy = status.kind === "busy";
  const handedOff = status.kind === "handed-off";
  const isMac = targetOs === "macos";

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
    primaryLabel = isMac ? "Uninstall" : "Uninstall via Claude →";
    primaryHandler = onUninstall;
    primaryDanger = true;
  } else {
    primaryLabel = isMac ? "Install locally" : "Install via Claude →";
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
          disabled={busy || handedOff || targetOs === null}
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
            {status.verb === "install" ? "Install failed." : "Uninstall failed."}
          </span>
          <pre className={styles.errorStderr}>{status.stderr}</pre>
          {status.verb === "uninstall" && isMac && (
            <span className={styles.errorHelper}>
              The CLAUDE.md hint may still be present — use "Just dismiss the
              hint" if you want to clean it up without retrying brew.
            </span>
          )}
          {status.claudeSessionMissing && (
            <span className={styles.errorHelper}>
              No active Claude session — start Claude in the right pane and try
              "Ask Claude to debug" again.
            </span>
          )}
          <div className={styles.errorActions}>
            <button
              type="button"
              className={styles.errorRecovery}
              onClick={() => onAskClaude(status)}
            >
              Ask Claude to debug ↗
            </button>
            {status.verb === "uninstall" && isMac && (
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
