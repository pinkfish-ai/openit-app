# OpenIT — CLAUDE.md

Tauri desktop wrapper for Claude Code targeting IT admins. Embeds xterm.js + portable-pty for the Claude chat pane, file explorer, file viewer, Versions drawer, and Deploy button.

## Stack

- **Tauri 2.x** (Rust shell) + **React** (frontend) + **Vite**
- **xterm.js** + **portable-pty** (embedded terminal)
- **keyring** (OS keychain) | **notify** (file watcher) | **git2** (versions)

## Quick Start

```bash
npm install
npm run tauri dev
```

## Structure

```
src/                    # React (Vite)
src-tauri/src/         # Tauri/Rust backend
auto-dev/plans/        # Design docs
```

## Key Files

- `src-tauri/src/main.rs` — Tauri app entry
- `src/App.tsx` — React root
- `src-tauri/src/pty.rs` — PTY + xterm bridge
- `src-tauri/src/commands.rs` — Tauri command handlers

## Design Plans

Read these in order:
1. `auto-dev/plans/2026-04-24-pin-5707-openit-onboarding-and-shell-plan.md` — Full architecture
2. `auto-dev/plans/2026-04-25-v1-five-core-it-tasks.md` — V1 ITSM features


## Dev Tips

- React hot-reloads automatically (edit `src/`)
- Rust recompiles on changes (edit `src-tauri/src/`)
- Debug in browser DevTools (`F12` in dev window)
- Check `which claude` before testing — app spawns Claude from PATH

## Conventions

- Follow `../web` patterns for React
- Run `cargo fmt` before committing Rust
- Conventional Commits: `feat(PIN-5707): description`
