import { useEffect, useState } from "react";
import { Onboarding } from "./Onboarding";
import { Shell } from "./shell/Shell";
import { projectBootstrap, stateLoad, stateSave } from "./lib/api";
import { loadCreds, startAuth, subscribeToken, type PinkfishCreds } from "./lib/pinkfishAuth";
import { startKbSync, stopKbSync } from "./lib/kbSync";
import { startFilestoreSync, stopFilestoreSync } from "./lib/filestoreSync";
import "./App.css";

function basename(p: string): string {
  const parts = p.split("/").filter((s) => s.length > 0);
  return parts[parts.length - 1] ?? p;
}

function App() {
  const [repo, setRepo] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [deployLines, setDeployLines] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [orgName, setOrgName] = useState<string | null>(null);
  const [savedCreds, setSavedCreds] = useState<PinkfishCreds | null>(null);
  const [bypassOnboarding, setBypassOnboarding] = useState(false);

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
        console.log("[app] startup state:", { hasRepo: !!s.last_repo, hasCreds: !!creds, orgId: creds?.orgId });
        setRepo(s.last_repo);
        setSavedCreds(creds);
        // If we relaunched into a fully-connected state with a project folder,
        // skip the onboarding screen entirely AND restart KB sync against the
        // existing folder so polling resumes without onboarding.
        if (creds && s.last_repo) {
          setBypassOnboarding(true);
          // We don't have orgName cached on relaunch — re-fetch it lazily.
          // The KB collection is already named openit-<slug> where
          // slug == basename(repo). Use that as both slug and a placeholder
          // name; resolveProjectKb will find the existing collection by name.
          const slug = basename(s.last_repo);
          startKbSync({
            creds,
            repo: s.last_repo,
            orgSlug: slug,
            orgName: slug,
          }).catch((e) => console.error("kb sync init failed:", e));
          startFilestoreSync({
            creds,
            repo: s.last_repo,
          }).catch((e) => console.error("filestore sync init failed:", e));
        } else if (creds && !s.last_repo && !repo) {
          // On first run with dev creds, bootstrap a project automatically
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
    };
  }, []);

  const onDeployLine = (line: string) => setDeployLines((prev) => [...prev, line]);

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
          env="dev"
          deployLines={deployLines}
          onDeployLine={onDeployLine}
          onDeployExit={(code) => onDeployLine(`▸ exit ${code ?? "?"}`)}
        />
      </section>
    </main>
  );
}

export default App;
