import { ptyWrite } from "../lib/pty";

let activeSessionId: string | null = null;

export function setActiveSession(id: string) {
  activeSessionId = id;
}

export function clearActiveSession(id: string) {
  if (activeSessionId === id) {
    activeSessionId = null;
  }
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
