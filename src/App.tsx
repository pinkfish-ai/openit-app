import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Shell } from "./shell/Shell";
import { DeployButton } from "./shell/DeployButton";
import { stateLoad, stateSave } from "./lib/api";
import { loadCreds, startAuth, subscribeToken, type PinkfishCreds } from "./lib/pinkfishAuth";
import { PinkfishOauthModal } from "./PinkfishOauthModal";
import "./App.css";

function App() {
  const [repo, setRepo] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [deployLines, setDeployLines] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [savedCreds, setSavedCreds] = useState<PinkfishCreds | null>(null);

  useEffect(() => {
    Promise.all([stateLoad(), startAuth(), loadCreds()])
      .then(([s, _token, creds]) => {
        setRepo(s.last_repo);
        setSavedCreds(creds);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    const unsub = subscribeToken((t) => setConnected(t !== null));
    return () => {
      unsub();
    };
  }, []);

  const pickRepo = async () => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string") {
      setRepo(picked);
      const current = await stateLoad().catch(() => null);
      await stateSave({
        last_repo: picked,
        pane_sizes: current?.pane_sizes ?? null,
        pinned_bubbles: current?.pinned_bubbles ?? null,
        onboarding_complete: current?.onboarding_complete ?? false,
      });
    }
  };

  const onDeployLine = (line: string) => setDeployLines((prev) => [...prev, line]);

  const onConnected = async () => {
    setConnected(true);
    setSavedCreds(await loadCreds());
  };

  return (
    <main className="app">
      <header className="app-header">
        <span className="app-title">OpenIT</span>
        <span className="app-repo">{repo ?? "no project folder"}</span>
        <button className="icon-btn" onClick={pickRepo}>
          {repo ? "Change project folder" : "Open project folder"}
        </button>
        <button
          className={`icon-btn ${connected ? "key-set" : ""}`}
          onClick={() => setAuthModalOpen(true)}
          title={connected ? "Connected — click to update credentials" : "Connect Pinkfish"}
        >
          {connected ? "Pinkfish: connected" : "Connect Pinkfish"}
        </button>
        <DeployButton
          repo={repo}
          env="dev"
          onLine={onDeployLine}
          onExit={(code) => onDeployLine(`▸ exit ${code ?? "?"}`)}
        />
      </header>
      {authModalOpen && (
        <PinkfishOauthModal
          initial={savedCreds}
          onClose={() => setAuthModalOpen(false)}
          onConnected={onConnected}
        />
      )}
      <section className="app-pane">
        {loaded && <Shell key={repo ?? "none"} repo={repo} deployLines={deployLines} />}
      </section>
    </main>
  );
}

export default App;
