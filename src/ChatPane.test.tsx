import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

const ptyMock = vi.hoisted(() => ({
  ptySpawn: vi.fn().mockResolvedValue(undefined),
  ptyWrite: vi.fn().mockResolvedValue(undefined),
  ptyResize: vi.fn().mockResolvedValue(undefined),
  ptyKill: vi.fn().mockResolvedValue(undefined),
  onPtyData: vi.fn().mockResolvedValue(() => {}),
  onPtyExit: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("./lib/pty", () => ptyMock);

// xterm tries to render to a real DOM. jsdom doesn't implement enough of
// CanvasRenderingContext2D for it to fully initialize, but the addon and
// onData hooks still register before any rendering — which is what we test.
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    activate() {}
    dispose() {}
    fit() {}
  },
}));

import { ChatPane } from "./ChatPane";

describe("ChatPane", () => {
  beforeEach(() => {
    Object.values(ptyMock).forEach((fn) => fn.mockClear());
  });

  afterEach(() => {
    cleanup();
  });

  it("spawns a pty session on mount", async () => {
    render(<ChatPane />);
    // Spawning happens inside an async IIFE — flush microtasks
    await new Promise((r) => setTimeout(r, 0));
    expect(ptyMock.ptySpawn).toHaveBeenCalledTimes(1);
    const args = ptyMock.ptySpawn.mock.calls[0][0];
    expect(args.sessionId).toBe("main");
    expect(typeof args.cols).toBe("number");
    expect(typeof args.rows).toBe("number");
  });

  it("subscribes to pty data + exit events", async () => {
    render(<ChatPane />);
    await new Promise((r) => setTimeout(r, 0));
    expect(ptyMock.onPtyData).toHaveBeenCalledWith("main", expect.any(Function));
    expect(ptyMock.onPtyExit).toHaveBeenCalledWith("main", expect.any(Function));
  });

  it("forwards window resize to ptyResize", async () => {
    render(<ChatPane />);
    await new Promise((r) => setTimeout(r, 0));
    ptyMock.ptyResize.mockClear();
    window.dispatchEvent(new Event("resize"));
    await new Promise((r) => setTimeout(r, 0));
    expect(ptyMock.ptyResize).toHaveBeenCalledWith("main", expect.any(Number), expect.any(Number));
  });

  it("kills the pty session on unmount", async () => {
    const { unmount } = render(<ChatPane />);
    await new Promise((r) => setTimeout(r, 0));
    unmount();
    expect(ptyMock.ptyKill).toHaveBeenCalledWith("main");
  });
});
