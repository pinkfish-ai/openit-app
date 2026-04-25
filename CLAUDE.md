---
name: OpenIT
description: IT operations and service management plugin for Claude Code. Manage tickets, provision employees, query systems, and automate workflows.
---

On Connect, we sync: 
* Claude plugin with manifest here: https://dev20.pinkfish.dev/openit-plugin/manifest.json (or whichever env user has set in their connect details)
* databases (create 2 default dbs if none exist)
* filestores (create 1 defailt if none exist)
* knowledge bases (create 1 defailt if none exist)
* workflows
* agents

In each of these cases, we're looking for entities prefixed with "openit-"


# OpenIT

Tauri desktop wrapper for Claude Code, targeted at IT admins building Pinkfish ITSM solutions.

This is **scaffolding around Claude Code, not a forked IDE**. It launches a Claude Code session in an embedded terminal, plus a file explorer, file/results viewer, Versions drawer, and Deploy button. Everything OpenIT writes to disk is identical to what Claude Code in a regular terminal writes — users can graduate from OpenIT to a terminal at any time without changing the project.

See `auto-dev/plans/` for the implementation plan.

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
