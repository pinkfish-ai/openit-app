// Mirror driver — keeps `.claude/skills/<name>/SKILL.md` and
// `.claude/scripts/<name>.<ext>` in sync with the source-of-truth copies
// under `filestores/skills/` and `filestores/scripts/`. (PIN-5829.)
//
// **Source of truth is the filestore copy.** Admins author skills /
// scripts via `/conversation-to-automation` or by editing files under
// `filestores/skills/` or `filestores/scripts/` directly. Those land in
// the cloud filestore, sync across devices, and are visible in the
// Pinkfish dashboard alongside library docs.
//
// To make Claude Code natively discover skills (slash-command
// autocomplete, lazy-load on `/foo` invoke) and scripts (`Bash`
// invocation by path), we mirror the filestore copy into `.claude/`.
// Mirror is **one-way**: edits to `.claude/skills/<name>/SKILL.md`
// directly are silently overwritten on the next sync. The CLAUDE.md
// docs spell this out for admins.
//
// Loop prevention: the mirror only fires for paths under
// `filestores/skills/` or `filestores/scripts/`. The `.claude/` writes
// it produces are explicitly NOT in scope, so writing them won't
// re-trigger the mirror via the fs-watcher.
//
// Architecture mirrors `autoCommitDriver.ts`: subscribe to fs changes,
// debounce, fan out to a per-path handler. One driver per repo.

import { invoke } from "@tauri-apps/api/core";
import { fsDelete, fsRead } from "./api";
import { onFsChanged } from "./fsWatcher";

const SKILLS_PREFIX = "filestores/skills/";
const SCRIPTS_PREFIX = "filestores/scripts/";
const DEBOUNCE_MS = 500;

type Action =
  | { kind: "skill-write"; slug: string }
  | { kind: "skill-delete"; slug: string }
  | { kind: "script-write"; filename: string }
  | { kind: "script-delete"; filename: string };

let activeRepo: string | null = null;
let unsubscribe: (() => void) | null = null;
let pendingActions: Map<string, Action> | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

/// Convert an absolute fs-watcher path to the action it triggers, or
/// null if the path is outside our scope. Returning null is the gate
/// that prevents `.claude/` writes from re-triggering the mirror.
function classifyPath(repo: string, abs: string): Action | null {
  if (!abs.startsWith(`${repo}/`)) return null;
  const rel = abs.slice(repo.length + 1);

  if (rel.startsWith(SKILLS_PREFIX)) {
    const tail = rel.slice(SKILLS_PREFIX.length);
    if (!tail.endsWith(".md") || tail.includes("/")) return null;
    const slug = tail.slice(0, -".md".length);
    if (!slug) return null;
    return { kind: "skill-write", slug };
  }

  if (rel.startsWith(SCRIPTS_PREFIX)) {
    const tail = rel.slice(SCRIPTS_PREFIX.length);
    if (!tail || tail.includes("/")) return null;
    return { kind: "script-write", filename: tail };
  }

  return null;
}

/// Mirror-action key — used to dedupe burst writes during the debounce
/// window. Skill key collisions across the .md path are handled by slug;
/// scripts key on the full filename (since extensions vary).
function actionKey(a: Action): string {
  if (a.kind === "skill-write" || a.kind === "skill-delete") {
    return `skill:${a.slug}`;
  }
  return `script:${a.filename}`;
}

/// Read the source filestore copy and write the `.claude/` mirror.
/// File-not-found on the source means the user deleted it — flip to the
/// matching delete action so the mirror is removed too.
async function applyAction(repo: string, action: Action): Promise<void> {
  if (action.kind === "skill-write") {
    const sourcePath = `${repo}/${SKILLS_PREFIX}${action.slug}.md`;
    let content: string;
    try {
      content = await fsRead(sourcePath);
    } catch {
      // Source vanished between fs-watcher fire and our read → treat
      // as delete. Falls into skill-delete branch.
      await applyAction(repo, { kind: "skill-delete", slug: action.slug });
      return;
    }
    try {
      await invoke("entity_write_file", {
        repo,
        subdir: `.claude/skills/${action.slug}`,
        filename: "SKILL.md",
        content,
      });
    } catch (e) {
      console.warn(`[skillMirror] write skill ${action.slug} failed:`, e);
    }
  } else if (action.kind === "skill-delete") {
    const target = `${repo}/.claude/skills/${action.slug}`;
    try {
      await fsDelete(target);
    } catch (e) {
      // Already gone, or never existed — non-fatal.
      console.log(`[skillMirror] skill delete ${action.slug} no-op:`, e);
    }
  } else if (action.kind === "script-write") {
    const sourcePath = `${repo}/${SCRIPTS_PREFIX}${action.filename}`;
    let content: string;
    try {
      content = await fsRead(sourcePath);
    } catch {
      await applyAction(repo, {
        kind: "script-delete",
        filename: action.filename,
      });
      return;
    }
    try {
      await invoke("entity_write_file", {
        repo,
        subdir: ".claude/scripts",
        filename: action.filename,
        content,
      });
    } catch (e) {
      console.warn(`[skillMirror] write script ${action.filename} failed:`, e);
    }
  } else if (action.kind === "script-delete") {
    const target = `${repo}/.claude/scripts/${action.filename}`;
    try {
      await fsDelete(target);
    } catch (e) {
      console.log(`[skillMirror] script delete ${action.filename} no-op:`, e);
    }
  }
}

async function flush(): Promise<void> {
  if (!pendingActions || pendingActions.size === 0 || !activeRepo) {
    pendingActions = null;
    return;
  }
  const repo = activeRepo;
  const actions = Array.from(pendingActions.values());
  pendingActions = null;
  for (const a of actions) {
    await applyAction(repo, a);
  }
  console.log(`[skillMirror] mirrored ${actions.length} change(s)`);
}

/// Start the mirror driver for `repo`. Idempotent — calling again with
/// a new repo tears down the previous subscription. Safe to call before
/// any source files exist; the driver just sits quiet until something
/// under `filestores/skills/` or `filestores/scripts/` changes.
export async function startSkillMirrorDriver(repo: string): Promise<void> {
  await stopSkillMirrorDriver();
  activeRepo = repo;
  unsubscribe = await onFsChanged((paths) => {
    if (!activeRepo) return;
    const queued: Action[] = [];
    for (const p of paths) {
      const action = classifyPath(activeRepo, p);
      if (action) queued.push(action);
    }
    if (queued.length === 0) return;
    if (!pendingActions) pendingActions = new Map();
    for (const a of queued) pendingActions.set(actionKey(a), a);
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      void flush();
    }, DEBOUNCE_MS);
  });
}

/// Tear down the driver. Flushes any pending mirror writes so a
/// shutdown mid-burst doesn't strand a `.claude/` copy out of sync.
export async function stopSkillMirrorDriver(): Promise<void> {
  if (unsubscribe) {
    try {
      unsubscribe();
    } catch (e) {
      console.warn("[skillMirror] unsubscribe failed:", e);
    }
    unsubscribe = null;
  }
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  await flush();
  activeRepo = null;
}

// Exported for tests.
export const __test = { classifyPath, actionKey };
