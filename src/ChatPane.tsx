import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { onPtyData, onPtyExit, ptyKill, ptyResize, ptySpawn, ptyWrite } from "./lib/pty";
import "@xterm/xterm/css/xterm.css";

const SESSION_ID = "main";

export function ChatPane() {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      fontFamily: "Menlo, Monaco, 'SF Mono', monospace",
      fontSize: 13,
      cursorBlink: true,
      theme: { background: "#0b0b0b" },
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();

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

      const unlistenData = await onPtyData(SESSION_ID, (chunk) => term.write(chunk));
      const unlistenExit = await onPtyExit(SESSION_ID, (code) => {
        term.writeln(`\r\n\x1b[33m[process exited${code != null ? `: ${code}` : ""}]\x1b[0m`);
      });
      unlistens.push(unlistenData, unlistenExit);

      term.onData((data) => {
        ptyWrite(SESSION_ID, data).catch(() => {});
      });

      const onResize = () => {
        if (disposed) return;
        fit.fit();
        ptyResize(SESSION_ID, term.cols, term.rows).catch(() => {});
      };
      window.addEventListener("resize", onResize);
      unlistens.push(() => window.removeEventListener("resize", onResize));
    })();

    return () => {
      disposed = true;
      for (const fn of unlistens) fn();
      ptyKill(SESSION_ID).catch(() => {});
      term.dispose();
    };
  }, []);

  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
}
