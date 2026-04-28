import { ptyWrite } from "../lib/pty";

let activeSessionId: string | null = null;
const listeners = new Set<(id: string | null) => void>();

function emit() {
  for (const l of listeners) l(activeSessionId);
}

export function setActiveSession(id: string) {
  activeSessionId = id;
  emit();
  drainPendingPostSpawnCommand(id);
}

export function clearActiveSession(id: string) {
  if (activeSessionId === id) {
    activeSessionId = null;
    emit();
  }
}

export function getActiveSession(): string | null {
  return activeSessionId;
}

/// Subscribe to active-session lifecycle changes. Fires with the new
/// id (or null) whenever it transitions. Used by ChatShellHeader's
/// live-dot to flip its state instead of pretending Claude is always
/// connected.
export function subscribeActiveSession(
  fn: (id: string | null) => void,
): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/// Write text into whatever PTY is currently active (the visible Claude session).
/// Resolves silently when no session is active so UI never crashes from a bubble click.
/// Returns true if a session was active and the write was issued.
export async function writeToActiveSession(text: string): Promise<boolean> {
  if (!activeSessionId) {
    console.warn(
      "[activeSession] no active Claude session — paste dropped. Make sure Claude is running in the right pane.",
    );
    return false;
  }
  await ptyWrite(activeSessionId, text);
  return true;
}

const restartListeners = new Set<() => void>();

/// Subscribe to "please restart the Claude session" events. Used by Shell
/// to bump `chatSessionKey`, which forces ChatPane to remount with a fresh
/// PTY. The MCP install flow fires this after `claude mcp add` succeeds
/// because Claude Code only reads `.mcp.json` at session start.
export function subscribeRestartRequested(fn: () => void): () => void {
  restartListeners.add(fn);
  return () => {
    restartListeners.delete(fn);
  };
}

/// Optional command (e.g. `/mcp\n`) to auto-write into the freshly-spawned
/// PTY. Cleared after one drain so it doesn't fire on subsequent restarts.
let pendingPostSpawnCommand: string | null = null;

/// Delay between PTY spawn and writing the post-spawn command. Claude
/// Code prints a boot banner for ~1s before the prompt accepts input;
/// writing too early gets the chars lost in that banner.
const POST_SPAWN_DELAY_MS = 1500;

export function requestSessionRestart(postSpawnCommand?: string): void {
  pendingPostSpawnCommand = postSpawnCommand ?? null;
  for (const l of restartListeners) l();
}

function drainPendingPostSpawnCommand(sessionId: string): void {
  const cmd = pendingPostSpawnCommand;
  if (!cmd) return;
  pendingPostSpawnCommand = null;
  setTimeout(() => {
    ptyWrite(sessionId, cmd).catch((e) =>
      console.error("[activeSession] post-spawn write failed:", e),
    );
  }, POST_SPAWN_DELAY_MS);
}
