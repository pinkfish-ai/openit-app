import React from "react";
import ReactDOM from "react-dom/client";
// Bundled fonts — desktop app must work offline. Weights pulled match
// what App.css references.
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource-variable/source-serif-4/standard.css";
import "@fontsource-variable/source-serif-4/standard-italic.css";
import App from "./App";
import { checkForUpdatesOnLaunch } from "./lib/updater";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

void checkForUpdatesOnLaunch();
