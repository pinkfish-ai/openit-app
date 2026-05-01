// Auto-commit driver for server-managed entity directories.
//
// Why this exists: writes to `databases/{tickets,conversations,people}/`
// are operational bookkeeping, not deliberate human work the admin
// curates. They come from three sources:
//
//   1. The chat-intake server (`intake.rs::auto_commit_chat_turn`) —
//      asker turns, agent replies, ticket status flips.
//   2. The admin's Claude in the right pane following `/answer-ticket`
//      or similar skills — admin replies, ticket status flips, KB
//      article authoring (NOT covered here, see below).
//   3. The cloud sync engines pulling from Pinkfish — those already
//      auto-commit via their own `gitCommitPaths` calls.
//
// Source 1 commits inside the Rust handler. Source 3 commits inside
// the sync engines. Source 2 (and any other path that writes into
// these entity dirs without explicitly committing) was leaking into
// the Versions panel as untracked changes — making the admin curate
// their own Claude-driven operational work as if it were WIP.
//
// This driver listens to the Rust fs-watcher events, debounces, and
// runs `gitCommitPaths` on the affected paths. The Rust git layer
// already no-ops when nothing's staged (`git diff --cached --quiet`),
// so a duplicate commit attempt for a path source 1 already grabbed
// is harmless.
//
// Scope (paths whose writes auto-commit):
//   - `databases/tickets/<id>.json`
//   - `databases/conversations/<ticketId>/...` (whole subtree)
//   - `databases/people/<email>.json`
//   - `filestores/attachments/<ticketId>/...` (chat-intake uploads;
//     they're operational, paired one-to-one with conversation turns)
//
// Out of scope (admin curates manually):
//   - `agents/`, `workflows/` — entity definitions the admin authors.
//   - `knowledge-base/` — KB articles are admin work; capture step in
//     `/answer-ticket` is itself a deliberate write the admin
//     reviews.
//   - `filestores/library/` — admin-curated docs/scripts.
//   - `.openit/`, `.claude/`, `CLAUDE.md` — gitignored / admin
//     editing surface.

import { commitTouched } from "./syncEngine";
import { onFsChanged } from "./fsWatcher";

const DEBOUNCE_MS = 1500;
const COMMIT_MESSAGE = "intake: auto-commit ticket activity";

/// Predicate: does an absolute path live in one of the entity dirs we
/// auto-commit? Returns the relative pathspec we'd hand to
/// `git add` (e.g. "databases/tickets/abc.json"), or null if the
/// path is out of scope.
function pathSpecForAutoCommit(repo: string, abs: string): string | null {
  if (!abs.startsWith(`${repo}/`)) return null;
  const rel = abs.slice(repo.length + 1);
  // Skip cloud-sync conflict shadow files — those are not committed
  // through normal flow and would noise the auto-commit log.
  if (rel.includes(".server.")) return null;
  if (rel.startsWith("databases/tickets/") && rel.endsWith(".json")) {
    return rel;
  }
  if (rel.startsWith("databases/people/") && rel.endsWith(".json")) {
    return rel;
  }
  if (rel.startsWith("databases/conversations/")) {
    // Roll up to the per-thread directory so a burst of msg-*.json
    // writes inside one ticket coalesces into a single commit.
    const m = rel.match(/^databases\/conversations\/([^/]+)/);
    if (m) return `databases/conversations/${m[1]}`;
  }
  if (rel.startsWith("filestores/attachments/")) {
    // Same per-ticket roll-up: each attachment lives under
    // `filestores/attachments/<ticketId>/<filename>`. A drag of
    // multiple files coalesces into a single commit per thread.
    const m = rel.match(/^filestores\/attachments\/([^/]+)/);
    if (m) return `filestores/attachments/${m[1]}`;
  }
  return null;
}

let pendingPaths: Set<string> | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let unsubscribe: (() => void) | null = null;
let activeRepo: string | null = null;

async function flush(): Promise<void> {
  if (!pendingPaths || pendingPaths.size === 0 || !activeRepo) {
    pendingPaths = null;
    return;
  }
  const repo = activeRepo;
  const paths = Array.from(pendingPaths);
  pendingPaths = null;
  // Route through the engine's `commitTouched` rather than
  // `gitCommitPaths` directly. `commitTouched` serialises through
  // `withRepoLock(repo, "git")`, which the engine's pull/push
  // pipelines also hold when they auto-commit. Sharing the lock
  // prevents this driver and the engine from racing on
  // `.git/index.lock` — exactly the failure mode that surfaced
  // when PIN-5865 parallelised the per-class sync tasks and the
  // file-system writes started overlapping with autoCommit's
  // debounce flush. PIN-5865.
  await commitTouched(repo, paths, COMMIT_MESSAGE);
}

/// Start the auto-commit driver for `repo`. Idempotent — calling
/// again with a new repo tears down the previous subscription and
/// flushes any pending paths from the old repo.
export async function startAutoCommitDriver(repo: string): Promise<void> {
  await stopAutoCommitDriver();
  activeRepo = repo;
  unsubscribe = await onFsChanged((paths) => {
    if (!activeRepo) return;
    const matching: string[] = [];
    for (const p of paths) {
      const spec = pathSpecForAutoCommit(activeRepo, p);
      if (spec) matching.push(spec);
    }
    if (matching.length === 0) return;
    if (!pendingPaths) pendingPaths = new Set();
    for (const m of matching) pendingPaths.add(m);
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      void flush();
    }, DEBOUNCE_MS);
  });
}

/// Tear down the driver and flush any pending commit. Safe to call
/// when nothing is running.
export async function stopAutoCommitDriver(): Promise<void> {
  if (unsubscribe) {
    try {
      unsubscribe();
    } catch (e) {
      console.warn("[autoCommit] unsubscribe failed:", e);
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
