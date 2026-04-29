/// CLI install/uninstall — hybrid model. The happy path runs `brew
/// install` directly via the Rust `cli_install` command so the UI sees
/// deterministic state (idle → installing → installed/failed). On
/// failure, the captured stderr can be handed to Claude as a debug
/// prompt — Claude picks an alternate install path (curl, dnf, dotnet
/// tool, etc.) for cases where our brew metadata is wrong or the user's
/// machine is unusual.

import { invoke } from "@tauri-apps/api/core";
import { writeToActiveSession } from "../shell/activeSession";
import { CATALOG, type CatalogEntry } from "./cliCatalog";

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

/// Run `brew install <pkg>` and add the entry to CLAUDE.md. Resolves
/// when both succeed; rejects with brew stderr on failure so the UI
/// can surface it (and offer the Claude-debug fallback).
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

/// Run `brew uninstall <pkg>` and remove the entry from CLAUDE.md.
/// Throws an `UninstallError` carrying the brew error AND a flag
/// indicating CLAUDE.md was already cleaned up — the UI uses this to
/// offer the "remove hint only" recovery for non-brew-managed binaries.
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
/// Recovery path when brew uninstall fails because the CLI wasn't
/// brew-managed.
export async function removeHintOnly(
  projectRoot: string,
  entry: CatalogEntry,
): Promise<void> {
  await invoke("cli_remove_hint_only", {
    projectRoot,
    entryId: entry.id,
  });
}

/// Build the debug prompt for a failed install. Self-contained — gives
/// Claude the brew command we tried, the actual stderr, the vendor
/// docs URL, and the marker-block update we want once it succeeds.
/// Pure function so it can be unit-tested.
export function buildInstallDebugPrompt(
  entry: CatalogEntry,
  brewStderr: string,
): string {
  return [
    `[OpenIT] I tried to install ${entry.name} via \`brew install ${entry.brewPkg}\` and it failed:`,
    ``,
    "```",
    brewStderr.trim(),
    "```",
    ``,
    `Please debug this. Check the vendor docs at ${entry.docsUrl} for an alternate install method (curl script, package manager, dotnet tool, etc.) that works on this OS, run it, and verify with \`which ${entry.binary}\`.`,
    ``,
    `When the install succeeds, update CLAUDE.md per the marker convention. Add (or replace) this line keyed by entry id \`${entry.id}\`, sorted alphabetically among the existing entries:`,
    ``,
    `<!-- entry:${entry.id} -->- ${entry.claudeMdHint}`,
    ``,
    `If the marker block doesn't exist yet, create it at the end of CLAUDE.md.`,
    ``,
    `Tell me when it's done.`,
  ].join("\n");
}

/// Build the debug prompt for a failed uninstall. Same idea — Claude
/// picks the right uninstall path given the captured stderr.
export function buildUninstallDebugPrompt(
  entry: CatalogEntry,
  brewStderr: string,
): string {
  return [
    `[OpenIT] I tried to uninstall ${entry.name} via \`brew uninstall ${entry.brewPkg}\` and it failed:`,
    ``,
    "```",
    brewStderr.trim(),
    "```",
    ``,
    `The CLAUDE.md hint for \`${entry.id}\` has already been removed. The binary is probably installed via a different mechanism (manual installer, pip, dotnet tool, etc.) — find the right uninstall path and run it.`,
    ``,
    `Tell me when it's done.`,
  ].join("\n");
}

/// Send the install-debug prompt to the active Claude session. Returns
/// false if no session is active.
export async function requestInstallDebug(
  entry: CatalogEntry,
  brewStderr: string,
): Promise<boolean> {
  return writeToActiveSession(buildInstallDebugPrompt(entry, brewStderr) + "\r");
}

export async function requestUninstallDebug(
  entry: CatalogEntry,
  brewStderr: string,
): Promise<boolean> {
  return writeToActiveSession(
    buildUninstallDebugPrompt(entry, brewStderr) + "\r",
  );
}
