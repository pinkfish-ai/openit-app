import { useCallback, useEffect, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { stateLoad, stateSave, type AppPersistedState } from "../lib/api";
import {
  buildKbConflictPrompt,
  getSyncStatus,
  kbHasServerShadowFiles,
  subscribeSync,
} from "../lib/kbSync";
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
  env,
  deployLines,
  onDeployLine,
  onDeployExit,
  bubbles,
}: {
  repo: string | null;
  env: string;
  deployLines: string[];
  onDeployLine: (line: string) => void;
  onDeployExit: (code: number | null) => void;
  bubbles: Bubble[];
}) {
  const [state, setState] = useState<AppPersistedState | null>(null);
  const [source, setSource] = useState<ViewerSource>(null);
  const [conflictBubbles, setConflictBubbles] = useState<Bubble[]>([]);
  const [leftTab, setLeftTab] = useState<LeftTab>("files");
  const [fsTick, setFsTick] = useState(0);
  const bumpFs = useCallback(() => setFsTick((t) => t + 1), []);

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
    if (deployLines.length > 0) setSource({ kind: "deploy", lines: deployLines });
  }, [deployLines]);

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
                Deploy
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
                env={env}
                onShowDiff={(text) => setSource({ kind: "diff", text })}
                onDeployLine={onDeployLine}
                onDeployExit={onDeployExit}
                onFsChange={bumpFs}
              />
            </div>
          </div>
        </Panel>
        <PanelResizeHandle className="resize-handle" />
        <Panel defaultSize={sizes[1]} minSize={20}>
          <Viewer source={source} />
        </Panel>
        <PanelResizeHandle className="resize-handle" />
        <Panel defaultSize={sizes[2]} minSize={25}>
          <div className="right-pane">
            <div className="right-toolbar" />
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
