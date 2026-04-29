# OpenIT landing site

Static marketing + downloads page for OpenIT. Astro, no client JS, plain CSS.

## Run locally

```bash
cd landing
npm install
npm run dev
```

Site lives at http://localhost:4321.

## Build

```bash
npm run build
```

Static output lands in `landing/dist/`. Drop into any static host (Cloudflare
Pages, GitHub Pages once the repo is public, Vercel, S3, anything).

## Pages

- `/` — what OpenIT is, screenshot, download CTA.
- `/download` — Apple Silicon + Intel download buttons. Pulls the latest
  release tag from the GitHub API at build time. Includes the "first-time
  install on macOS" instructions for the unsigned v0.1.0 build.
- `/privacy` — privacy stub.
- `/terms` — terms stub.

## How the download links work

`src/lib/release.ts` fetches the latest release tag from
`https://api.github.com/repos/pinkfish-ai/openit-app/releases/latest` at build
time. If no release exists yet (404), it falls back to a "coming soon" state.

The tag determines the filenames it links to. Tauri produces:
- `OpenIT_<version>_aarch64.dmg`
- `OpenIT_<version>_x64.dmg`

If the file naming changes in the release workflow, update the helper.

## Deferred

There is no deploy workflow this round — review locally, decide a host later.
