/// CLI install/uninstall — hybrid model with cross-platform awareness.
///
/// On macOS we run `brew install` directly so the UI sees deterministic
/// state (idle → installing → installed/failed). On Windows/Linux we
/// don't try to maintain a per-OS, per-tool install matrix — we hand
/// off to Claude with the target OS as context, and Claude picks the
/// right install method (winget, apt/dnf, curl-pipe-bash from the
/// vendor, etc.).
///
/// The same hand-off path is also the recovery for brew failures on
/// macOS — when brew exits non-zero we have a captured stderr and
/// surface it to the user, who can then click "Ask Claude to debug"
/// to send the same kind of agent prompt with the actual error.

import { invoke } from "@tauri-apps/api/core";
import { writeToActiveSession } from "../shell/activeSession";
import { CATALOG, type CatalogEntry } from "./cliCatalog";

export type TargetOs = "macos" | "windows" | "linux" | "unknown";

/// Cached after the first call — the OS doesn't change at runtime.
let cachedTargetOs: TargetOs | null = null;

export async function getTargetOs(): Promise<TargetOs> {
  if (cachedTargetOs) return cachedTargetOs;
  try {
    const os = await invoke<string>("cli_target_os");
    cachedTargetOs = (os as TargetOs) ?? "unknown";
  } catch {
    cachedTargetOs = "unknown";
  }
  return cachedTargetOs;
}

/// Returns the set of catalog ids whose binary is currently on PATH.
export async function listInstalled(): Promise<Set<string>> {
  const installed = new Set<string>();
  await Promise.all(
    CATALOG.map(async (entry) => {
      try {
        const found = await invoke<boolean>("cli_is_installed", {
          binary: entry.binary,
        });
        if (found) installed.add(entry.id);
      } catch {
        // Treat detection failures as "not installed."
      }
    }),
  );
  return installed;
}

/// macOS-only: run `brew install <pkg>` and add the entry to CLAUDE.md.
/// Resolves on success; rejects with brew stderr on failure so the UI
/// can surface it (and offer the agentic-debug fallback).
export async function installCli(
  projectRoot: string,
  entry: CatalogEntry,
): Promise<void> {
  await invoke("cli_install", {
    args: {
      project_root: projectRoot,
      brew_pkg: entry.brewPkg,
      entry_id: entry.id,
      claude_md_line: entry.claudeMdHint,
    },
  });
}

/// macOS-only: run `brew uninstall <pkg>` and remove the entry from
/// CLAUDE.md. Throws an `UninstallError` on brew failure (the
/// CLAUDE.md splice runs regardless on the Rust side).
export class UninstallError extends Error {
  constructor(
    message: string,
    public readonly hintRemoved: boolean,
  ) {
    super(message);
    this.name = "UninstallError";
  }
}

export async function uninstallCli(
  projectRoot: string,
  entry: CatalogEntry,
): Promise<void> {
  try {
    await invoke("cli_uninstall", {
      args: {
        project_root: projectRoot,
        brew_pkg: entry.brewPkg,
        entry_id: entry.id,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new UninstallError(msg, true);
  }
}

/// Strip the CLAUDE.md hint without touching any installed binary.
/// Recovery path for non-brew-managed binaries on macOS, and the
/// uninstall completion step on Windows/Linux (Claude removes the
/// binary; we strip the hint here).
export async function removeHintOnly(
  projectRoot: string,
  entry: CatalogEntry,
): Promise<void> {
  await invoke("cli_remove_hint_only", {
    projectRoot,
    entryId: entry.id,
  });
}

/// Why we're handing the install/uninstall to Claude. Brew-failed
/// carries the stderr we captured; non-macOS carries the OS so Claude
/// can pick the right native install method.
export type AgentContext =
  | { kind: "brew-failed"; stderr: string }
  | { kind: "non-macos"; targetOs: Exclude<TargetOs, "macos"> };

/// Build the install prompt sent into the active Claude session.
/// Self-contained: identifies the tool, gives Claude the brew package
/// name as a hint, the docs URL, and the exact CLAUDE.md marker line
/// to write once the install succeeds. Pure function — unit-tested.
export function buildAgentInstallPrompt(
  entry: CatalogEntry,
  context: AgentContext,
): string {
  const lines: string[] = [];
  if (context.kind === "brew-failed") {
    lines.push(
      `[OpenIT] I tried to install ${entry.name} via \`brew install ${entry.brewPkg}\` and it failed:`,
      ``,
      "```",
      context.stderr.trim(),
      "```",
      ``,
      `Please debug this. Check the vendor docs at ${entry.docsUrl} for an alternate install method (curl script, package manager, dotnet tool, etc.) that works on this machine, run it, and verify with \`which ${entry.binary}\`.`,
    );
  } else {
    lines.push(
      `[OpenIT] Please install ${entry.name} on this machine.`,
      ``,
      `The user is running **${context.targetOs}** — pick the right native install method for that OS (winget on Windows; apt/dnf/pacman/snap on Linux; the vendor's recommended path otherwise). The brew package name (\`${entry.brewPkg}\`) is given as a hint about which tool, not as the install command. Vendor docs: ${entry.docsUrl}.`,
      ``,
      `After install, verify with \`which ${entry.binary}\`.`,
    );
  }
  lines.push(
    ``,
    `When the install succeeds, update CLAUDE.md per the marker convention. Add (or replace) this line keyed by entry id \`${entry.id}\`, sorted alphabetically among the existing entries:`,
    ``,
    `<!-- entry:${entry.id} -->- ${entry.claudeMdHint}`,
    ``,
    `If the marker block doesn't exist yet, create it at the end of CLAUDE.md.`,
    ``,
    `Tell me when it's done.`,
  );
  return lines.join("\n");
}

/// Build the uninstall prompt. Same shape — Claude picks the right
/// uninstall path based on either the captured brew stderr or the
/// target OS.
export function buildAgentUninstallPrompt(
  entry: CatalogEntry,
  context: AgentContext,
): string {
  const lines: string[] = [];
  if (context.kind === "brew-failed") {
    lines.push(
      `[OpenIT] I tried to uninstall ${entry.name} via \`brew uninstall ${entry.brewPkg}\` and it failed:`,
      ``,
      "```",
      context.stderr.trim(),
      "```",
      ``,
      `The CLAUDE.md hint for \`${entry.id}\` has already been removed. The binary is probably installed via a different mechanism (manual installer, pip, dotnet tool, etc.) — find the right uninstall path and run it.`,
    );
  } else {
    lines.push(
      `[OpenIT] Please uninstall ${entry.name} from this machine.`,
      ``,
      `The user is running **${context.targetOs}** — pick the right native uninstall method (winget, apt/dnf, etc.). The brew package name (\`${entry.brewPkg}\`) is given as a hint. Vendor docs: ${entry.docsUrl}.`,
      ``,
      `After the binary is removed, also strip the CLAUDE.md entry keyed by \`<!-- entry:${entry.id} -->\` from the OpenIT marker block. If that was the last entry, remove the entire block.`,
    );
  }
  lines.push(``, `Tell me when it's done.`);
  return lines.join("\n");
}

/// Send the install prompt to the active Claude session. Returns
/// false if no session is active.
export async function requestAgentInstall(
  entry: CatalogEntry,
  context: AgentContext,
): Promise<boolean> {
  return writeToActiveSession(buildAgentInstallPrompt(entry, context) + "\r");
}

export async function requestAgentUninstall(
  entry: CatalogEntry,
  context: AgentContext,
): Promise<boolean> {
  return writeToActiveSession(buildAgentUninstallPrompt(entry, context) + "\r");
}
