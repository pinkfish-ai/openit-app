import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { ask } from "@tauri-apps/plugin-dialog";

export async function checkForUpdatesOnLaunch(): Promise<void> {
  try {
    const update = await check();
    if (!update) return;

    const userWantsUpdate = await ask(
      `OpenIT ${update.version} is available. Install now?\n\n${update.body ?? ""}`,
      { title: "Update available", kind: "info", okLabel: "Install + Relaunch", cancelLabel: "Later" },
    );
    if (!userWantsUpdate) return;

    await update.downloadAndInstall();
    await relaunch();
  } catch (err) {
    console.warn("[updater] check failed:", err);
  }
}
