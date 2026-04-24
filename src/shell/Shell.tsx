import { useCallback, useEffect, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { stateLoad, stateSave, type AppPersistedState } from "../lib/api";
import { ChatPane } from "./ChatPane";
import { DeployButton } from "./DeployButton";
import { FileExplorer } from "./FileExplorer";
import { PromptBubbles } from "./PromptBubbles";
import { VersionsDrawer } from "./VersionsDrawer";
import { Viewer, type ViewerSource } from "./Viewer";

const DEFAULT_SIZES = [18, 42, 40];

export function Shell() {
  const [state, setState] = useState<AppPersistedState | null>(null);
  const [source, setSource] = useState<ViewerSource>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [env, setEnv] = useState<"dev" | "prod">("dev");
  const [, setDeployLines] = useState<string[]>([]);

  useEffect(() => {
    stateLoad().then(setState).catch(console.error);
  }, []);

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

  const repo = state.last_repo;
  const sizes = state.pane_sizes ?? DEFAULT_SIZES;

  const onDeployLine = (line: string) =>
    setDeployLines((prev) => {
      const next = [...prev, line];
      setSource({ kind: "deploy", lines: next });
      return next;
    });

  return (
    <div className="shell">
      <PanelGroup
        direction="horizontal"
        autoSaveId="openit-shell"
        onLayout={(s: number[]) => persist({ pane_sizes: s })}
      >
        <Panel defaultSize={sizes[0]} minSize={12}>
          <FileExplorer repo={repo} onSelect={(path) => setSource({ kind: "file", path })} />
        </Panel>
        <PanelResizeHandle className="resize-handle" />
        <Panel defaultSize={sizes[1]} minSize={20}>
          <Viewer source={source} />
        </Panel>
        <PanelResizeHandle className="resize-handle" />
        <Panel defaultSize={sizes[2]} minSize={25}>
          <div className="right-pane">
            <div className="right-toolbar">
              <button
                className="icon-btn"
                onClick={() => setVersionsOpen((v) => !v)}
                title="Show version history"
              >
                Versions
              </button>
              <select
                value={env}
                onChange={(e) => setEnv(e.target.value as "dev" | "prod")}
                className="env-select"
              >
                <option value="dev">dev</option>
                <option value="prod">prod</option>
              </select>
              <DeployButton
                repo={repo}
                env={env}
                onLine={onDeployLine}
                onExit={(code) => onDeployLine(`▸ exit ${code ?? "?"}`)}
              />
            </div>
            <div className="chat-area">
              <ChatPane />
            </div>
            <PromptBubbles />
          </div>
        </Panel>
      </PanelGroup>
      <VersionsDrawer
        repo={repo}
        open={versionsOpen}
        onClose={() => setVersionsOpen(false)}
        onShowDiff={(text) => {
          setSource({ kind: "diff", text });
          setVersionsOpen(false);
        }}
      />
    </div>
  );
}
