# OpenIT

Tauri desktop wrapper for Claude Code, targeted at IT admins building Pinkfish ITSM solutions.

This is **scaffolding around Claude Code, not a forked IDE**. It launches a Claude Code session in an embedded terminal, plus a file explorer, file/results viewer, Versions drawer, and Deploy button. Everything OpenIT writes to disk is identical to what Claude Code in a regular terminal writes — users can graduate from OpenIT to a terminal at any time without changing the project.

See `auto-dev/plans/` for the implementation plan.

## Status

- **M0 — PTY spike** *(this branch)*: embedded terminal via xterm.js + portable-pty, spawns `claude` if on PATH else the user's shell.
- **M1 — Shell**: three-pane layout, Versions, Deploy, prompt bubbles. Not yet started.
- **M2 — Onboarding**: three connect cards (Claude / Slack-or-Teams / Pinkfish). Not yet started.

## Prerequisites

- macOS (Windows + Linux supported by Tauri but not yet tested)
- Node.js 20+
- Rust stable (`rustup`)
- Xcode Command Line Tools on macOS (`xcode-select --install`)

## Develop

```bash
npm install
npm run tauri dev
```

The dev window opens with an embedded terminal. If `claude` is on your PATH, it launches automatically; otherwise it falls back to your shell.

## Build

```bash
npm run tauri build
```

Produces an unsigned `.app` / `.dmg` in `src-tauri/target/release/bundle/`. Code signing is tracked separately.
