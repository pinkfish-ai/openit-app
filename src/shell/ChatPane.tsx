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

export function ChatPane() {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const SESSION_ID = `main-${crypto.randomUUID()}`;

    const term = new Terminal({
      fontFamily: "Menlo, Monaco, 'SF Mono', monospace",
      fontSize: 13,
      cursorBlink: true,
      theme: {
        background: "#faf9f6",
        foreground: "#2d2a25",
        cursor: "#d96e3e",
        selectionBackground: "#f4dccd",
        black: "#2d2a25",
        red: "#c0392b",
        green: "#2c8a4f",
        yellow: "#b58a1f",
        blue: "#5a6cd1",
        magenta: "#a14fa1",
        cyan: "#2c8a8a",
        white: "#6b6864",
        brightBlack: "#9b988f",
        brightRed: "#d96e3e",
        brightGreen: "#3eb56e",
        brightYellow: "#d4a83a",
        brightBlue: "#7388e0",
        brightMagenta: "#c269c2",
        brightCyan: "#3eb5b5",
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
      if (e.dataTransfer?.types.includes("application/x-openit-path")) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }
    };
    const onInPageDrop = (e: DragEvent) => {
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
        await ptySpawn({ sessionId: SESSION_ID, cols, rows });
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
  }, []);

  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
}
