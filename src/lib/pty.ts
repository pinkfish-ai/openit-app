import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type PtyDataEvent = { session_id: string; data: string };
export type PtyExitEvent = { session_id: string; code: number | null };

export async function ptySpawn(args: {
  sessionId: string;
  command?: string | null;
  args?: string[];
  cwd?: string | null;
  cols: number;
  rows: number;
}): Promise<void> {
  await invoke("pty_spawn", {
    args: {
      session_id: args.sessionId,
      command: args.command ?? null,
      args: args.args ?? [],
      cwd: args.cwd ?? null,
      cols: args.cols,
      rows: args.rows,
    },
  });
}

export async function ptyWrite(sessionId: string, data: string): Promise<void> {
  await invoke("pty_write", { sessionId, data });
}

export async function ptyResize(sessionId: string, cols: number, rows: number): Promise<void> {
  await invoke("pty_resize", { sessionId, cols, rows });
}

export async function ptyKill(sessionId: string): Promise<void> {
  await invoke("pty_kill", { sessionId });
}

export async function onPtyData(
  sessionId: string,
  handler: (chunk: string) => void,
): Promise<UnlistenFn> {
  return listen<PtyDataEvent>("pty://data", (event) => {
    if (event.payload.session_id === sessionId) {
      handler(event.payload.data);
    }
  });
}

export async function onPtyExit(
  sessionId: string,
  handler: (code: number | null) => void,
): Promise<UnlistenFn> {
  return listen<PtyExitEvent>("pty://exit", (event) => {
    if (event.payload.session_id === sessionId) {
      handler(event.payload.code);
    }
  });
}
