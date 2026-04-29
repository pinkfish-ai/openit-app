import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import {
  agentTraceLatest,
  entityWriteFile,
  fsDelete,
  fsRead,
  gitCommitStaged,
  gitStage,
  gitStatusShort,
  stateLoad,
  type AppPersistedState,
  type SlackConfig,
  type SlackStatus,
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
  displayFilestoreName,
} from "../lib/filestoreSync";
import { pullDatastoresOnce } from "../lib/datastoreSync";
import { loadCreds } from "../lib/pinkfishAuth";
import { fsWatchStart, fsWatchStop, onFsChanged } from "../lib/fsWatcher";
import { startAutoCommitDriver, stopAutoCommitDriver } from "../lib/autoCommitDriver";
import { ChatPane } from "./ChatPane";
import { ChatShellHeader } from "./ChatShellHeader";
import { PaneDragHandle } from "./PaneDragHandle";
import { StatusBar } from "./StatusBar";
import { Workbench } from "./Workbench";
import { ConflictBanner } from "./ConflictBanner";
import { FileExplorer } from "./FileExplorer";
import { EscalatedTicketBanner } from "./EscalatedTicketBanner";
import { AgentActivityBanner } from "./AgentActivityBanner";
import { PromptBubbles, type Bubble } from "./PromptBubbles";
import { SourceControl } from "./SourceControl";
import { Viewer, type ViewerSource } from "./Viewer";
import { SkillCanvas } from "../SkillCanvas";
import type { SkillCanvasState as SkillCanvasStateType } from "../lib/skillCanvas";
import { resolvePathToSource } from "./entityRouting";

type LeftTab = "overview" | "files" | "source-control";

/// Stable id for each pane. Used to drive reordering — the user can
/// drag a pane's grip onto another pane and the layout state tracks
/// where each id lives. Insert-before semantics, like VS Code's tab
/// strip.
type PaneId = "left" | "center" | "right";
const DEFAULT_PANE_ORDER: PaneId[] = ["left", "center", "right"];
// Per-pane minimums (percentages). Tuned against the Tauri window
// minWidth of 1080px so even at the smallest allowed window each
// pane keeps room for its content:
//   left   22% of 1080 ≈ 238px — fits the 2-col Workbench stations
//   center 28% of 1080 ≈ 302px — keeps markdown / cards readable
//   right  26% of 1080 ≈ 281px — keeps the xterm legible
// Sum 76, leaving 24% slack for the user to redistribute.
const PANE_MIN: Record<PaneId, number> = { left: 22, center: 28, right: 26 };
const PANE_DEFAULT: Record<PaneId, number> = { left: 24, center: 40, right: 36 };

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
  intakeUrl,
  skillCanvasState,
  skillCanvasOrgId,
  onSkillCanvasClosed,
  slackConfig,
  slackStatus,
  orgName,
  onOpenPalette,
  onConnectSlack,
  registerManualPull,
  registerSwitchToSync,
  registerShowCloudCta,
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
  /** Current intake server URL (or null if not yet started). Substituted
   *  into `{{INTAKE_URL}}` placeholders in markdown content (e.g. the
   *  welcome doc). */
  intakeUrl: string | null;
  /** Active Skill Canvas state, if any. When non-null AND active, the
   *  center pane swaps from Viewer to SkillCanvas. App.tsx watches the
   *  state file under .openit/skill-state/<skill>.json and passes the
   *  current value here. */
  skillCanvasState: SkillCanvasStateType | null;
  /** Pinkfish orgId (or "" for local-only) — needed by skill-canvas
   *  actions that touch keychain (e.g. Slack token storage). */
  skillCanvasOrgId: string;
  /** Called when the canvas's dismiss button flips active=false; used to
   *  let App.tsx clear the watched state. */
  onSkillCanvasClosed: () => void;
  /** Slack config + status — surfaced in the bottom status bar. */
  slackConfig: SlackConfig | null;
  slackStatus: SlackStatus | null;
  /** Cloud org name — surfaced in the bottom status bar. */
  orgName: string | null;
  /** Open the cmd-K command palette. */
  onOpenPalette: () => void;
  /** Kick off the /connect-slack skill-canvas flow. App owns the
   *  scaffold-and-inject logic so the cmd-K palette and the bottom-
   *  bar Slack pill share one entry point. */
  onConnectSlack: () => void;
  /** Register the manual-pull handler so the command palette can call it. */
  registerManualPull: (fn: () => void) => void;
  /** Register the switch-to-sync-tab handler so the command palette can call it. */
  registerSwitchToSync: (fn: () => void) => void;
  /** Register the show-cloud-cta handler so the App header pill and the
   *  command palette can route a "Connect to Cloud" click into the CTA
   *  pitch page in the center pane (instead of jumping straight into
   *  the onboarding flow). */
  registerShowCloudCta: (fn: () => void) => void;
}) {
  const [state, setState] = useState<AppPersistedState | null>(null);
  const [source, setSource] = useState<ViewerSource>(null);
  const [conflictBubbles, setConflictBubbles] = useState<Bubble[]>([]);
  const [leftTab, setLeftTab] = useState<LeftTab>("overview");
  const [fsTick, setFsTick] = useState(0);
  const [changeCount, setChangeCount] = useState(0);
  const [pulling, setPulling] = useState(false);
  const [paneOrder, setPaneOrder] = useState<PaneId[]>(DEFAULT_PANE_ORDER);
  const [draggingPaneId, setDraggingPaneId] = useState<PaneId | null>(null);
  const [dragOverPaneId, setDragOverPaneId] = useState<PaneId | null>(null);
  const [chatSessionKey, setChatSessionKey] = useState(0);
  const [chatResume, setChatResume] = useState(false);
  const bumpFs = useCallback(() => setFsTick((t) => t + 1), []);

  /// Drag-source / drop-target wiring. The grip in each pane's header
  /// sets `draggingPaneId`; hovering another pane sets `dragOverPaneId`.
  /// On drop we splice the moving pane out of its slot and reinsert it
  /// at the target's slot. Position-aware: when dragging rightward we
  /// insert AFTER the target, when dragging leftward we insert BEFORE.
  /// This is the intuitive "drop the pane where I dropped it" behavior
  /// — without it, dragging chat from the leftmost slot onto the
  /// rightmost pane lands chat in the middle rather than the right
  /// (insert-before of the rightmost = middle), and dragging chat from
  /// the middle onto the rightmost is a no-op.
  const reorderPane = useCallback((movingId: PaneId, targetId: PaneId) => {
    if (movingId === targetId) return;
    setPaneOrder((prev) => {
      const movingIdx = prev.indexOf(movingId);
      const targetIdx = prev.indexOf(targetId);
      if (movingIdx < 0 || targetIdx < 0) return prev;
      const movingRightward = movingIdx < targetIdx;
      const without = prev.filter((id) => id !== movingId);
      const targetInWithout = without.indexOf(targetId);
      const insertAt = targetInWithout + (movingRightward ? 1 : 0);
      return [
        ...without.slice(0, insertAt),
        movingId,
        ...without.slice(insertAt),
      ];
    });
  }, []);

  const onPaneDragStart = useCallback(
    (paneId: PaneId, e: React.DragEvent) => {
      e.dataTransfer.setData("application/x-openit-pane", paneId);
      e.dataTransfer.effectAllowed = "move";
      setDraggingPaneId(paneId);
    },
    [],
  );

  const onPaneDragEnd = useCallback(() => {
    setDraggingPaneId(null);
    setDragOverPaneId(null);
  }, []);

  const onPaneDragOver = useCallback(
    (paneId: PaneId, e: React.DragEvent) => {
      // Only respond to our own MIME — won't interfere with the chat
      // pane's file-drop handlers which use x-openit-path / x-openit-ref.
      if (!e.dataTransfer.types.includes("application/x-openit-pane")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDragOverPaneId((prev) => (prev === paneId ? prev : paneId));
    },
    [],
  );

  const onPaneDragLeave = useCallback(
    (paneId: PaneId, e: React.DragEvent) => {
      // Filter child→child transitions (dragLeave fires on every
      // descendant boundary). Only clear when the drag is going to a
      // node OUTSIDE the current pane.
      const next = e.relatedTarget as Node | null;
      const current = e.currentTarget as Node;
      if (next && current.contains(next)) return;
      setDragOverPaneId((prev) => (prev === paneId ? null : prev));
    },
    [],
  );

  const onPaneDrop = useCallback(
    (paneId: PaneId, e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("application/x-openit-pane")) return;
      e.preventDefault();
      const fromId = e.dataTransfer.getData(
        "application/x-openit-pane",
      ) as PaneId;
      if (fromId && fromId !== paneId) reorderPane(fromId, paneId);
      setDraggingPaneId(null);
      setDragOverPaneId(null);
    },
    [reorderPane],
  );

  const newChatSession = useCallback(() => {
    setChatResume(false);
    setChatSessionKey((k) => k + 1);
  }, []);

  const resumeChatSession = useCallback(() => {
    setChatResume(true);
    setChatSessionKey((k) => k + 1);
  }, []);

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
          // Strip the `openit-` prefix for the user-facing line — internal
          // logs and error reports keep the canonical name.
          const displayName = displayFilestoreName(c.name);
          try {
            const r = await filestorePullOnce({ creds, repo, collection: c });
            onSyncLine(`  ✓ ${displayName} — ${r.downloaded}/${r.total} downloaded`);
          } catch (e) {
            console.error(`[manual pull] filestore (${c.name}) failed:`, e);
            onSyncLine(`  ✗ ${displayName} failed: ${String(e)}`);
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

  // Expose the manual-pull and tab-switch handlers up to App so the
  // command palette can call them. Re-register on every render so the
  // closure captures the current dependencies (cheap; React refs).
  useEffect(() => {
    registerManualPull(() => void handleManualPull());
  }, [registerManualPull, handleManualPull]);
  useEffect(() => {
    registerSwitchToSync(() => setLeftTab("source-control"));
  }, [registerSwitchToSync]);
  useEffect(() => {
    registerShowCloudCta(() => setSource({ kind: "cloud-cta" }));
  }, [registerShowCloudCta]);

  // Auto-open _welcome.md on first load — and re-open on demand
  // when the App-header "Getting Started" button dispatches the
  // `openit:open-welcome` custom event. Listening for the event here
  // (rather than plumbing a callback through props) keeps the
  // viewer-state ownership inside Shell.
  //
  // If the welcome is already the active source when the event fires,
  // we bump `welcomeFlashKey` instead of resolving again. The Viewer
  // observes this key and runs a brief yellow-flash animation, so the
  // user gets visual feedback that their click did something — without
  // it, clicking Getting Started while already on the welcome looked
  // like a no-op.
  const [welcomeFlashKey, setWelcomeFlashKey] = useState(0);
  useEffect(() => {
    if (!repo) return;
    const openWelcome = () => {
      // Already on the Getting Started page → flash the title to
      // confirm the click did something (re-setting the same source
      // wouldn't re-mount or animate anything on its own).
      if (source && source.kind === "getting-started") {
        setWelcomeFlashKey((k) => k + 1);
        return;
      }
      setSource({ kind: "getting-started" });
    };
    window.addEventListener("openit:open-welcome", openWelcome);
    return () => {
      window.removeEventListener("openit:open-welcome", openWelcome);
    };
  }, [repo, source]);

  // Re-resolve conversation views when the filesystem changes. The
  // conversations-list reads ticket files for subject/status (so a
  // ticket status flip from "incoming" → "open" should refresh the
  // pill). The conversation-thread view reads each message file (so
  // a new turn from Claude should append to the bubbles). Both are
  // computed at click time in entityRouting; without this effect they
  // stay frozen at the snapshot.
  // Stash `source` in a ref so the fs-tick re-resolver below can read
  // the current value without subscribing to it. Without this, every
  // re-resolve produces a new source object, the effect's `source` dep
  // re-fires, the resolver kicks off again — an infinite loop that
  // also raced with click-driven setSource calls and made viewer
  // updates feel flaky ("opens/closes but doesn't always show").
  const sourceRef = useRef<ViewerSource>(source);
  useEffect(() => {
    sourceRef.current = source;
  }, [source]);

  useEffect(() => {
    if (!repo || fsTick === 0) return;
    const current = sourceRef.current;
    if (!current) return;
    const isConversation =
      current.kind === "conversations-list" ||
      current.kind === "conversation-thread";
    const isEntityFolder = current.kind === "entity-folder";
    const isDatabasesList = current.kind === "databases-list";
    const isFilestoresList = current.kind === "filestores-list";
    const isAttachmentsFolder = current.kind === "attachments-folder";
    const isKnowledgeBasesList = current.kind === "knowledge-bases-list";
    if (
      !isConversation &&
      !isEntityFolder &&
      !isDatabasesList &&
      !isFilestoresList &&
      !isAttachmentsFolder &&
      !isKnowledgeBasesList
    )
      return;
    const path =
      current.kind === "conversations-list"
        ? `${repo}/databases/conversations`
        : current.kind === "conversation-thread"
          ? `${repo}/databases/conversations/${current.ticketId}`
          : current.kind === "entity-folder"
            // Source carries an explicit `path` post-2026-04-27 splits
            // (KB collections + filestores/library); fall back to the
            // entity name for built-ins that still match 1:1 (agents,
            // workflows).
            ? `${repo}/${current.path}`
            : current.kind === "databases-list"
              ? `${repo}/databases`
              : current.kind === "filestores-list"
                ? `${repo}/filestores`
                : current.kind === "attachments-folder"
                  ? `${repo}/filestores/attachments`
                  : current.kind === "knowledge-bases-list"
                    ? `${repo}/knowledge-bases`
                    : "";
    if (!path) return;
    let cancelled = false;
    resolvePathToSource(path, repo)
      .then((s) => {
        if (!cancelled) setSource(s);
      })
      .catch((e) => console.warn("[shell] re-resolve failed:", e));
    return () => {
      cancelled = true;
    };
  }, [fsTick, repo]);

  // Re-fetch the live agent trace whenever the fs watcher ticks. The
  // chat-intake server writes a partial trace file after each event
  // during the turn (see `LiveTracePersister` in `intake.rs`); this
  // effect pulls the latest snapshot in so the timeline animates
  // through the agent's actions instead of waiting for the turn to
  // finish.
  useEffect(() => {
    if (!repo || fsTick === 0) return;
    const current = sourceRef.current;
    if (!current || current.kind !== "agent-trace") return;
    const ticketId = current.ticketId;
    const subject = current.subject;
    let cancelled = false;
    agentTraceLatest(repo, ticketId)
      .then((doc) => {
        if (cancelled) return;
        // Only update if events actually changed — comparing
        // lengths is a cheap proxy that avoids re-rendering the
        // viewer for unrelated fs ticks (KB push, ticket status
        // flips, etc.) when the trace file itself hasn't grown.
        const currentLen = current.doc?.events.length ?? -1;
        const nextLen = doc?.events.length ?? -1;
        const outcomeChanged = (current.doc?.outcome ?? "") !== (doc?.outcome ?? "");
        if (currentLen === nextLen && !outcomeChanged) return;
        setSource({ kind: "agent-trace", ticketId, subject, doc });
      })
      .catch((e) => console.warn("[shell] agent-trace reload failed:", e));
    return () => {
      cancelled = true;
    };
  }, [fsTick, repo]);

  // First-load auto-open of the Getting Started page (only when
  // nothing else is loaded yet). React surface, no fs read.
  useEffect(() => {
    if (repo && !source) {
      setSource({ kind: "getting-started" });
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
        for (const p of [
          // 2026-04-27 plural rename: KB adapter prefix is now
          // `knowledge-bases/default`. Filestore split: prefix matches
          // what the adapter writes (`filestores/library`). Both
          // operational sub-collections (attachments under filestores,
          // user-created KBs) aren't sync-tracked in V1 and don't
          // generate conflicts.
          "knowledge-bases/default",
          "filestores/library",
          "datastore",
          "agent",
          "workflow",
        ]) {
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
        // Start the auto-commit driver alongside the watcher so any
        // write to `databases/{tickets,conversations,people}/` lands
        // in a commit regardless of who wrote it (chat-intake server,
        // admin Claude via /answer-ticket, manual edits). See the
        // module header for scope rationale.
        await startAutoCommitDriver(repo);
      } catch (e) {
        console.warn("[shell] fs watcher failed to start:", e);
      }
    })();

    return () => {
      unlisten?.();
      void stopAutoCommitDriver();
      fsWatchStop().catch(() => {});
    };
  }, [repo, bumpFs, onSyncLine]);

  if (!state) return <div className="shell-loading">Loading…</div>;

  return (
    <div className="shell">
      <ConflictBanner />
      <AgentActivityBanner
        repo={repo}
        fsTick={fsTick}
        onOpenTrace={async (ticketId, subject) => {
          if (!repo) return;
          try {
            const doc = await agentTraceLatest(repo, ticketId);
            // doc may be null when the click lands during the first
            // turn for a brand-new ticket (the trace file is written
            // only after the turn completes). Push the source anyway
            // — the viewer renders a "composing" placeholder and the
            // fs-watcher reload below swaps in the real doc once it
            // lands.
            setSource({ kind: "agent-trace", ticketId, subject, doc });
          } catch (e) {
            console.warn("[shell] agent-trace open failed:", e);
          }
        }}
      />
      <EscalatedTicketBanner
        repo={repo}
        fsTick={fsTick}
        onOpenPath={async (path) => {
          const resolved = await resolvePathToSource(path, repo);
          setSource(resolved);
        }}
      />
      {(() => {
        const paneClass = (id: PaneId) =>
          `${id === "left" ? "left-pane" : id === "center" ? "center-pane" : "right-pane"} ${
            draggingPaneId === id ? "pane-dragging" : ""
          } ${
            dragOverPaneId === id && draggingPaneId && draggingPaneId !== id
              ? "pane-drop-target"
              : ""
          }`;

        const paneContent: Record<PaneId, React.ReactNode> = {
          left: (
            <div
              className={paneClass("left")}
              onDragOver={(e) => onPaneDragOver("left", e)}
              onDragLeave={(e) => onPaneDragLeave("left", e)}
              onDrop={(e) => onPaneDrop("left", e)}
            >
              {/*
               * Left-pane tabs: Overview + Sync only.
               *
               * The Explorer tab was removed deliberately. The
               * canonical entry point to the raw file tree is the
               * "File explorer · advanced" link inside Workbench
               * (rendered in the Overview panel below). The
               * Overview tab stays "active" for both
               * leftTab="overview" and leftTab="files" so the
               * file-tree view doesn't orphan the tab strip.
               *
               * If you're about to add the Explorer tab back,
               * remove the Workbench link FIRST so we don't end
               * up with two competing entry points.
               */}
              <div className="left-tabs">
                <button
                  type="button"
                  className={`left-tab ${leftTab === "overview" || leftTab === "files" ? "active" : ""}`}
                  onClick={() => setLeftTab("overview")}
                >
                  Overview
                </button>
                <button
                  type="button"
                  className={`left-tab ${leftTab === "source-control" ? "active" : ""}`}
                  onClick={() => setLeftTab("source-control")}
                >
                  Sync
                  {changeCount > 0 && (
                    <span
                      className="left-tab-badge"
                      aria-label={`${changeCount} uncommitted change${changeCount === 1 ? "" : "s"}`}
                    >
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
              <div className="left-tab-panel" hidden={leftTab !== "overview"}>
                <div className="left-pane-scroll">
                  <Workbench
                    repo={repo}
                    fsTick={fsTick}
                    onOpen={async (path) => {
                      const resolved = await resolvePathToSource(path, repo);
                      setSource(resolved);
                    }}
                    onShowFiles={() => setLeftTab("files")}
                  />
                </div>
              </div>
              <div className="left-tab-panel" hidden={leftTab !== "files"}>
                <FileExplorer
                  repo={repo}
                  onSelect={async (path) => {
                    const resolved = await resolvePathToSource(path, repo, {
                      rawTickets: true,
                    });
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
                  onConnectRequest={() => setSource({ kind: "cloud-cta" })}
                />
              </div>
            </div>
          ),
          center: (
            <div
              className={paneClass("center")}
              onDragOver={(e) => onPaneDragOver("center", e)}
              onDragLeave={(e) => onPaneDragLeave("center", e)}
              onDrop={(e) => onPaneDrop("center", e)}
            >
              {/* Center pane has no drag handle — its only chrome
                  would be a stray strip floating in the cream gutter
                  above the viewer card. The left and right grips
                  reach all six permutations in ≤2 moves, so dropping
                  this is purely a visual cleanup. */}
              {skillCanvasState && skillCanvasState.active && repo && intakeUrl ? (
                <SkillCanvas
                  repo={repo}
                  orgId={skillCanvasOrgId}
                  intakeUrl={intakeUrl}
                  state={skillCanvasState}
                  onClosed={onSkillCanvasClosed}
                />
              ) : (
                <Viewer
                  source={source}
                  repo={repo ?? ""}
                  fsTick={fsTick}
                  intakeUrl={intakeUrl}
                  welcomeFlashKey={welcomeFlashKey}
                  onOpenPath={async (path) => {
                    const resolved = await resolvePathToSource(path, repo);
                    setSource(resolved);
                  }}
                  onConnectCloud={onConnectRequest}
                  onConnectSlack={onConnectSlack}
                />
              )}
            </div>
          ),
          right: (
            <div
              className={paneClass("right")}
              onDragOver={(e) => onPaneDragOver("right", e)}
              onDragLeave={(e) => onPaneDragLeave("right", e)}
              onDrop={(e) => onPaneDrop("right", e)}
            >
              <ChatShellHeader
                onNewSession={newChatSession}
                onResumeSession={resumeChatSession}
                dragHandle={
                  <PaneDragHandle
                    paneId="right"
                    onDragStart={onPaneDragStart}
                    onDragEnd={onPaneDragEnd}
                  />
                }
              />
              <div className="chat-area">
                <ChatPane key={chatSessionKey} cwd={repo} resume={chatResume} />
              </div>
              <PromptBubbles extraBubbles={conflictBubbles} bubbles={bubbles} />
            </div>
          ),
        };

        // No autoSaveId on the PanelGroup — persisted sizes are keyed
        // by Panel id, but when a pane swaps slots its old persisted
        // size is briefly re-applied at the new position before the
        // library reflows, producing a visible width jump on drop.
        // PANE_DEFAULT covers the common case; runtime resizes during
        // a session still work via the library's own state.
        return (
          <PanelGroup direction="horizontal">
            {paneOrder.map((id, idx) => (
              <Fragment key={id}>
                <Panel
                  id={id}
                  order={idx}
                  defaultSize={PANE_DEFAULT[id]}
                  minSize={PANE_MIN[id]}
                >
                  {paneContent[id]}
                </Panel>
                {idx < paneOrder.length - 1 && (
                  <PanelResizeHandle className="resize-handle" />
                )}
              </Fragment>
            ))}
          </PanelGroup>
        );
      })()}
      <StatusBar
        repo={repo}
        cloudConnected={cloudConnected}
        orgName={orgName}
        intakeUrl={intakeUrl}
        slackConfig={slackConfig}
        slackStatus={slackStatus}
        changeCount={changeCount}
        onOpenPalette={onOpenPalette}
        onConnectSlack={onConnectSlack}
      />
    </div>
  );
}
