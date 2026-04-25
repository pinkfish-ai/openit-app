import { useEffect, useState } from "react";
import { Onboarding } from "./Onboarding";
import { Shell } from "./shell/Shell";
import { DeployButton } from "./shell/DeployButton";
import { projectBootstrap, stateLoad, stateSave } from "./lib/api";
import { loadCreds, startAuth, subscribeToken, type PinkfishCreds } from "./lib/pinkfishAuth";
import "./App.css";

function App() {
  const [repo, setRepo] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [deployLines, setDeployLines] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [orgName, setOrgName] = useState<string | null>(null);
  const [savedCreds, setSavedCreds] = useState<PinkfishCreds | null>(null);
  const [bypassOnboarding, setBypassOnboarding] = useState(false);

  useEffect(() => {
    Promise.all([stateLoad(), startAuth(), loadCreds()])
      .then(([s, _token, creds]) => {
        setRepo(s.last_repo);
        setSavedCreds(creds);
        // If we relaunched into a fully-connected state with a project folder,
        // skip the onboarding screen entirely.
        if (creds && s.last_repo) {
          setBypassOnboarding(true);
        }
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    const unsub = subscribeToken((t) => setConnected(t !== null));
    return () => {
      unsub();
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
      const result = await projectBootstrap({
        orgName: incoming,
        orgId: creds?.orgId ?? "",
      });
      setRepo(result.path);
      const current = await stateLoad().catch(() => null);
      await stateSave({
        last_repo: result.path,
        pane_sizes: current?.pane_sizes ?? null,
        pinned_bubbles: current?.pinned_bubbles ?? null,
        onboarding_complete: current?.onboarding_complete ?? false,
      });
    } catch (e) {
      console.error("project bootstrap failed:", e);
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
        <span className="app-repo">{repo ?? "no project folder"}</span>
        <button
          className={`icon-btn ${connected ? "key-set" : ""}`}
          onClick={() => setBypassOnboarding(false)}
          title={connected ? "Connected — click to update credentials" : "Connect Pinkfish"}
        >
          {connected
            ? `Pinkfish: ${orgName ?? "connected"}`
            : "Connect Pinkfish"}
        </button>
        <DeployButton
          repo={repo}
          env="dev"
          onLine={onDeployLine}
          onExit={(code) => onDeployLine(`▸ exit ${code ?? "?"}`)}
        />
      </header>
      <section className="app-pane">
        <Shell key={repo ?? "none"} repo={repo} deployLines={deployLines} />
      </section>
    </main>
  );
}

export default App;
