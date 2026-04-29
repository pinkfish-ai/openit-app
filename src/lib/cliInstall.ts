/// Bridge to the Rust `cli_tools` commands. Detection (`which`) is a
/// straight wrapper; install/uninstall hand off the brew package and
/// CLAUDE.md hint to Rust which runs `brew install/uninstall` and
/// splices the project CLAUDE.md.
///
/// Why CLI instead of MCP: zero token cost until invoked, no per-session
/// tool cap, and IT admins are already comfortable with brew. Claude
/// already knows the popular CLIs from training; for less-known tools
/// the CLAUDE.md hint includes a `<tool> --help` nudge for runtime
/// discovery.

import { invoke } from "@tauri-apps/api/core";
import { CATALOG, type CatalogEntry } from "./cliCatalog";

/// Returns the set of catalog ids whose binary is currently on PATH.
/// Independent of how the binary got there — a tool the user installed
/// manually still flips the card to "Installed." Detection is `which`,
/// so it's cheap; calling per-entry on every Workbench load is fine.
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

/// Run `brew install <pkg>` and add the entry's hint line to CLAUDE.md.
/// Resolves cleanly when both succeed; rejects with the brew stderr
/// (or the file write error) on failure.
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
/// indicating that CLAUDE.md was updated regardless — the UI uses
/// this to offer "remove from CLAUDE.md only" recovery.
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
    // Rust runs the CLAUDE.md splice before propagating the brew error,
    // so the hint is gone even when this rejects.
    const msg = e instanceof Error ? e.message : String(e);
    throw new UninstallError(msg, true);
  }
}

/// Strip the CLAUDE.md hint without touching any installed binary.
/// Used as the recovery path when `brew uninstall` fails because the
/// CLI wasn't brew-managed (manual installer, pip, etc.).
export async function removeHintOnly(
  projectRoot: string,
  entry: CatalogEntry,
): Promise<void> {
  await invoke("cli_remove_hint_only", {
    projectRoot,
    entryId: entry.id,
  });
}
