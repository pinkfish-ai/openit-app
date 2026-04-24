import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Shell } from "./shell/Shell";
import { DeployButton } from "./shell/DeployButton";
import { stateLoad, stateSave } from "./lib/api";
import "./App.css";

function App() {
  const [repo, setRepo] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [deployLines, setDeployLines] = useState<string[]>([]);

  useEffect(() => {
    stateLoad()
      .then((s) => {
        setRepo(s.last_repo);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
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

  return (
    <main className="app">
      <header className="app-header">
        <span className="app-title">OpenIT</span>
        <span className="app-repo">{repo ?? "no project folder"}</span>
        <button className="icon-btn" onClick={pickRepo}>
          {repo ? "Change project folder" : "Open project folder"}
        </button>
        <DeployButton
          repo={repo}
          env="dev"
          onLine={onDeployLine}
          onExit={(code) => onDeployLine(`▸ exit ${code ?? "?"}`)}
        />
      </header>
      <section className="app-pane">
        {loaded && <Shell key={repo ?? "none"} repo={repo} deployLines={deployLines} />}
      </section>
    </main>
  );
}

export default App;
