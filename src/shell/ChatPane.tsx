import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { onPtyData, onPtyExit, ptyKill, ptyResize, ptySpawn, ptyWrite } from "../lib/pty";
import { setActiveSession, clearActiveSession } from "./activeSession";
import "@xterm/xterm/css/xterm.css";

// macOS Terminal.app behavior: dragging a file in writes its shell-escaped path.
function shellEscape(p: string): string {
  return `'${p.replace(/'/g, "'\\''")}'`;
}

export function ChatPane({ cwd }: { cwd: string | null }) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    if (!cwd) return; // Don't spawn until we have a project folder
    const SESSION_ID = `main-${crypto.randomUUID()}`;

    const term = new Terminal({
      fontFamily:
        "'MesloLGS NF', 'JetBrainsMono Nerd Font Mono', 'JetBrainsMono Nerd Font', 'Hack Nerd Font Mono', 'Hack Nerd Font', 'Symbols Nerd Font Mono', Menlo, Monaco, 'SF Mono', monospace",
      fontSize: 13,
      cursorBlink: true,
      // ANSI palette tuned for the cream `#faf9f6` background. Each
      // color targets ≥4.5:1 contrast (WCAG AA) on cream so Claude
      // Code's tool blocks (yellow), prompt arrows (cyan), and dim
      // helper text (white/brightBlack) stay legible. The previous
      // values were borrowed from a dark-bg palette and washed out
      // here — yellows especially looked ghostly.
      theme: {
        background: "#faf9f6",
        foreground: "#2d2a25",
        cursor: "#d96e3e",
        selectionBackground: "#f4dccd",
        black: "#2d2a25",
        red: "#a8281a",
        green: "#1f6e3e",
        yellow: "#7a5a08",       // was #b58a1f — deepened for cream
        blue: "#4555b8",
        magenta: "#8a3d8a",
        cyan: "#1f6e6e",
        white: "#5c5854",        // was #6b6864 — dim text, now legible
        brightBlack: "#7a7770",  // was #9b988f — still dim, but readable
        brightRed: "#c0392b",
        brightGreen: "#2c8a4f",
        brightYellow: "#9a7415", // was #d4a83a — readable gold on cream
        brightBlue: "#5a6cd1",
        brightMagenta: "#a14fa1",
        brightCyan: "#2c8a8a",
        brightWhite: "#2d2a25",
      },
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();
    term.focus();
    const focusOnClick = () => term.focus();
    containerRef.current.addEventListener("click", focusOnClick);

    // In-page drag-drop from the file explorer.
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("application/x-openit-path") ||
          e.dataTransfer?.types.includes("application/x-openit-ref")) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }
    };
    const onInPageDrop = (e: DragEvent) => {
      // Entity reference drop (databases, agents, workflows, rows)
      const ref = e.dataTransfer?.getData("application/x-openit-ref");
      if (ref) {
        e.preventDefault();
        ptyWrite(SESSION_ID, ref + " ").catch((err) => console.error("pty bridge error:", err));
        return;
      }
      // File path drop
      const path = e.dataTransfer?.getData("application/x-openit-path");
      if (!path) return;
      e.preventDefault();
      const text = shellEscape(path) + " ";
      ptyWrite(SESSION_ID, text).catch((err) => console.error("pty bridge error:", err));
    };
    containerRef.current.addEventListener("dragover", onDragOver, true);
    containerRef.current.addEventListener("drop", onInPageDrop, true);

    const unlistens: Array<() => void> = [];
    let disposed = false;

    (async () => {
      const { cols, rows } = term;
      try {
        await ptySpawn({ sessionId: SESSION_ID, cols, rows, cwd });
      } catch (e) {
        term.writeln(`\x1b[31mfailed to spawn pty: ${String(e)}\x1b[0m`);
        return;
      }
      if (disposed) {
        ptyKill(SESSION_ID).catch(() => {});
        return;
      }

      setActiveSession(SESSION_ID);

      const unlistenData = await onPtyData(SESSION_ID, (chunk) => term.write(chunk));
      const unlistenExit = await onPtyExit(SESSION_ID, (code) => {
        term.writeln(`\r\n\x1b[33m[process exited${code != null ? `: ${code}` : ""}]\x1b[0m`);
      });
      if (disposed) {
        unlistenData();
        unlistenExit();
        ptyKill(SESSION_ID).catch(() => {});
        return;
      }
      unlistens.push(unlistenData, unlistenExit);

      term.onData((data) => {
        ptyWrite(SESSION_ID, data).catch((e) => console.error("pty bridge error:", e));
      });

      const onResize = () => {
        if (disposed) return;
        fit.fit();
        ptyResize(SESSION_ID, term.cols, term.rows).catch((e) =>
          console.error("pty bridge error:", e),
        );
      };
      window.addEventListener("resize", onResize);
      unlistens.push(() => window.removeEventListener("resize", onResize));

      // Catch pane-splitter drags — those don't fire window 'resize'.
      // Throttle to one rAF so we don't ptyResize on every pixel.
      let rafScheduled = false;
      const observer = new ResizeObserver(() => {
        if (rafScheduled) return;
        rafScheduled = true;
        requestAnimationFrame(() => {
          rafScheduled = false;
          onResize();
        });
      });
      if (containerRef.current) observer.observe(containerRef.current);
      unlistens.push(() => observer.disconnect());

      const unlistenDrop = await getCurrentWebview().onDragDropEvent((event) => {
        if (disposed) return;
        if (event.payload.type !== "drop") return;
        const paths = event.payload.paths ?? [];
        if (paths.length === 0) return;
        const text = paths.map(shellEscape).join(" ") + " ";
        ptyWrite(SESSION_ID, text).catch((e) => console.error("pty bridge error:", e));
      });
      if (disposed) {
        unlistenDrop();
      } else {
        unlistens.push(unlistenDrop);
      }
    })();

    return () => {
      disposed = true;
      clearActiveSession(SESSION_ID);
      containerRef.current?.removeEventListener("click", focusOnClick);
      containerRef.current?.removeEventListener("dragover", onDragOver, true);
      containerRef.current?.removeEventListener("drop", onInPageDrop, true);
      for (const fn of unlistens) fn();
      ptyKill(SESSION_ID).catch((e) => console.error("pty bridge error:", e));
      term.dispose();
    };
  }, [cwd]);

  if (!cwd) {
    return (
      <div className="chat-empty">
        Open a project folder to start a Claude Code session.
      </div>
    );
  }

  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
}
