import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type FsChangedEvent = { paths: string[] };

export async function fsWatchStart(path: string): Promise<void> {
  await invoke("fs_watch_start", { path });
}

export async function fsWatchStop(): Promise<void> {
  await invoke("fs_watch_stop");
}

export async function onFsChanged(
  handler: (paths: string[]) => void,
): Promise<UnlistenFn> {
  return listen<FsChangedEvent>("fs://changed", (event) => {
    handler(event.payload.paths);
  });
}
