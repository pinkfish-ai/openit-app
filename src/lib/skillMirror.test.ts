// PIN-5829 — skillMirror unit tests. We exercise the path-classifier
// (the gate that prevents `.claude/` writes from re-firing the mirror)
// and the round-trip behaviors via mocked fs primitives.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
vi.mock("./api", () => ({
  fsRead: vi.fn(),
  fsDelete: vi.fn(),
}));
vi.mock("./fsWatcher", () => ({
  onFsChanged: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { fsRead, fsDelete } from "./api";
import { onFsChanged } from "./fsWatcher";
import {
  __test,
  startSkillMirrorDriver,
  stopSkillMirrorDriver,
} from "./skillMirror";

const mockInvoke = vi.mocked(invoke);
const mockFsRead = vi.mocked(fsRead);
const mockFsDelete = vi.mocked(fsDelete);
const mockOnFsChanged = vi.mocked(onFsChanged);

describe("isNotFoundError", () => {
  it("returns true for Unix ENOENT messages", () => {
    expect(
      __test.isNotFoundError(
        new Error("No such file or directory (os error 2)"),
      ),
    ).toBe(true);
  });

  it("returns true for Windows not-found messages", () => {
    expect(
      __test.isNotFoundError(
        new Error("The system cannot find the file specified."),
      ),
    ).toBe(true);
  });

  it("returns false for permission / IO errors", () => {
    expect(
      __test.isNotFoundError(new Error("Permission denied (os error 13)")),
    ).toBe(false);
    expect(__test.isNotFoundError(new Error("Resource busy"))).toBe(false);
  });

  it("returns false for arbitrary string errors that don't match", () => {
    expect(__test.isNotFoundError("network unreachable")).toBe(false);
  });
});

describe("classifyPath — the loop-prevention gate", () => {
  const repo = "/repo";

  it("classifies a skill write", () => {
    expect(__test.classifyPath(repo, "/repo/filestores/skills/foo.md")).toEqual({
      kind: "skill-write",
      slug: "foo",
    });
  });

  it("classifies a script write (any extension)", () => {
    expect(
      __test.classifyPath(repo, "/repo/filestores/scripts/bar.mjs"),
    ).toEqual({ kind: "script-write", filename: "bar.mjs" });
    expect(__test.classifyPath(repo, "/repo/filestores/scripts/baz.sh")).toEqual(
      { kind: "script-write", filename: "baz.sh" },
    );
  });

  it("ignores `.claude/` writes — the loop guard", () => {
    expect(
      __test.classifyPath(repo, "/repo/.claude/skills/foo/SKILL.md"),
    ).toBeNull();
    expect(
      __test.classifyPath(repo, "/repo/.claude/scripts/bar.mjs"),
    ).toBeNull();
  });

  it("ignores other filestore subdirs (library, attachments)", () => {
    expect(
      __test.classifyPath(repo, "/repo/filestores/library/notes.md"),
    ).toBeNull();
    expect(
      __test.classifyPath(repo, "/repo/filestores/attachments/img.png"),
    ).toBeNull();
  });

  it("ignores nested files inside a skill subdir (skills are flat)", () => {
    expect(
      __test.classifyPath(repo, "/repo/filestores/skills/foo/inner.md"),
    ).toBeNull();
  });

  it("ignores non-md files in skills/", () => {
    expect(
      __test.classifyPath(repo, "/repo/filestores/skills/foo.txt"),
    ).toBeNull();
  });

  it("ignores paths outside the repo", () => {
    expect(
      __test.classifyPath(repo, "/other-repo/filestores/skills/foo.md"),
    ).toBeNull();
  });

  it("ignores empty slug", () => {
    expect(
      __test.classifyPath(repo, "/repo/filestores/skills/.md"),
    ).toBeNull();
  });
});

describe("startSkillMirrorDriver — end-to-end behavior", () => {
  let fsHandler: ((paths: string[]) => void) | null = null;
  let unsubFn: () => void = () => {};

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    unsubFn = vi.fn();
    mockOnFsChanged.mockImplementation(async (handler) => {
      fsHandler = handler;
      return unsubFn;
    });
    mockInvoke.mockResolvedValue(undefined);
    mockFsDelete.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await stopSkillMirrorDriver();
  });

  it("writes a skill mirror with the source content", async () => {
    mockFsRead.mockResolvedValue("---\nname: foo\n---\n# foo\n");
    await startSkillMirrorDriver("/repo");
    expect(fsHandler).toBeTruthy();
    fsHandler!(["/repo/filestores/skills/foo.md"]);
    await vi.advanceTimersByTimeAsync(600);

    expect(mockInvoke).toHaveBeenCalledWith(
      "entity_write_file",
      expect.objectContaining({
        repo: "/repo",
        subdir: ".claude/skills/foo",
        filename: "SKILL.md",
        content: "---\nname: foo\n---\n# foo\n",
      }),
    );
  });

  it("writes a script mirror as a literal copy", async () => {
    mockFsRead.mockResolvedValue("#!/usr/bin/env node\nconsole.log('hi')\n");
    await startSkillMirrorDriver("/repo");
    fsHandler!(["/repo/filestores/scripts/hello.mjs"]);
    await vi.advanceTimersByTimeAsync(600);

    expect(mockInvoke).toHaveBeenCalledWith(
      "entity_write_file",
      expect.objectContaining({
        repo: "/repo",
        subdir: ".claude/scripts",
        filename: "hello.mjs",
        content: "#!/usr/bin/env node\nconsole.log('hi')\n",
      }),
    );
  });

  it("falls back to delete when the source vanished mid-debounce (NotFound)", async () => {
    // Source file no longer exists by the time the mirror reads it
    // (e.g. user deleted it before the debounce flushed). The Rust
    // `fs_read` wraps `std::io::Error::to_string()` which says "No such
    // file or directory (os error 2)" on Unix.
    mockFsRead.mockRejectedValue(
      new Error("No such file or directory (os error 2)"),
    );
    await startSkillMirrorDriver("/repo");
    fsHandler!(["/repo/filestores/skills/gone.md"]);
    await vi.advanceTimersByTimeAsync(600);

    expect(mockFsDelete).toHaveBeenCalledWith("/repo/.claude/skills/gone");
    // No write should have landed.
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("does NOT delete the mirror on a transient (non-NotFound) read error", async () => {
    // A permission flip, file lock, or EIO should NOT propagate as a
    // delete — the mirror is still valid, we just couldn't refresh it
    // this tick. Next successful read picks up the change.
    mockFsRead.mockRejectedValue(
      new Error("Permission denied (os error 13)"),
    );
    await startSkillMirrorDriver("/repo");
    fsHandler!(["/repo/filestores/skills/foo.md"]);
    await vi.advanceTimersByTimeAsync(600);

    expect(mockFsDelete).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("ignores `.claude/` writes (no re-fire on mirror's own output)", async () => {
    mockFsRead.mockResolvedValue("anything");
    await startSkillMirrorDriver("/repo");
    fsHandler!([
      "/repo/.claude/skills/foo/SKILL.md",
      "/repo/.claude/scripts/bar.mjs",
    ]);
    await vi.advanceTimersByTimeAsync(600);

    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockFsRead).not.toHaveBeenCalled();
  });

  it("dedupes burst writes during the debounce window (one write per slug)", async () => {
    mockFsRead.mockResolvedValue("body");
    await startSkillMirrorDriver("/repo");
    // Three rapid writes to the same skill.
    fsHandler!(["/repo/filestores/skills/foo.md"]);
    fsHandler!(["/repo/filestores/skills/foo.md"]);
    fsHandler!(["/repo/filestores/skills/foo.md"]);
    await vi.advanceTimersByTimeAsync(600);

    const writeCalls = mockInvoke.mock.calls.filter(
      ([cmd]) => cmd === "entity_write_file",
    );
    expect(writeCalls).toHaveLength(1);
  });
});

