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
import { ChatPane } from "./ChatPane";
import { ConflictBanner } from "./ConflictBanner";
import { FileExplorer } from "./FileExplorer";
import { IncomingTicketBanner } from "./IncomingTicketBanner";
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
  cloudConnected,
  onConnectRequest,
}: {
  repo: string | null;
  syncLines: string[];
  onSyncLine: (line: string) => void;
  bubbles: Bubble[];
  /** Whether Pinkfish creds are loaded. Drives the Sync-to-Cloud button:
   *  push when true, CTA-to-connect when false. */
  cloudConnected: boolean;
  /** Called when the user wants to start the Pinkfish OAuth flow from
   *  inside the Sync tab (no creds + clicked Sync to Cloud). */
  onConnectRequest: () => void;
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
    } finally {
      setPulling(false);
    }
  }, [repo, pulling, bumpFs, onSyncLine]);

  useEffect(() => {
    stateLoad().then(setState).catch(console.error);
  }, []);

  // Auto-open _welcome.md on first load — and re-open on demand
  // when the App-header "Getting Started" button dispatches the
  // `openit:open-welcome` custom event. Listening for the event here
  // (rather than plumbing a callback through props) keeps the
  // viewer-state ownership inside Shell.
  useEffect(() => {
    if (!repo) return;
    const openWelcome = () => {
      const welcomePath = `${repo}/_welcome.md`;
      resolvePathToSource(welcomePath, repo)
        .then(setSource)
        .catch((e) => console.error("[shell] welcome resolution failed:", e));
    };
    window.addEventListener("openit:open-welcome", openWelcome);
    return () => {
      window.removeEventListener("openit:open-welcome", openWelcome);
    };
  }, [repo]);

  // Re-resolve conversation views when the filesystem changes. The
  // conversations-list reads ticket files for subject/status (so a
  // ticket status flip from "incoming" → "open" should refresh the
  // pill). The conversation-thread view reads each message file (so
  // a new turn from Claude should append to the bubbles). Both are
  // computed at click time in entityRouting; without this effect they
  // stay frozen at the snapshot.
  useEffect(() => {
    if (!repo || !source || fsTick === 0) return;
    const isConversation =
      source.kind === "conversations-list" ||
      source.kind === "conversation-thread";
    if (!isConversation) return;
    const path =
      source.kind === "conversations-list"
        ? `${repo}/databases/conversations`
        : `${repo}/databases/conversations/${source.ticketId}`;
    let cancelled = false;
    resolvePathToSource(path, repo)
      .then((s) => {
        if (!cancelled) setSource(s);
      })
      .catch((e) => console.warn("[shell] conversation re-resolve failed:", e));
    return () => {
      cancelled = true;
    };
  }, [fsTick, repo, source]);

  // First-load auto-open of welcome (only when nothing else is loaded yet).
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
        // Result-file `error` becomes the script's `error` field verbatim.
        // Keep it shaped as `{ code, message }` so callers can branch on
        // a stable code instead of grepping the message.
        let errorPayload: { code: string; message: string } | undefined;

        // Local-only short-circuit: no Pinkfish creds → there's nothing to
        // push. Write a structured `not_connected` result so sync-push.mjs
        // exits with a clear code Claude can see.
        const creds = await loadCreds().catch(() => null);
        if (!creds) {
          status = "error";
          errorPayload = {
            code: "not_connected",
            message:
              "OpenIT isn't connected to Pinkfish — local edits stay on disk only. Connect via the header pill to enable cloud sync.",
          };
          onLine(`✗ sync: ${errorPayload.message}`);
        } else {
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
            errorPayload = { code: "push_failed", message: String(e) };
            onLine(`✗ sync: push trigger failed: ${errorPayload.message}`);
          }
        }

        // Always write the result file when we got this far — we
        // claimed ownership of the marker and a script may be polling.
        const payload = JSON.stringify(
          { status, error: errorPayload, lines, finishedAt: new Date().toISOString() },
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
  }, [repo, bumpFs, onSyncLine]);

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
      <ConflictBanner />
      <IncomingTicketBanner repo={repo} fsTick={fsTick} />
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
                cloudConnected={cloudConnected}
                onConnectRequest={onConnectRequest}
              />
            </div>
          </div>
        </Panel>
        <PanelResizeHandle className="resize-handle" />
        <Panel defaultSize={sizes[1]} minSize={20}>
          <Viewer
            source={source}
            repo={repo ?? ""}
            fsTick={fsTick}
            onOpenPath={async (path) => {
              const resolved = await resolvePathToSource(path, repo);
              setSource(resolved);
            }}
          />
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
