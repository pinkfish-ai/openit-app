import { useEffect, useState } from "react";
import { Onboarding } from "./Onboarding";
import { Shell } from "./shell/Shell";
import { projectBootstrap, stateLoad, stateSave } from "./lib/api";
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

function basename(p: string): string {
  const parts = p.split("/").filter((s) => s.length > 0);
  return parts[parts.length - 1] ?? p;
}

function convertBubblesForPrompt(manifestBubbles: ManifestBubble[]): PromptBubble[] {
  return manifestBubbles.map((b) => ({
    label: b.label,
    prompt: b.skill,
  }));
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
        console.log("[app] startup state:", { hasRepo: !!lastRepo, hasCreds: !!creds, orgId: creds?.orgId });
        setRepo(lastRepo);
        setSavedCreds(creds);
        // If we relaunched into a fully-connected state with a project folder,
        // skip the onboarding screen entirely AND restart KB sync against the
        // existing folder so polling resumes without onboarding.
        if (creds && lastRepo) {
          setBypassOnboarding(true);
          // We don't have orgName cached on relaunch — re-fetch it lazily.
          // The KB collection is already named openit-<slug> where
          // slug == basename(repo). Use that as both slug and a placeholder
          // name; resolveProjectKb will find the existing collection by name.
          const slug = basename(lastRepo);
          startKbSync({
            creds,
            repo: lastRepo,
            orgSlug: slug,
            orgName: slug,
          }).catch((e) => console.error("kb sync init failed:", e));
          startFilestoreSync({
            creds,
            repo: lastRepo,
          }).catch((e) => console.error("filestore sync init failed:", e));
          startDatastoreSync({
            creds,
            repo: lastRepo,
          }).catch((e) => console.error("datastore sync init failed:", e));
          startAgentSync({
            creds,
            repo: lastRepo,
          }).catch((e) => console.error("agent sync init failed:", e));
          startWorkflowSync({
            creds,
            repo: lastRepo,
          }).catch((e) => console.error("workflow sync init failed:", e));
          // Pull the plugin manifest on relaunch too — without this,
          // the bubble bar stays at the hardcoded DEFAULT_BUBBLES and
          // the user never sees the manifest's bubbles after the first
          // session. The first-run + connect-modal paths below already
          // handle this; relaunch was missed.
          syncSkillsToDisk(lastRepo, creds)
            .then((manifest) => {
              console.log("[app] skill sync complete on relaunch, bubbles:", manifest.bubbles);
              setBubbles(convertBubblesForPrompt(manifest.bubbles));
            })
            .catch((e) => console.error("skill sync failed on relaunch:", e));
        } else if (creds && !lastRepo && !repo && !stale) {
          // First run with dev creds — auto-bootstrap. Skipped when stale so
          // the user lands on the connect screen and re-connects deliberately.
          try {
            console.log("[app] bootstrap on startup with dev creds");
            const result = await projectBootstrap({
              orgName: creds.orgId || "default",
              orgId: creds.orgId,
            });
            console.log("[app] startup bootstrap result", result);
            setRepo(result.path);
            setConnected(true);
            setBypassOnboarding(true);
            // Persist new repo path so we don't keep treating last_repo as stale.
            await stateSave({
              last_repo: result.path,
              pane_sizes: s.pane_sizes ?? null,
              pinned_bubbles: s.pinned_bubbles ?? null,
              onboarding_complete: s.onboarding_complete ?? false,
            });
            startKbSync({
              creds,
              repo: result.path,
              orgSlug: basename(result.path),
              orgName: creds.orgId,
            }).catch((e) => console.error("kb sync init failed:", e));
            startFilestoreSync({
              creds,
              repo: result.path,
            }).catch((e) => console.error("filestore sync init failed:", e));
            startDatastoreSync({
              creds,
              repo: result.path,
            }).catch((e) => console.error("datastore sync init failed:", e));
            startAgentSync({
              creds,
              repo: result.path,
            }).catch((e) => console.error("agent sync init failed:", e));
            startWorkflowSync({
              creds,
              repo: result.path,
            }).catch((e) => console.error("workflow sync init failed:", e));
            syncSkillsToDisk(result.path, creds)
              .then((manifest) => {
                console.log("[app] skill sync complete, bubbles:", manifest.bubbles);
                setBubbles(convertBubblesForPrompt(manifest.bubbles));
              })
              .catch((e) => console.error("skill sync failed:", e));
          } catch (e) {
            console.error("[app] startup bootstrap failed:", e);
          }
        }
        setLoaded(true);
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
        startKbSync({
          creds: fullCreds,
          repo: result.path,
          orgSlug: basename(result.path),
          orgName: incoming,
        }).catch((e) => console.error("kb sync init failed:", e));
        startFilestoreSync({
          creds: fullCreds,
          repo: result.path,
        }).catch((e) => console.error("filestore sync init failed:", e));
        startDatastoreSync({
          creds: fullCreds,
          repo: result.path,
        }).catch((e) => console.error("datastore sync init failed:", e));
        startAgentSync({
          creds: fullCreds,
          repo: result.path,
        }).catch((e) => console.error("agent sync init failed:", e));
        startWorkflowSync({
          creds: fullCreds,
          repo: result.path,
        }).catch((e) => console.error("workflow sync init failed:", e));
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
        <button
          className={`icon-btn ${connected ? "key-set" : ""}`}
          onClick={() => setBypassOnboarding(false)}
          title={connected ? "Connected — click to update credentials" : "Connect Pinkfish"}
        >
          {connected
            ? `Pinkfish: ${orgName ?? "connected"}`
            : "Connect Pinkfish"}
        </button>
      </header>
      <section className="app-pane">
        <Shell
          key={repo ?? "none"}
          repo={repo}
          syncLines={syncLines}
          onSyncLine={onSyncLine}
          bubbles={bubbles}
        />
      </section>
    </main>
  );
}

export default App;
