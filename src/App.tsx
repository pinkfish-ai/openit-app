import { useCallback, useEffect, useRef, useState } from "react";
import { Onboarding } from "./Onboarding";
import { Shell } from "./shell/Shell";
import { CommandPalette } from "./shell/CommandPalette";
import {
  fsRead,
  intakeStart,
  projectBootstrap,
  projectBindToCloud,
  projectGetCloudBinding,
  slackConfigRead,
  slackListenerStart,
  slackListenerStatus,
  slackListenerStop,
  stateLoad,
  stateSave,
  type SlackConfig,
  type SlackStatus,
} from "./lib/api";
import {
  type SkillCanvasState,
  injectIntoChat,
  mergeSkillState,
  skillStateRead,
  skillStateWrite,
} from "./lib/skillCanvas";
import { buildManageState, buildSetupState } from "./lib/connectSlackState";
import { onFsChanged } from "./lib/fsWatcher";
import { clearCreds, loadCreds, startAuth, subscribeToken, type PinkfishCreds } from "./lib/pinkfishAuth";
import { useBrowserConnect } from "./lib/useBrowserConnect";
import { startKbSync, stopKbSync } from "./lib/kbSync";
import { startFilestoreSync, stopFilestoreSync } from "./lib/filestoreSync";
import { startDatastoreSync, stopDatastoreSync } from "./lib/datastoreSync";
import { startAgentSync, stopAgentSync } from "./lib/agentSync";
import { startWorkflowSync, stopWorkflowSync } from "./lib/workflowSync";
import { syncSkillsToDisk, readSyncedPluginVersion, type Bubble as ManifestBubble } from "./lib/skillsSync";
import { applySeedBeforeCloudConnect, applySeedLocalOnly } from "./lib/seedDriver";
import { useOnceEffect } from "./lib/useOnceEffect";
import { invoke } from "@tauri-apps/api/core";
import { type Bubble as PromptBubble } from "./shell/PromptBubbles";
import "./App.css";

const DEFAULT_BUBBLES: PromptBubble[] = [
  { label: "Reports", prompt: "/reports weekly-digest" },
  { label: "Access", prompt: "/access map" },
  { label: "People", prompt: "/people" },
];

// Default project identity when running local-only (no Pinkfish creds).
// Folder lands at `~/OpenIT/local/`. Stable across launches so the same
// local helpdesk is reopened on relaunch. If the user later connects to
// Pinkfish, that opens a separate folder keyed by the cloud orgId; the
// two are disjoint until Phase 6 designs a migration.
const LOCAL_ORG_ID = "local";
const LOCAL_ORG_NAME = "OpenIT (local)";

// `VITE_DEV_LOCAL_ONLY=true` (the local-only escape hatch) is honored
// inside `loadCreds()` — every caller (this file, Shell.tsx push
// handler, sync engines) sees the flag take effect uniformly.

function basename(p: string): string {
  const parts = p.split("/").filter((s) => s.length > 0);
  return parts[parts.length - 1] ?? p;
}

/// Is the bundled plugin already synced at the *current* manifest version?
/// Returns true when both (a) the triage-agent install sentinel exists
/// (so we know a sync ran successfully at some point) AND (b) the
/// version sentinel matches the bundled manifest's version (so we know
/// the on-disk files reflect the current build, not an older one).
///
/// Falsely returning true would skip syncing newly-added manifest files
/// onto existing projects (which is exactly what happened when reports
/// shipped — the script never reached `.claude/scripts/`). Falsely
/// returning false re-runs the sync, which is idempotent on the .claude/
/// scaffolding and a no-op commit on the rest, so it's the safer error.
///
/// Why two sentinels rather than one: the triage file lives outside
/// .claude/ (user-editable). Deleting it as the version cue would
/// destroy admin edits. The plugin-version sentinel inside .openit/ is
/// owned exclusively by the sync.
async function bundledPluginIsCurrent(repo: string): Promise<boolean> {
  const slug = basename(repo);
  try {
    await fsRead(`${repo}/agents/openit-triage-${slug}.json`);
  } catch {
    return false;
  }
  try {
    const bundledManifestJson = await invoke<string>("skills_fetch_bundled_manifest");
    const bundledVersion = (JSON.parse(bundledManifestJson) as { version?: string }).version;
    if (!bundledVersion) return true; // no version field → can't tell, treat as current
    const onDisk = await readSyncedPluginVersion(repo);
    return onDisk === bundledVersion;
  } catch (e) {
    console.warn("[app] plugin-version probe failed:", e);
    return true; // err on the side of not re-syncing
  }
}

function convertBubblesForPrompt(manifestBubbles: ManifestBubble[]): PromptBubble[] {
  return manifestBubbles.map((b) => ({
    label: b.label,
    prompt: b.skill,
  }));
}

/// Fan out the cloud sync engines for a connected project. Centralized so
/// the relaunch + fresh-bootstrap paths can't drift on which engines they
/// start. Each engine swallows its own init error so one failure doesn't
/// take down the others.
function startCloudSyncs(creds: PinkfishCreds, repo: string, _orgName: string): void {
  startKbSync({ creds, repo }).catch((e) =>
    console.error("kb sync init failed:", e),
  );
  startFilestoreSync({ creds, repo }).catch((e) =>
    console.error("filestore sync init failed:", e),
  );
  startDatastoreSync({ creds, repo }).catch((e) =>
    console.error("datastore sync init failed:", e),
  );
  startAgentSync({ creds, repo }).catch((e) =>
    console.error("agent sync init failed:", e),
  );
  startWorkflowSync({ creds, repo }).catch((e) =>
    console.error("workflow sync init failed:", e),
  );
}

function App() {
  const [repo, setRepo] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [syncLines, setSyncLines] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [orgName, setOrgName] = useState<string | null>(null);
  const [savedCreds, setSavedCreds] = useState<PinkfishCreds | null>(null);
  const [bypassOnboarding, setBypassOnboarding] = useState(false);
  const [bubbles, setBubbles] = useState<PromptBubble[]>(DEFAULT_BUBBLES);
  const [intakeServerUrl, setIntakeServerUrl] = useState<string | null>(null);
  const [slackConfig, setSlackConfig] = useState<SlackConfig | null>(null);
  const [slackStatus, setSlackStatus] = useState<SlackStatus | null>(null);
  const [skillCanvasState, setSkillCanvasState] = useState<SkillCanvasState | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const manualPullRef = useRef<(() => void) | null>(null);
  const switchToSyncRef = useRef<(() => void) | null>(null);
  const showCloudCtaRef = useRef<(() => void) | null>(null);

  // Single-source-of-truth handler for "kick off the Slack flow":
  //   1. scaffold the connect-slack skill canvas state (setup or
  //      manage defaults, merged with anything already on disk),
  //   2. inject /connect-slack into Claude.
  // Used by the cmd-K palette AND the bottom-bar Slack pill so both
  // surfaces behave identically. Also handles the no-canvas-prereq
  // guard (needs repo + intake server up).
  const triggerSlackFlow = useCallback(async () => {
    if (!repo || !intakeServerUrl) return;
    try {
      const defaults = slackConfig
        ? buildManageState(slackConfig)
        : buildSetupState();
      // Only merge with existing canvas state when slack.json actually
      // exists on disk. Without that guard, a half-finished prior run
      // (e.g. user marked verify as "completed" but slack.json was
      // later deleted) replays stale "completed" checks on top of
      // setup state — confusing because the user reads it as "I'm
      // already connected" when they aren't. When slackConfig is null
      // we know the connection is gone, so reset the canvas to a
      // clean setup view.
      const next =
        slackConfig
          ? mergeSkillState(
              (await skillStateRead(repo, "connect-slack")) ?? defaults,
              defaults,
            )
          : defaults;
      await skillStateWrite(repo, "connect-slack", next);
    } catch (e) {
      console.warn("[app] slack canvas scaffold failed:", e);
    }
    injectIntoChat("/connect-slack").catch((e) =>
      console.warn("[app] inject /connect-slack failed:", e),
    );
  }, [repo, intakeServerUrl, slackConfig]);

  // Global cmd-K / ctrl-K listener — opens the command palette from
  // anywhere in the app. We use a window listener (not document
  // capture) so xterm's own input still works; we just preventDefault
  // when the chord matches so the terminal doesn't see the K.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isCmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
      if (isCmdK) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (e.key === "Escape" && paletteOpen) {
        setPaletteOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paletteOpen]);

  // Active skill canvas — currently we only support one canvas at a
  // time (V1), and the only canvas-driven skill is connect-slack.
  // Watch its state file under .openit/skill-state/connect-slack.json
  // and re-render whenever it changes. The skill is the orchestrator
  // (writes state); React is the renderer (this state read fans out
  // through Shell → SkillCanvas).
  const ACTIVE_CANVAS_SKILL = "connect-slack";
  useEffect(() => {
    if (!repo) {
      setSkillCanvasState(null);
      return;
    }
    let mounted = true;
    const refresh = () =>
      skillStateRead(repo, ACTIVE_CANVAS_SKILL)
        .then((s) => {
          if (mounted) setSkillCanvasState(s);
        })
        .catch((e) => console.warn("[app] skill state read failed:", e));
    refresh();
    let unlistenFn: (() => void) | null = null;
    onFsChanged((paths) => {
      // Cheap match — re-read whenever any path under
      // .openit/skill-state/ changes. Worst case: spurious read.
      if (paths.some((p) => p.includes("/.openit/skill-state/"))) {
        refresh();
      }
    })
      .then((un) => {
        if (mounted) unlistenFn = un;
        else un();
      })
      .catch((e) => console.warn("[app] skill state watcher init failed:", e));
    return () => {
      mounted = false;
      unlistenFn?.();
    };
  }, [repo]);

  // Slack lifecycle:
  //
  //   1. On project open (repo set), read .openit/slack.json. If
  //      present, auto-start the listener as soon as the intake
  //      server URL is also known. Both are required because the
  //      listener needs OPENIT_INTAKE_URL.
  //   2. While a project is open, poll status every 5s so the
  //      header pill flips between running/stopped without user
  //      action. Cheap call — just reads supervisor state.
  //   3. On project switch / null repo: stop the listener and clear
  //      state. The supervisor's stop is idempotent (safe to call
  //      when nothing's running), so no need to gate on
  //      slackStatus?.running.
  const slackOrgId = savedCreds?.orgId ?? "";
  useEffect(() => {
    if (!repo) {
      setSlackConfig(null);
      setSlackStatus(null);
      // Best-effort: stop a listener that might still be pointed at
      // the previous project. Errors are fine to ignore — if there
      // was nothing running, stop is a no-op.
      slackListenerStop().catch(() => {});
      return;
    }
    let mounted = true;
    slackConfigRead(repo)
      .then((cfg) => {
        if (!mounted) return;
        setSlackConfig(cfg);
      })
      .catch((e) => {
        console.warn("[app] slack config read failed:", e);
      });
    const refreshStatus = () =>
      slackListenerStatus()
        .then((s) => {
          if (mounted) setSlackStatus(s);
        })
        .catch(() => {});
    refreshStatus();
    const id = setInterval(refreshStatus, 5_000);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, [repo]);

  // Auto-start: when both repo and intakeServerUrl are known and a
  // slack config exists, start the listener — exactly ONCE per
  // (repo, intakeUrl) pair. We deliberately do NOT re-fire when
  // the supervisor flips back to stopped: a listener that crashes
  // because of a bad token would thrash-restart every 5s. After
  // an unexpected exit, the user clicks the Slack pill to re-run
  // /connect-slack; the canvas surfaces the captured exit error
  // and offers a Start button via the verify-dm action.
  const slackAutoStartedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!repo || !intakeServerUrl || !slackConfig) return;
    const key = `${repo}|${intakeServerUrl}`;
    if (slackAutoStartedRef.current === key) return;
    slackAutoStartedRef.current = key;
    let cancelled = false;
    (async () => {
      try {
        await slackListenerStart({
          repo,
          intakeUrl: intakeServerUrl,
          orgId: slackOrgId,
        });
        if (!cancelled) {
          // Re-read status immediately so the pill flips green
          // without waiting for the 5s interval tick.
          slackListenerStatus()
            .then((s) => setSlackStatus(s))
            .catch(() => {});
        }
      } catch (e) {
        console.warn("[app] slack listener auto-start failed:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repo, intakeServerUrl, slackConfig, slackOrgId]);

  useEffect(() => {
    // Stop the WebView from navigating to a dropped file when the drop
    // happens outside our explicit handlers. Without this, dragging an
    // image anywhere in the window replaces the whole page with the
    // file preview.
    const stopDefault = (e: Event) => e.preventDefault();
    window.addEventListener("dragover", stopDefault);
    window.addEventListener("drop", stopDefault);
    return () => {
      window.removeEventListener("dragover", stopDefault);
      window.removeEventListener("drop", stopDefault);
    };
  }, []);

  // Welcome doc's "Connect to Cloud" markdown link dispatches this
  // event (Viewer.tsx::ExternalAnchor). Route through the same
  // connected-vs-CTA gate the header pill uses so all four entry
  // points behave identically.
  useEffect(() => {
    const onShowCta = () => {
      if (connected) setBypassOnboarding(false);
      else showCloudCtaRef.current?.();
    };
    window.addEventListener("openit:show-cloud-cta", onShowCta);
    return () => window.removeEventListener("openit:show-cloud-cta", onShowCta);
  }, [connected]);

  // Bootstrap is intentionally non-idempotent (creates cloud
  // collections, starts engines, writes seed). StrictMode would run it
  // twice and the parallel customCreate calls would each create their
  // own openit-tickets/openit-people. `useOnceEffect` guards that.
  useOnceEffect(() => {
    Promise.all([stateLoad(), startAuth(), loadCreds()])
      .then(async ([s, _token, creds]) => {
        // Repos created before we moved out of ~/Documents are stale — TCC blocks
        // fs/git ops there. Discard so we re-bootstrap into the new ~/OpenIT/ root.
        const stale = s.last_repo?.includes("/Documents/OpenIT/") ?? false;
        const lastRepo = stale ? null : s.last_repo;
        if (stale) {
          console.log("[app] discarding legacy ~/Documents/OpenIT/ last_repo — connect via modal to bootstrap into ~/OpenIT/");
        }
        console.log("[app] startup state:", {
          hasRepo: !!lastRepo,
          hasCreds: !!creds,
          orgId: creds?.orgId,
          localOnly: !creds,
        });
        setRepo(lastRepo);
        setSavedCreds(creds);

        const finish = () => setLoaded(true);

        // V1 fall-through flag. Set when the cloud-relaunch branch enters
        // (creds + lastRepo) but the cloud.json marker is missing or
        // points at a different org — typical V1 legacy state where
        // `lastRepo = ~/OpenIT/<oldOrgId>/`. Without this flag, the
        // first-run-with-creds branch's `!lastRepo || stale` condition
        // is false (lastRepo is truthy, stale is false), and execution
        // falls past every branch into a half-loaded state with no repo
        // set and no syncs started.
        let cloudRelaunchFellThrough = false;

        if (creds && lastRepo) {
          // Cloud-connected relaunch — skip onboarding and resume syncs.
          //
          // Phase 1 of V2 sync (PIN-5775): the bound folder is now
          // identified by `.openit/cloud.json`, not by the old
          // `~/OpenIT/<orgId>/` folder convention. Read the marker. If
          // it matches the saved creds, run idempotent layout
          // maintenance on `~/OpenIT/local/` (the canonical bound
          // folder for new bindings) and resume syncs against
          // `lastRepo`. If the marker is missing (V1 legacy folder) or
          // points at a different org, fall through to the
          // first-run-with-creds branch which re-binds against
          // `~/OpenIT/local/`.
          const binding = await projectGetCloudBinding(lastRepo).catch(() => null);
          if (binding && binding.orgId === creds.orgId) {
            try {
              await projectBootstrap({ orgName: LOCAL_ORG_NAME, orgId: LOCAL_ORG_ID });
            } catch (e) {
              console.warn("[app] cloud-relaunch bootstrap failed (non-fatal):", e);
            }
            setBypassOnboarding(true);
            // Fall back to creds.orgId when orgName is empty — the
            // first-run-with-creds path doesn't have a display name
            // available (no modal), so it stores `""`. Better to show
            // the orgId in the UI than nothing until the user reconnects
            // through the modal (which provides a real display name).
            // Seed BEFORE engines so customCreate (datastoreSync's
            // import-csv path) has rows to upload when it fires.
            await applySeedBeforeCloudConnect(lastRepo, creds);
            startCloudSyncs(creds, lastRepo, binding.orgName || creds.orgId);
            finish();
            return;
          }
          cloudRelaunchFellThrough = true;
          console.log(
            "[app] lastRepo has no matching cloud.json — re-binding via first-run-with-creds branch",
          );
        }

        if (creds && (!lastRepo || stale || cloudRelaunchFellThrough)) {
          // First run with dev creds (or stale legacy lastRepo discarded
          // above). Land in `~/OpenIT/local/`, write the cloud.json
          // marker, then start syncs. Phase 1 deliberately drops the
          // old `~/OpenIT/<orgId>/` folder — the user's existing data
          // (if any) is preserved on disk but no longer auto-opened.
          try {
            console.log("[app] bootstrap on startup with dev creds");
            const result = await projectBootstrap({
              orgName: LOCAL_ORG_NAME,
              orgId: LOCAL_ORG_ID,
            });
            try {
              // No display name available in this code path (no modal
              // gave us one). Store empty string; cloud-relaunch falls
              // back to orgId when reading. The next time the user
              // connects via the modal, `incoming` will overwrite this
              // with the real display name (same-org rebind branch in
              // project_bind_to_cloud preserves connectedAt + updates
              // orgName).
              await projectBindToCloud({
                repo: result.path,
                orgId: creds.orgId,
                orgName: "",
              });
            } catch (e) {
              console.warn(
                "[app] startup cloud bind failed (non-fatal — sync will still run):",
                e,
              );
            }
            setRepo(result.path);
            setConnected(true);
            setBypassOnboarding(true);
            await stateSave({
              last_repo: result.path,
              pane_sizes: s.pane_sizes ?? null,
              pinned_bubbles: s.pinned_bubbles ?? null,
              onboarding_complete: s.onboarding_complete ?? false,
            });
            // Skills sync writes _schema.json + scaffolding; await
            // before the seed gate so the schemas are on disk when
            // import-csv reads them. Then seed-before-connect, then
            // start engines. The order is load-bearing.
            try {
              const manifest = await syncSkillsToDisk(result.path, creds);
              console.log("[app] skill sync complete, bubbles:", manifest.bubbles);
              setBubbles(convertBubblesForPrompt(manifest.bubbles));
            } catch (e) {
              console.error("skill sync failed:", e);
            }
            await applySeedBeforeCloudConnect(result.path, creds);
            startCloudSyncs(creds, result.path, creds.orgId);
          } catch (e) {
            console.error("[app] startup bootstrap failed:", e);
          }
          finish();
          return;
        }

        // No-creds / local-only path. Fresh install or VITE_DEV_LOCAL_ONLY:
        // bootstrap a default local project at ~/OpenIT/local/, sync the
        // bundled plugin, skip onboarding. The user can opt into Pinkfish
        // later via the header pill (which still routes through the
        // existing PinkfishOauthModal).
        //
        // After Phase 1's V2 sync changes (PIN-5775), `stale && creds`
        // and `cloudRelaunchFellThrough && creds` both reach the
        // first-run-with-creds branch above and re-bind to
        // `~/OpenIT/local/`, so they never fall down to this no-creds
        // block. Only true no-creds startups land here.
        if (!creds) try {
          console.log("[app] local-only bootstrap");
          // If lastRepo is a cloud-keyed folder we can't sync without
          // creds, but the files are still readable. Prefer it over a
          // fresh local folder so a user who disconnected doesn't lose
          // access to their existing data.
          let projectPath: string;
          if (lastRepo) {
            // Re-run bootstrap so idempotent layout guards in project.rs
            // (e.g. creating new top-level dirs like `reports/` that
            // shipped after the project was first initialized) fire on
            // existing projects. Rust gates first-run side effects on
            // `!already_existed`, so this is safe to call.
            try {
              await projectBootstrap({ orgName: LOCAL_ORG_NAME, orgId: LOCAL_ORG_ID });
            } catch (e) {
              console.warn("[app] local-relaunch bootstrap failed (non-fatal):", e);
            }
            projectPath = lastRepo;
          } else {
            const result = await projectBootstrap({
              orgName: LOCAL_ORG_NAME,
              orgId: LOCAL_ORG_ID,
            });
            projectPath = result.path;
            await stateSave({
              last_repo: projectPath,
              pane_sizes: s.pane_sizes ?? null,
              pinned_bubbles: s.pinned_bubbles ?? null,
              onboarding_complete: s.onboarding_complete ?? false,
            });
          }
          setRepo(projectPath);
          setBypassOnboarding(true);
          // Sync the bundled plugin if the sentinel triage agent file
          // isn't on disk yet. Self-healing on retry: a partial first-
          // run (e.g. git init failing after the dir was created) leaves
          // the sentinel missing, so the next launch resyncs. User edits
          // to skills/agents/schemas survive across launches because the
          // sentinel exists. Plugin *upgrades* (newer bundle than what's
          // on disk) are a Phase 3b concern — versioning + diff prompt.
          if (!(await bundledPluginIsCurrent(projectPath))) {
            syncSkillsToDisk(projectPath, null)
              .then((manifest) => {
                console.log("[app] bundled skill sync complete, bubbles:", manifest.bubbles);
                setBubbles(convertBubblesForPrompt(manifest.bubbles));
                // Local-only: no engines to wait for. Seed gate just
                // checks folder-emptiness + sentinel.
                void applySeedLocalOnly(projectPath);
              })
              .catch((e) => console.error("bundled skill sync failed:", e));
          } else {
            // Plugin sync skipped (already current) but seed might
            // still be pending — run the gate independently.
            void applySeedLocalOnly(projectPath);
          }
        } catch (e) {
          console.error("[app] local-only bootstrap failed:", e);
        }
        finish();
      })
      .catch(() => setLoaded(true));
  });

  // Token + sync-engine lifecycle. Separate from the once-only
  // bootstrap so subscriptions get cleanup on unmount without
  // re-running the non-idempotent startup. (In a Tauri app the
  // unmount fires only on process exit, but the cleanup discipline
  // keeps a future hot-reload tidy.)
  useEffect(() => {
    const unsub = subscribeToken((t) => setConnected(t !== null));
    return () => {
      unsub();
      stopKbSync();
      stopFilestoreSync();
      stopDatastoreSync();
      stopAgentSync();
      stopWorkflowSync();
    };
  }, []);

  // Localhost ticket-intake server lifecycle. Tied to `repo` — start
  // when a project opens, transparently restart with the new path on
  // project switch. The Rust side enforces single-instance semantics:
  // intakeStart awaits an internal stop_inner before binding, so calling
  // it with a new repo cleanly swaps the previous server.
  //
  // Why no intakeStop in cleanup: a rapid repo change A → B can have
  // intakeStart(A)'s promise still pending when B's effect runs. If
  // A's cleanup called intakeStop and then A's promise resolved, the
  // resolve handler would see `cancelled=true`. Worse: if the cleanup
  // *and* a follow-up resolve both call intakeStop, the second one
  // kills server B that B's effect just brought up. Trusting Rust's
  // swap semantics + skipping cleanup-stop is simpler and race-free.
  // App close kills the spawned task via the tokio runtime drop on
  // process exit — no manual stop needed there either.
  const intakeGenRef = useRef(0);
  useEffect(() => {
    // Bump the generation counter unconditionally — including when
    // repo transitions to null. Without this, a still-pending
    // intakeStart from the previous repo could resolve after we set
    // the URL to null and overwrite it with a stale value (its gen
    // would still match because we didn't increment).
    const myGen = ++intakeGenRef.current;
    if (!repo) {
      setIntakeServerUrl(null);
      return;
    }
    intakeStart(repo)
      .then((url) => {
        // Only commit the URL if no later effect has superseded us. A
        // stale resolve setting an old URL would leave the header
        // pointing at a dead server.
        if (intakeGenRef.current !== myGen) return;
        console.log("[app] intake server up at", url);
        setIntakeServerUrl(url);
      })
      .catch((e) => {
        if (intakeGenRef.current !== myGen) return;
        console.error("[app] intake start failed:", e);
        setIntakeServerUrl(null);
      });
  }, [repo]);

  const onSyncLine = (line: string) => setSyncLines((prev) => [...prev, line]);

  const onPinkfishConnected = useCallback(async (incoming: string | null) => {
    setConnected(true);
    setOrgName(incoming);
    setSavedCreds(await loadCreds());
    if (!incoming) return;
    try {
      const creds = await loadCreds();
      console.log("[app] bootstrapping project", { orgName: incoming, orgId: creds?.orgId });
      // Phase 1 of V2 sync (PIN-5775): bind to `~/OpenIT/local/` (the
      // canonical local folder), then write `.openit/cloud.json` to
      // record the org binding. Replaces the V1 behaviour of creating
      // (and switching to) `~/OpenIT/<orgId>/`.
      const result = await projectBootstrap({
        orgName: LOCAL_ORG_NAME,
        orgId: LOCAL_ORG_ID,
      });
      console.log("[app] bootstrap result", result);
      if (creds?.orgId) {
        try {
          await projectBindToCloud({
            repo: result.path,
            orgId: creds.orgId,
            orgName: incoming,
          });
        } catch (e) {
          // Bind failure: most likely "folder already bound to another
          // org". Surface to console; sync will still run against the
          // existing binding (which is the conservative behaviour). A
          // proper UX for the bound-elsewhere case lands in a later
          // phase.
          console.warn("[app] cloud bind failed (non-fatal — sync will still run):", e);
        }
      }
      setRepo(result.path);
      const current = await stateLoad().catch(() => null);
      await stateSave({
        last_repo: result.path,
        pane_sizes: current?.pane_sizes ?? null,
        pinned_bubbles: current?.pinned_bubbles ?? null,
        onboarding_complete: current?.onboarding_complete ?? false,
      });
      const fullCreds = await loadCreds();
      if (fullCreds) {
        // Same load-bearing order as the first-run-with-creds path:
        // skills first, then seed, then engines. import-csv inside
        // customCreate reads `_schema.json` + sample rows from disk.
        try {
          const manifest = await syncSkillsToDisk(result.path, fullCreds);
          console.log("[app] skill sync complete, bubbles:", manifest.bubbles);
          setBubbles(convertBubblesForPrompt(manifest.bubbles));
        } catch (e) {
          console.error("skill sync failed:", e);
        }
        await applySeedBeforeCloudConnect(result.path, fullCreds);
        startCloudSyncs(fullCreds, result.path, incoming);
      }
    } catch (e) {
      console.error("[app] project bootstrap failed:", e);
    }
  }, []);

  // Browser-handoff state machine for Connect to Cloud. Hoisted so the
  // Onboarding screen, the in-shell cloud-cta button, and the header
  // pill all drive the same flow with shared state. The
  // ConnectStatusBanner below renders progress regardless of which
  // screen is currently mounted.
  //
  // `onConnected` is wrapped in useCallback so its identity is stable
  // across renders; otherwise `useBrowserConnect.start` would recreate
  // every render (its [onConnected] dep), which churns child re-renders
  // and breaks reference equality on the props passed to Onboarding.
  const onBrowserConnected = useCallback(
    (incoming: string | null) => {
      onPinkfishConnected(incoming);
      // Drop back into the shell on success — don't bounce the user
      // to onboarding when they triggered this from the cloud-cta.
      setBypassOnboarding(true);
    },
    [onPinkfishConnected],
  );
  const browserConnect = useBrowserConnect({ onConnected: onBrowserConnected });

  const showOnboarding = loaded && !bypassOnboarding;

  if (!loaded) {
    return <div className="shell-loading">Loading…</div>;
  }

  if (showOnboarding) {
    return (
      <Onboarding
        pinkfishConnected={connected}
        pinkfishOrgName={orgName}
        initialCreds={savedCreds}
        onPinkfishConnected={onPinkfishConnected}
        onPinkfishDisconnected={async () => {
          // Stop the 5 sync engines BEFORE clearing creds. Their 60-s
          // pollers would otherwise keep firing with a null token —
          // each tick logs a failed HTTP request, no upside. Mirror
          // the cleanup that the unmount effect runs.
          stopKbSync();
          stopFilestoreSync();
          stopDatastoreSync();
          stopAgentSync();
          stopWorkflowSync();
          // Wipe the keychain creds + in-memory token. subscribeToken
          // catches the null and flips `connected` to false; we still
          // need to manually reset orgName + savedCreds since neither
          // is derived from the token state.
          await clearCreds();
          setOrgName(null);
          setSavedCreds(null);
        }}
        onContinue={() => setBypassOnboarding(true)}
        browserConnect={browserConnect.state}
        startBrowserConnect={browserConnect.start}
        cancelBrowserConnect={browserConnect.cancel}
      />
    );
  }

  return (
    <>
    <main className="app">
      <header className="app-header">
        <div className="wordmark">
          <span className="app-title">OpenIT</span>
          <span className="app-title-sep" aria-hidden>·</span>
          <span className="app-tagline">get IT done</span>
        </div>
        <div className="app-header-actions">
          <button
            className="header-cmdk-hint"
            onClick={() => setPaletteOpen(true)}
            title="Command palette"
          >
            <kbd>⌘</kbd>
            <kbd>K</kbd>
            <span>jump anywhere</span>
          </button>
          <button
            className="icon-btn icon-btn-ghost"
            onClick={() => window.dispatchEvent(new CustomEvent("openit:open-welcome"))}
            title="Open the welcome / getting-started doc"
          >
            Getting Started
          </button>
          <button
            className={`icon-btn ${connected ? "key-set" : "icon-btn-primary"}`}
            onClick={() => {
              // Connected admins click the pill to update creds —
              // jump straight to onboarding. Local-only admins go
              // through the CTA pitch first (their click on its
              // primary button triggers the browser handoff).
              if (connected) setBypassOnboarding(false);
              else showCloudCtaRef.current?.();
            }}
            disabled={browserConnect.state.kind !== "idle" &&
              browserConnect.state.kind !== "error"}
            title={connected ? "Connected — click to update credentials" : "Connect to Cloud"}
          >
            {connected
              ? `Cloud · ${orgName ?? "connected"}`
              : browserConnect.state.kind === "waiting"
                ? "Authorize in browser…"
                : browserConnect.state.kind === "validating"
                  ? "Validating…"
                  : "Connect to Cloud"}
          </button>
        </div>
      </header>
      <section className="app-pane">
        <Shell
          key={repo ?? "none"}
          repo={repo}
          syncLines={syncLines}
          onSyncLine={onSyncLine}
          bubbles={bubbles}
          cloudConnected={connected}
          onConnectRequest={() => browserConnect.start()}
          intakeUrl={intakeServerUrl}
          skillCanvasState={skillCanvasState}
          skillCanvasOrgId={slackOrgId}
          onSkillCanvasClosed={() =>
            setSkillCanvasState((prev) => (prev ? { ...prev, active: false } : null))
          }
          slackConfig={slackConfig}
          slackStatus={slackStatus}
          orgName={orgName}
          onOpenPalette={() => setPaletteOpen(true)}
          onConnectSlack={triggerSlackFlow}
          registerManualPull={(fn) => { manualPullRef.current = fn; }}
          registerSwitchToSync={(fn) => { switchToSyncRef.current = fn; }}
          registerShowCloudCta={(fn) => { showCloudCtaRef.current = fn; }}
        />
      </section>
    </main>
    <CommandPalette
      open={paletteOpen}
      onClose={() => setPaletteOpen(false)}
      onConnectCloud={() => {
        if (connected) setBypassOnboarding(false);
        else showCloudCtaRef.current?.();
      }}
      onConnectSlack={triggerSlackFlow}
      onManualPull={() => manualPullRef.current?.()}
      onOpenWelcome={() => window.dispatchEvent(new CustomEvent("openit:open-welcome"))}
      onSwitchToSync={() => switchToSyncRef.current?.()}
    />
    </>
  );
}

export default App;
