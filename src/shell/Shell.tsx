import { useCallback, useEffect, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { stateLoad, stateSave, type AppPersistedState } from "../lib/api";
import { ChatPane } from "./ChatPane";
import { FileExplorer } from "./FileExplorer";
import { PromptBubbles } from "./PromptBubbles";
import { Viewer, type ViewerSource } from "./Viewer";

const DEFAULT_SIZES = [18, 42, 40];

export function Shell({ repo, deployLines }: { repo: string | null; deployLines: string[] }) {
  const [state, setState] = useState<AppPersistedState | null>(null);
  const [source, setSource] = useState<ViewerSource>(null);

  useEffect(() => {
    stateLoad().then(setState).catch(console.error);
  }, []);

  // When new deploy output arrives, route it into the viewer.
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
          <FileExplorer repo={repo} onSelect={(path) => setSource({ kind: "file", path })} />
        </Panel>
        <PanelResizeHandle className="resize-handle" />
        <Panel defaultSize={sizes[1]} minSize={20}>
          <Viewer source={source} />
        </Panel>
        <PanelResizeHandle className="resize-handle" />
        <Panel defaultSize={sizes[2]} minSize={25}>
          <div className="right-pane">
            <div className="chat-area">
              <ChatPane cwd={repo} />
            </div>
            <PromptBubbles />
          </div>
        </Panel>
      </PanelGroup>
    </div>
  );
}
