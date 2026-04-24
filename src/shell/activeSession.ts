import { ptyWrite } from "../lib/pty";

let activeSessionId: string | null = null;

export function setActiveSession(id: string) {
  activeSessionId = id;
}

export function clearActiveSession(id: string) {
  if (activeSessionId === id) activeSessionId = null;
}

export function getActiveSession(): string | null {
  return activeSessionId;
}

/// Write text into whatever PTY is currently active (the visible Claude session).
/// Resolves silently when no session is active so UI never crashes from a bubble click.
export async function writeToActiveSession(text: string): Promise<void> {
  if (!activeSessionId) return;
  await ptyWrite(activeSessionId, text);
}
