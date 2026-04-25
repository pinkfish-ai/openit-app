import { useCallback, useEffect, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { stateLoad, stateSave, type AppPersistedState } from "../lib/api";
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
import { ChatPane } from "./ChatPane";
import { FileExplorer } from "./FileExplorer";
import { PromptBubbles, type Bubble } from "./PromptBubbles";
import { SourceControl } from "./SourceControl";
import { Viewer, type ViewerSource } from "./Viewer";
import { resolvePathToSource } from "./entityRouting";

const DEFAULT_SIZES = [18, 42, 40];

type LeftTab = "files" | "source-control";

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
  const bumpFs = useCallback(() => setFsTick((t) => t + 1), []);

  const handleManualPull = useCallback(async () => {
    if (!repo || pulling) return;
    setPulling(true);
    try {
      const creds = await loadCreds().catch(() => null);
      if (!creds) return;
      // Run all three pulls in parallel; each catches its own errors so a
      // single-entity failure doesn't block the others.
      const kbStatus = getSyncStatus();
      const tasks: Promise<unknown>[] = [];
      if (kbStatus.collection) {
        tasks.push(
          pullNow({ creds, repo, collection: kbStatus.collection }).catch((e) =>
            console.error("[manual pull] kb failed:", e),
          ),
        );
      }
      const fsCollections = getFilestoreSyncStatus().collections;
      for (const c of fsCollections) {
        tasks.push(
          filestorePullOnce({ creds, repo, collection: c }).catch((e) =>
            console.error(`[manual pull] filestore (${c.name}) failed:`, e),
          ),
        );
      }
      tasks.push(
        pullDatastoresOnce({ creds, repo }).catch((e) =>
          console.error("[manual pull] datastore failed:", e),
        ),
      );
      await Promise.all(tasks);
      bumpFs();
    } finally {
      setPulling(false);
    }
  }, [repo, pulling, bumpFs]);

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

  // Native filesystem watcher — emits fsTick bumps on real changes
  useEffect(() => {
    if (!repo) return;
    let unlisten: (() => void) | null = null;

    (async () => {
      try {
        await fsWatchStart(repo);
        unlisten = await onFsChanged((_paths) => {
          bumpFs();
        });
      } catch (e) {
        console.warn("[shell] fs watcher failed to start:", e);
      }
    })();

    return () => {
      unlisten?.();
      fsWatchStop().catch(() => {});
    };
  }, [repo, bumpFs]);

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
                Sync
                {changeCount > 0 && (
                  <span className="left-tab-badge" aria-label={`${changeCount} uncommitted change${changeCount === 1 ? "" : "s"}`}>
                    {changeCount}
                  </span>
                )}
              </button>
              <button
                type="button"
                className={`left-tab-pull-btn${pulling ? " is-pulling" : ""}`}
                onClick={handleManualPull}
                disabled={!repo || pulling}
                aria-label="Pull from Pinkfish now"
                title={pulling ? "Pulling…" : "Pull from Pinkfish"}
              >
                {pulling ? "⟳" : "↓"}
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
