import { ChatPane } from "./ChatPane";
import "./App.css";

function App() {
  return (
    <main className="app">
      <header className="app-header">
        <span className="app-title">OpenIT — M0 PTY Spike</span>
      </header>
      <section className="app-pane">
        <ChatPane />
      </section>
    </main>
  );
}

export default App;
