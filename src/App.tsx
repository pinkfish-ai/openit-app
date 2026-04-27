import { useEffect, useRef, useState } from "react";
import { Onboarding } from "./Onboarding";
import { Shell } from "./shell/Shell";
import { fsRead, intakeStart, projectBootstrap, stateLoad, stateSave } from "./lib/api";
import { loadCreds, startAuth, subscribeToken, type PinkfishCreds } from "./lib/pinkfishAuth";
import { startKbSync, stopKbSync } from "./lib/kbSync";
import { startFilestoreSync, stopFilestoreSync } from "./lib/filestoreSync";
import { startDatastoreSync, stopDatastoreSync } from "./lib/datastoreSync";
import { startAgentSync, stopAgentSync } from "./lib/agentSync";
import { startWorkflowSync, stopWorkflowSync } from "./lib/workflowSync";
import { syncSkillsToDisk, type Bubble as ManifestBubble } from "./lib/skillsSync";
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

/// Has the bundled plugin been synced into this project? Checks for the
/// triage agent file as a sentinel — written by `syncSkillsToDisk` from
/// the bundled `agents/openit-triage.template.json`. Used to decide
/// whether to (re)run the bundle sync.
///
/// Why this sentinel rather than `projectBootstrap.created`: bootstrap
/// creates the dir before `git_ensure_repo` runs. If git init fails,
/// the throw skips `stateSave` and `syncSkillsToDisk` — but the dir
/// exists. On retry, `created: false`, and the old `freshBootstrap`
/// heuristic would permanently skip the sync, leaving the user with an
/// empty folder. Checking the sentinel file makes the sync idempotent
/// and self-healing.
async function bundledFilesAreOnDisk(repo: string): Promise<boolean> {
  const slug = basename(repo);
  try {
    await fsRead(`${repo}/agents/openit-triage-${slug}.json`);
    return true;
  } catch {
    return false;
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

/// Small pill in the header showing the localhost intake URL. Click to
/// copy. Surfaced here as a temporary home until the Phase 3b settings
/// panel lands — that's where the URL + the LAN-toggle will live
/// long-term, per the local-first plan.
function IntakeUrlPill({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.warn("[app] clipboard write failed:", e);
    }
  };
  return (
    <button
      type="button"
      className="intake-url-pill"
      onClick={onCopy}
      title="Click to copy. Share with someone on this machine to file a ticket via web form."
    >
      <span className="intake-url-pill-label">Intake</span>
      <code className="intake-url-pill-value">{url.replace(/^https?:\/\//, "")}</code>
      <span className="intake-url-pill-status">{copied ? "copied" : "copy"}</span>
    </button>
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
          if (!(await bundledFilesAreOnDisk(projectPath))) {
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
    <main className="app">
      <header className="app-header">
        <span className="app-title">OpenIT</span>
        <span className="app-tagline">get IT done</span>
        {intakeServerUrl && <IntakeUrlPill url={intakeServerUrl} />}
        <button
          className={`icon-btn ${connected ? "key-set" : ""}`}
          onClick={() => setBypassOnboarding(false)}
          title={connected ? "Connected — click to update credentials" : "Connect to Cloud"}
        >
          {connected
            ? `Cloud: ${orgName ?? "connected"}`
            : "Connect to Cloud"}
        </button>
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
        />
      </section>
    </main>
  );
}

export default App;
