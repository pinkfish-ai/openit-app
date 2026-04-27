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
        background: "#faf9f6",
        foreground: "#2d2a25",
        cursor: "#d96e3e",
        selectionBackground: "#f4dccd",
        // black + brightBlack collapsed to the cream bg so any
        // ANSI-bg-black banner (Claude Code's header chrome) doesn't
        // render as a dark slab on the otherwise-light theme. Side
        // effect: ANSI fg-black text becomes invisible — but Claude
        // Code rarely uses fg-black-on-default-bg, and when it does
        // it falls back to `foreground` anyway since the term default
        // dominates.
        black: "#faf9f6",
        // Diff "removed" / errors — deep red, low lightness (~8%).
        red: "#6b1010",
        // Diff "added" / success — medium-dark green, lightness ~24%.
        // Pairing lightness 8% (red) vs 24% (green) gives separation
        // even when hue is indistinguishable.
        green: "#1f6e3e",
        // Tool-block headers + "thinking" status text. Mid-gray (#666)
        // reads on both the cream default bg and any residual dark bg
        // — the prior dark-brown-on-cream had too little contrast on
        // the dark Claude Code banner.
        yellow: "#666666",
        blue: "#2d3d8a",
        magenta: "#5c2a5c",
        cyan: "#1a4a4a",
        // Dim helper text — readable mid-gray.
        white: "#4a4844",
        brightBlack: "#faf9f6",
        // Bright variants stay slightly more saturated than their
        // base for genuine emphasis distinguishable for colorblind.
        brightRed: "#a8281a",
        brightGreen: "#2c8a4f",
        brightYellow: "#666666",
        brightBlue: "#4555b8",
        brightMagenta: "#8a3d8a",
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
