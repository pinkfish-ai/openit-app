/// Install / uninstall happen through Claude. OpenIT writes a structured
/// prompt into the embedded Claude session; Claude runs the install
/// (brew first, vendor docs as fallback), debugs failures, and updates
/// CLAUDE.md per the marker convention documented in the plugin's
/// `CLAUDE.md` (`<!-- openit:cli-tools:start -->` block, per-entry
/// `<!-- entry:ID -->` lines).
///
/// The free PATH lookup (`cli_is_installed`) is what the catalog UI
/// uses to reflect installed-vs-not. Detection is source-agnostic — a
/// binary the user installed manually still flips the card.

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

/// Build the install prompt for a catalog entry. Self-contained — gives
/// Claude the suggested brew command, the vendor docs URL for fallback,
/// the entry id and hint line, and a reminder to verify with `which`.
/// Pulled out as a pure function so it can be unit-tested.
export function buildInstallPrompt(entry: CatalogEntry): string {
  return [
    `[OpenIT] Please install ${entry.name} on this machine.`,
    ``,
    `Suggested install: \`brew install ${entry.brewPkg}\`. If brew is missing, the formula isn't found, or the install otherwise fails, check the vendor docs (${entry.docsUrl}) for an alternate method (curl script, package manager, etc.) and use whichever works on this OS.`,
    ``,
    `After install, verify the binary is on PATH: \`which ${entry.binary}\`.`,
    ``,
    `Then update CLAUDE.md to register the tool. Use the marker convention from the "Locally-installed CLI tools" section. Add (or replace) this exact entry line, keyed by entry id \`${entry.id}\`:`,
    ``,
    `<!-- entry:${entry.id} -->- ${entry.claudeMdHint}`,
    ``,
    `Lines inside the block should be sorted alphabetically by entry id. If the marker block doesn't exist yet, create it at the end of CLAUDE.md.`,
    ``,
    `Tell me when it's done — including whether the install succeeded.`,
  ].join("\n");
}

/// Build the uninstall prompt. Mirrors install — Claude runs `brew
/// uninstall` (or alternative) and strips the entry from CLAUDE.md.
export function buildUninstallPrompt(entry: CatalogEntry): string {
  return [
    `[OpenIT] Please uninstall ${entry.name} from this machine.`,
    ``,
    `Suggested removal: \`brew uninstall ${entry.brewPkg}\`. If the binary wasn't brew-managed (manual installer, etc.), use the appropriate removal method or just confirm with the user how it was installed.`,
    ``,
    `Then update CLAUDE.md: remove the line keyed by \`<!-- entry:${entry.id} -->\` from the OpenIT marker block. If that was the last entry, remove the entire block.`,
    ``,
    `Tell me when it's done.`,
  ].join("\n");
}

/// Write the install prompt into the active Claude session. Returns
/// false if no session is active (the user hasn't started Claude yet);
/// the UI surfaces that as an error.
export async function requestCliInstall(entry: CatalogEntry): Promise<boolean> {
  const prompt = buildInstallPrompt(entry);
  // Trailing carriage return submits the prompt as a new turn.
  return writeToActiveSession(prompt + "\r");
}

export async function requestCliUninstall(
  entry: CatalogEntry,
): Promise<boolean> {
  const prompt = buildUninstallPrompt(entry);
  return writeToActiveSession(prompt + "\r");
}
