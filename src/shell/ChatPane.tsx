import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { openUrl } from "@tauri-apps/plugin-opener";
import { onPtyData, onPtyExit, ptyKill, ptyResize, ptySpawn, ptyWrite } from "../lib/pty";
import { setActiveSession, clearActiveSession } from "./activeSession";
import "@xterm/xterm/css/xterm.css";

// macOS Terminal.app behavior: dragging a file in writes its shell-escaped path.
function shellEscape(p: string): string {
  return `'${p.replace(/'/g, "'\\''")}'`;
}

export function ChatPane({ cwd, resume }: { cwd: string | null; resume?: boolean }) {
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
      // OSC 8 hyperlink handler. Claude Code emits OSC 8 escape
      // sequences for URLs in its output (the "rich" terminal
      // hyperlink protocol — separate from the regex-based plain
      // URL detection that WebLinksAddon handles below). Without
      // overriding this, xterm's default handler calls
      // `window.open`, which the Tauri webview blocks ("Opening
      // link blocked as opener could not be cleared") and then
      // falls through to `window.confirm`, which is also blocked
      // ("dialog.confirm not allowed"). Routing through Tauri's
      // openUrl plugin opens the link in the user's default
      // browser like every other openUrl call in the app.
      linkHandler: {
        activate(_event: MouseEvent, uri: string) {
          openUrl(uri).catch((e) => console.warn("openUrl failed:", e));
        },
        hover() {},
        leave() {},
      },
      // Colorblind-friendly palette on cream `#faf9f6`. The earlier
      // attempt kept yellows for Claude's tool-block headers, but
      // they wash out for colorblind users (deuteranopia/protanopia
      // confuses gold with neutral on a warm background). Strategy:
      // collapse most ANSI slots to near-foreground darks so the
      // chat reads as "dark text on tan" by default, with only
      // semantically-meaningful hues (red for removed/errors, green
      // for added/success) carrying real color — and even those use
      // distinct lightness too, so they're separable without hue
      // alone. Each value targets ≥7:1 contrast on cream.
      theme: {
        // Dark theatre — the right pane lives in a warm-black room
        // so Claude reads as a different surface from the cream
        // workbench. Foreground is warm cream so text stays familiar.
        background: "#1a140e",
        foreground: "#f0e7d3",
        cursor: "#e8804a",
        selectionBackground: "rgba(199, 90, 44, 0.32)",
        black: "#1a140e",
        red: "#e07a6a",
        green: "#a8c89e",
        yellow: "#d4b878",
        blue: "#9aa8e0",
        magenta: "#c89ac0",
        cyan: "#9ac8c0",
        white: "#d8cdb5",
        brightBlack: "#544a3a",
        brightRed: "#f0907e",
        brightGreen: "#b8d8ae",
        brightYellow: "#e0c888",
        brightBlue: "#aab8f0",
        brightMagenta: "#d8aad0",
        brightCyan: "#aad8d0",
        brightWhite: "#fff8ec",
      },
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Web-links addon: detects http(s):// URLs in terminal output
    // and makes them clickable. Routed through Tauri's openUrl so
    // links open in the user's default browser, not inside the
    // webview. The addon's built-in activation already requires
    // cmd-click on macOS (ctrl-click elsewhere), so we don't need
    // a custom modifier check — passing one was actually breaking
    // activation in the Tauri webview.
    term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        openUrl(uri).catch((e) => console.warn("openUrl failed:", e));
      }),
    );
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
        await ptySpawn({
          sessionId: SESSION_ID,
          cols,
          rows,
          cwd,
          args: resume ? ["--resume"] : [],
        });
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
        // Force xterm to repaint the visible buffer at the new width.
        // Without this, lines that streamed in at the previous column
        // count keep their original wrap points — so resizing the
        // pane mid-stream leaves a half-broken display until the user
        // hits Ctrl-L. New content wraps fine on its own; this only
        // matters for already-rendered scrollback.
        term.refresh(0, term.rows - 1);
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
