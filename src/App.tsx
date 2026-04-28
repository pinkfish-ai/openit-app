import { useEffect, useRef, useState } from "react";
import { Onboarding } from "./Onboarding";
import { Shell } from "./shell/Shell";
import { CommandPalette } from "./shell/CommandPalette";
import {
  fsRead,
  intakeStart,
  projectBootstrap,
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
import { loadCreds, startAuth, subscribeToken, type PinkfishCreds } from "./lib/pinkfishAuth";
import { startKbSync, stopKbSync } from "./lib/kbSync";
import { startFilestoreSync, stopFilestoreSync } from "./lib/filestoreSync";
import { startDatastoreSync, stopDatastoreSync } from "./lib/datastoreSync";
import { startAgentSync, stopAgentSync } from "./lib/agentSync";
import { startWorkflowSync, stopWorkflowSync } from "./lib/workflowSync";
import { syncSkillsToDisk, readSyncedPluginVersion, type Bubble as ManifestBubble } from "./lib/skillsSync";
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
function startCloudSyncs(creds: PinkfishCreds, repo: string, orgName: string): void {
  const slug = basename(repo);
  startKbSync({ creds, repo, orgSlug: slug, orgName }).catch((e) =>
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

  useEffect(() => {
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

        if (creds && lastRepo) {
          // Cloud-connected relaunch — skip onboarding and resume syncs.
          // We don't have orgName cached on relaunch — use the slug as
          // the user-facing label until something better is fetched.
          // Re-run bootstrap so idempotent layout guards in project.rs
          // (e.g. creating new top-level dirs added in later versions)
          // can fire on existing projects without requiring a re-init.
          // The Rust side gates first-run side effects (welcome doc,
          // initial subdir creation) on `!already_existed`, so this is
          // safe to call on every launch.
          try {
            await projectBootstrap({ orgName: creds.orgId || "default", orgId: creds.orgId });
          } catch (e) {
            console.warn("[app] cloud-relaunch bootstrap failed (non-fatal):", e);
          }
          setBypassOnboarding(true);
          startCloudSyncs(creds, lastRepo, basename(lastRepo));
          finish();
          return;
        }

        if (creds && !lastRepo && !stale) {
          // First run with dev creds — auto-bootstrap into the cloud-keyed folder.
          try {
            console.log("[app] bootstrap on startup with dev creds");
            const result = await projectBootstrap({
              orgName: creds.orgId || "default",
              orgId: creds.orgId,
            });
            setRepo(result.path);
            setConnected(true);
            setBypassOnboarding(true);
            await stateSave({
              last_repo: result.path,
              pane_sizes: s.pane_sizes ?? null,
              pinned_bubbles: s.pinned_bubbles ?? null,
              onboarding_complete: s.onboarding_complete ?? false,
            });
            startCloudSyncs(creds, result.path, creds.orgId);
            syncSkillsToDisk(result.path, creds)
              .then((manifest) => {
                console.log("[app] skill sync complete, bubbles:", manifest.bubbles);
                setBubbles(convertBubblesForPrompt(manifest.bubbles));
              })
              .catch((e) => console.error("skill sync failed:", e));
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
        // The `!creds` guard matters when `stale && creds`: we discarded
        // the legacy `~/Documents/OpenIT/<orgId>/` lastRepo above, so the
        // cloud-bootstrap branch's `!stale` check fails. Without this
        // guard, a user with valid cloud creds + a stale repo path would
        // silently land in local-only mode instead of seeing onboarding.
        // Onboarding is the right surface for them — they reconnect and
        // we bootstrap fresh into `~/OpenIT/<orgId>/`.
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
              })
              .catch((e) => console.error("bundled skill sync failed:", e));
          }
        } catch (e) {
          console.error("[app] local-only bootstrap failed:", e);
        }
        finish();
      })
      .catch(() => setLoaded(true));
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

  const onPinkfishConnected = async (incoming: string | null) => {
    setConnected(true);
    setOrgName(incoming);
    setSavedCreds(await loadCreds());
    if (!incoming) return;
    try {
      const creds = await loadCreds();
      console.log("[app] bootstrapping project", { orgName: incoming, orgId: creds?.orgId });
      const result = await projectBootstrap({
        orgName: incoming,
        orgId: creds?.orgId ?? "",
      });
      console.log("[app] bootstrap result", result);
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
        startCloudSyncs(fullCreds, result.path, incoming);
        syncSkillsToDisk(result.path, fullCreds)
          .then((manifest) => {
            console.log("[app] skill sync complete, bubbles:", manifest.bubbles);
            setBubbles(convertBubblesForPrompt(manifest.bubbles));
          })
          .catch((e) => console.error("skill sync failed:", e));
      }
    } catch (e) {
      console.error("[app] project bootstrap failed:", e);
    }
  };

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
        onContinue={() => setBypassOnboarding(true)}
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
            onClick={() => setBypassOnboarding(false)}
            title={connected ? "Connected — click to update credentials" : "Connect to Cloud"}
          >
            {connected
              ? `Cloud · ${orgName ?? "connected"}`
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
          onConnectRequest={() => setBypassOnboarding(false)}
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
          registerManualPull={(fn) => { manualPullRef.current = fn; }}
          registerSwitchToSync={(fn) => { switchToSyncRef.current = fn; }}
        />
      </section>
    </main>
    <CommandPalette
      open={paletteOpen}
      onClose={() => setPaletteOpen(false)}
      onConnectCloud={() => setBypassOnboarding(false)}
      onConnectSlack={async () => {
        if (!repo || !intakeServerUrl) return;
        // Same two-step flow the SlackPill click used: scaffold the
        // skill canvas state file FIRST so the canvas pops open
        // immediately, THEN inject /connect-slack so Claude resumes
        // orchestration. Without step 1, the slash-command goes in
        // but no canvas appears (Claude has to author the JSON
        // itself, which surfaces a noisy permission prompt).
        try {
          const existing = await skillStateRead(repo, "connect-slack");
          const defaults = slackConfig
            ? buildManageState(slackConfig)
            : buildSetupState();
          const next = existing
            ? mergeSkillState(existing, defaults)
            : defaults;
          await skillStateWrite(repo, "connect-slack", next);
        } catch (e) {
          console.warn("[app] slack canvas scaffold failed:", e);
        }
        injectIntoChat("/connect-slack").catch((e) =>
          console.warn("[app] inject /connect-slack failed:", e),
        );
      }}
      onManualPull={() => manualPullRef.current?.()}
      onOpenWelcome={() => window.dispatchEvent(new CustomEvent("openit:open-welcome"))}
      onSwitchToSync={() => switchToSyncRef.current?.()}
    />
    </>
  );
}

export default App;
