import { useCallback, useEffect, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import {
  entityWriteFile,
  fsDelete,
  fsRead,
  gitCommitStaged,
  gitStage,
  gitStatusShort,
  stateLoad,
  stateSave,
  type AppPersistedState,
} from "../lib/api";
import { pushAllEntities } from "../lib/pushAll";
import { clearConflictsForPrefix } from "../lib/syncEngine";
import {
  buildKbConflictPrompt,
  getSyncStatus,
  kbHasServerShadowFiles,
  pullNow,
  subscribeSync,
} from "../lib/kbSync";
import {
  getFilestoreSyncStatus,
  pullOnce as filestorePullOnce,
} from "../lib/filestoreSync";
import { pullDatastoresOnce } from "../lib/datastoreSync";
import { loadCreds } from "../lib/pinkfishAuth";
import { fsWatchStart, fsWatchStop, onFsChanged } from "../lib/fsWatcher";
import { refreshEscalatedTickets } from "../lib/ticketStatus";
import { ChatPane } from "./ChatPane";
import { ConflictBanner } from "./ConflictBanner";
import { EscalatedTicketBanner } from "./EscalatedTicketBanner";
import { FileExplorer } from "./FileExplorer";
import { PromptBubbles, type Bubble } from "./PromptBubbles";
import { SourceControl } from "./SourceControl";
import { Viewer, type ViewerSource } from "./Viewer";
import { resolvePathToSource } from "./entityRouting";

const DEFAULT_SIZES = [18, 42, 40];

type LeftTab = "files" | "source-control";

/// Module-level reentrancy guard for Claude-triggered pushes. Hoisted
/// out of the useEffect closure so a transient cleanup race (effect
/// re-runs faster than the async fs-watcher subscription tears down)
/// can't end up with two listeners that each have their own
/// `pushInFlight` flag — without this, a single push-request marker
/// fanned out into 3 parallel push runs in the wild.
const pushInFlightByRepo = new Set<string>();

export function Shell({
  repo,
  syncLines,
  onSyncLine,
  bubbles,
}: {
  repo: string | null;
  syncLines: string[];
  onSyncLine: (line: string) => void;
  bubbles: Bubble[];
}) {
  const [state, setState] = useState<AppPersistedState | null>(null);
  const [source, setSource] = useState<ViewerSource>(null);
  const [conflictBubbles, setConflictBubbles] = useState<Bubble[]>([]);
  const [leftTab, setLeftTab] = useState<LeftTab>("files");
  const [fsTick, setFsTick] = useState(0);
  const [changeCount, setChangeCount] = useState(0);
  const [pulling, setPulling] = useState(false);
  /// Bumped on user-initiated refreshes (manual pull, after-Claude-push)
  /// so the ConflictBanner clears any stale dismiss state. Without this,
  /// dismissing once + the engine re-emitting the same conflict on a
  /// subsequent pull would leave the banner permanently hidden.
  const [refreshTick, setRefreshTick] = useState(0);
  const bumpFs = useCallback(() => setFsTick((t) => t + 1), []);
  const bumpRefresh = useCallback(() => setRefreshTick((t) => t + 1), []);

  const handleManualPull = useCallback(async () => {
    if (!repo || pulling) return;
    setPulling(true);
    onSyncLine("─── manual pull ───");
    try {
      const creds = await loadCreds().catch(() => null);
      if (!creds) {
        onSyncLine("✗ pull: not authenticated");
        return;
      }

      // Run pulls SEQUENTIALLY, not in parallel — each pull's auto-commit
      // takes the .git/index.lock briefly, and concurrent commits race on
      // that lock. Losing the race surfaces as a warning + uncommitted
      // pulled files showing up in the Deploy tab. Sequencing is fine
      // perf-wise (each pull is ~hundreds of ms; user-facing) and aligns
      // the streaming output too.

      // KB pull
      const kbStatus = getSyncStatus();
      if (kbStatus.collection) {
        onSyncLine("▸ pull: kb");
        try {
          await pullNow({ creds, repo, collection: kbStatus.collection });
          onSyncLine("  ✓ kb pull complete");
        } catch (e) {
          console.error("[manual pull] kb failed:", e);
          onSyncLine(`  ✗ kb pull failed: ${String(e)}`);
        }
      } else {
        onSyncLine("▸ pull: kb skipped (no collection)");
      }

      // Filestore pull
      const fsCollections = getFilestoreSyncStatus().collections;
      if (fsCollections.length === 0) {
        onSyncLine("▸ pull: filestore skipped (no collections)");
      } else {
        onSyncLine(`▸ pull: filestore (${fsCollections.length} collection${fsCollections.length === 1 ? "" : "s"})`);
        for (const c of fsCollections) {
          try {
            const r = await filestorePullOnce({ creds, repo, collection: c });
            onSyncLine(`  ✓ ${c.name} — ${r.downloaded}/${r.total} downloaded`);
          } catch (e) {
            console.error(`[manual pull] filestore (${c.name}) failed:`, e);
            onSyncLine(`  ✗ ${c.name} failed: ${String(e)}`);
          }
        }
      }

      // Datastore pull
      onSyncLine("▸ pull: datastores");
      try {
        const r = await pullDatastoresOnce({ creds, repo });
        onSyncLine(
          `  ✓ datastore pull complete — ${r.pulled} row(s) updated, ${r.conflicts.length} conflict${r.conflicts.length === 1 ? "" : "s"}`,
        );
        for (const c of r.conflicts) {
          onSyncLine(`    ⚠ conflict: ${c.collectionName}/${c.key}.json — ${c.reason}`);
        }
      } catch (e) {
        console.error("[manual pull] datastore failed:", e);
        onSyncLine(`  ✗ datastore pull failed: ${String(e)}`);
      }

      onSyncLine("─── pull done ───");
      bumpFs();
      bumpRefresh();
    } finally {
      setPulling(false);
    }
  }, [repo, pulling, bumpFs, bumpRefresh, onSyncLine]);

  useEffect(() => {
    stateLoad().then(setState).catch(console.error);
  }, []);

  // Auto-open _welcome.md on first load
  useEffect(() => {
    if (repo && !source) {
      const welcomePath = `${repo}/_welcome.md`;
      console.log("[shell] opening welcome on first load:", welcomePath);
      resolvePathToSource(welcomePath, repo)
        .then((s) => {
          console.log("[shell] welcome resolved:", s);
          setSource(s);
        })
        .catch((e) => {
          console.error("[shell] welcome resolution failed:", e);
        });
    }
  }, [repo, source]);

  // Re-classify escalated tickets on fs-tick. Cheap on small ticket
  // sets; the helper bails early if databases/ doesn't exist yet.
  useEffect(() => {
    if (!repo) {
      void refreshEscalatedTickets("");
      return;
    }
    void refreshEscalatedTickets(repo);
  }, [repo, fsTick]);

  useEffect(() => {
    if (!repo) {
      setConflictBubbles([]);
      return;
    }
    const refresh = async () => {
      const hasShadow = await kbHasServerShadowFiles(repo);
      const sync = getSyncStatus();
      if (sync.conflicts.length > 0 || hasShadow) {
        const prompt = await buildKbConflictPrompt(repo);
        if (prompt) {
          setConflictBubbles([{ label: "Resolve merge conflicts", prompt, variant: "conflict" }]);
          return;
        }
      }
      setConflictBubbles([]);
    };
    void refresh();
    return subscribeSync(() => {
      void refresh();
    });
  }, [repo]);

  useEffect(() => {
    if (syncLines.length > 0) setSource({ kind: "sync", lines: syncLines });
  }, [syncLines]);

  // Native filesystem watcher — emits fsTick bumps on real changes,
  // and acts as the trigger for `.openit/push-request.json` (the file
  // `scripts/openit-plugin/sync-push.mjs` writes when Claude wants to
  // push). When it appears, run pushAllEntities and write
  // `.openit/push-result.json` so the script's poll loop can exit.
  useEffect(() => {
    if (!repo) return;
    let unlisten: (() => void) | null = null;

    const runPushFromMarker = async () => {
      // Module-level guard so concurrent listeners (transient
      // useEffect cleanup race) can't each kick off a separate push.
      if (pushInFlightByRepo.has(repo)) return;
      pushInFlightByRepo.add(repo);
      try {
        const requestPath = `${repo}/.openit/push-request.json`;

        // Confirm the marker actually exists. If not, this fs event
        // came from something else (the script's own cleanup, a stale
        // event from a prior run, etc.) — bail without writing a
        // result file. Writing one regardless would let a *concurrent*
        // sync-push.mjs poll loop read it and report success even
        // though no push ran, leaving its real request marker
        // stranded on disk.
        try {
          await fsRead(requestPath);
        } catch {
          return;
        }

        // We own this push. Delete the marker first so a watcher
        // event for the deletion itself doesn't loop us.
        try {
          await fsDelete(requestPath);
        } catch (e) {
          console.warn("[shell] failed to delete push-request:", e);
        }

        // Clear the conflict aggregate immediately so the banner
        // disappears as soon as the user confirms the sync. The push
        // pre-pulls each entity inside pushAllEntities — if a true
        // remote-side conflict still exists after the merge, that pull
        // will repopulate the aggregate. So clearing optimistically is
        // safe and gives the snappy "banner gone now" UX the user
        // expected.
        for (const p of ["kb", "filestore", "datastore", "agent", "workflow"]) {
          clearConflictsForPrefix(p);
        }
        onSyncLine("─── push triggered by Claude ───");

        const lines: string[] = [];
        const onLine = (line: string) => {
          lines.push(line);
          onSyncLine(line);
        };
        let status: "ok" | "error" = "ok";
        let errorMsg: string | undefined;

        try {
          // Auto-commit any pending working-tree changes BEFORE pushing.
          // After Claude's merge, disk has the merged content but git
          // HEAD still has the pre-merge content, so `git status` reports
          // a pending change. If the user picked remote, local now
          // matches remote and the push reports `0 ok, 0 failed` — the
          // user is left staring at "1 change to push" forever. Commit
          // here so HEAD catches up. Same pattern handleCommit uses.
          try {
            const wsStatus = await gitStatusShort(repo);
            if (wsStatus.length > 0) {
              const unstaged = wsStatus.filter((f) => !f.staged).map((f) => f.path);
              if (unstaged.length > 0) await gitStage(repo, unstaged);
              const ts = new Date().toISOString();
              await gitCommitStaged(repo, `sync: claude-resolve auto-commit @ ${ts}`);
              onLine("▸ sync: auto-committed merged files");
            }
          } catch (e) {
            console.warn("[shell] auto-commit before push failed:", e);
          }

          await pushAllEntities(repo, onLine);
        } catch (e) {
          status = "error";
          errorMsg = String(e);
          onLine(`✗ sync: push trigger failed: ${errorMsg}`);
        }

        // Final aggregate clear after the push completes. The pre-push
        // pull inside pushAllEntities updated the aggregate based on
        // pre-push state — but the push itself may have resolved
        // server-side divergence (e.g., uploaded the user's merged
        // content), and the next 60s poll will repopulate the
        // aggregate accurately if anything is genuinely still
        // conflicted. Clearing here prevents a stale "still conflicted"
        // banner from showing on a row we just pushed.
        if (status === "ok") {
          for (const p of ["kb", "filestore", "datastore", "agent", "workflow"]) {
            clearConflictsForPrefix(p);
          }
          bumpRefresh();
        }

        // Always write the result file when we got this far — we
        // claimed ownership of the marker and a script may be polling.
        const payload = JSON.stringify(
          { status, error: errorMsg, lines, finishedAt: new Date().toISOString() },
          null,
          2,
        );
        try {
          await entityWriteFile(repo, ".openit", "push-result.json", payload);
        } catch (e) {
          console.error("[shell] failed to write push-result:", e);
        }
      } finally {
        pushInFlightByRepo.delete(repo);
      }
    };

    (async () => {
      try {
        await fsWatchStart(repo);
        unlisten = await onFsChanged((paths) => {
          bumpFs();
          // Look for the push-request marker in the change set. The
          // watcher is recursive over the repo root, so paths here are
          // absolute. Match either the absolute or repo-relative form.
          const marker = ".openit/push-request.json";
          const hit = paths.some(
            (p) => p.endsWith(`/${marker}`) || p.endsWith(marker),
          );
          if (hit) void runPushFromMarker();
        });
      } catch (e) {
        console.warn("[shell] fs watcher failed to start:", e);
      }
    })();

    return () => {
      unlisten?.();
      fsWatchStop().catch(() => {});
    };
  }, [repo, bumpFs, bumpRefresh, onSyncLine]);

  const persist = useCallback(
    (patch: Partial<AppPersistedState>) => {
      const next: AppPersistedState = {
        last_repo: null,
        pane_sizes: null,
        pinned_bubbles: null,
        onboarding_complete: false,
        ...(state ?? {}),
        ...patch,
      };
      setState(next);
      stateSave(next).catch(console.error);
    },
    [state],
  );

  if (!state) return <div className="shell-loading">Loading…</div>;

  const sizes = state.pane_sizes ?? DEFAULT_SIZES;

  return (
    <div className="shell">
      <ConflictBanner refreshTick={refreshTick} />
      <EscalatedTicketBanner refreshTick={refreshTick} />
      <PanelGroup
        direction="horizontal"
        autoSaveId="openit-shell"
        onLayout={(s: number[]) => persist({ pane_sizes: s })}
      >
        <Panel defaultSize={sizes[0]} minSize={12}>
          <div className="left-pane">
            <div className="left-tabs">
              <button
                type="button"
                className={`left-tab ${leftTab === "files" ? "active" : ""}`}
                onClick={() => setLeftTab("files")}
              >
                Explorer
              </button>
              <button
                type="button"
                className={`left-tab ${leftTab === "source-control" ? "active" : ""}`}
                onClick={() => setLeftTab("source-control")}
              >
                Deploy
                {changeCount > 0 && (
                  <span className="left-tab-badge" aria-label={`${changeCount} uncommitted change${changeCount === 1 ? "" : "s"}`}>
                    {changeCount}
                  </span>
                )}
              </button>
              <button
                type="button"
                className="left-tab-pull-btn"
                onClick={handleManualPull}
                disabled={!repo || pulling}
                aria-label="Pull from Pinkfish now"
                title={pulling ? "Pulling…" : "Pull from Pinkfish"}
              >
                <span className={`left-tab-pull-glyph${pulling ? " is-pulling" : ""}`}>↻</span>
              </button>
            </div>
            {/* Keep both panels mounted so typed-but-uncommitted state
                (e.g. the commit message) survives tab switches. */}
            <div className="left-tab-panel" hidden={leftTab !== "files"}>
              <FileExplorer
                repo={repo}
                onSelect={async (path) => {
                  const resolved = await resolvePathToSource(path, repo);
                  setSource(resolved);
                }}
                fsTick={fsTick}
                onFsChange={bumpFs}
              />
            </div>
            <div className="left-tab-panel" hidden={leftTab !== "source-control"}>
              <SourceControl
                repo={repo}
                active={leftTab === "source-control"}
                onShowDiff={(text) => setSource({ kind: "diff", text })}
                onSyncLine={onSyncLine}
                onFsChange={bumpFs}
                onChangeCount={setChangeCount}
              />
            </div>
          </div>
        </Panel>
        <PanelResizeHandle className="resize-handle" />
        <Panel defaultSize={sizes[1]} minSize={20}>
          <Viewer source={source} repo={repo ?? ""} fsTick={fsTick} />
        </Panel>
        <PanelResizeHandle className="resize-handle" />
        <Panel defaultSize={sizes[2]} minSize={25}>
          <div className="right-pane">
            <div className="chat-area">
              <ChatPane cwd={repo} />
            </div>
            <PromptBubbles extraBubbles={conflictBubbles} bubbles={bubbles} />
          </div>
        </Panel>
      </PanelGroup>
    </div>
  );
}
