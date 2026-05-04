#!/usr/bin/env bash
# One-shot wrapper around `clear-cloud-slate.mjs` that pulls dev creds
# from the macOS Keychain (under service `ai.pinkfish.openit`) instead
# of requiring a `test-config.json` on disk. Builds a temp config,
# runs the cleanup, and removes the config on exit — even on failure
# — so secrets don't sit in plaintext.
#
# Usage:
#   ./scripts/cleanup-cloud.sh              # interactive confirm
#   ./scripts/cleanup-cloud.sh --yes        # skip confirm
#   ./scripts/cleanup-cloud.sh --dry-run    # preview only
#
# Or via npm:
#   npm run cleanup-cloud -- --yes
#
# Requires the OpenIT desktop app to have been connected to a dev org
# at least once on this machine (that's what populates the Keychain
# entries). Run `npm run tauri dev` and walk through the Connect
# modal first if the script reports missing creds.

set -euo pipefail

SERVICE="ai.pinkfish.openit"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_PATH="$REPO_ROOT/test-config.json"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "✗ cleanup-cloud.sh uses the macOS Keychain — won't work on $(uname)." >&2
  echo "  Use \`npm run clear-cloud-slate\` with a hand-built test-config.json instead." >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "✗ jq not found in PATH. brew install jq." >&2
  exit 1
fi

read_keychain() {
  local account="$1"
  security find-generic-password -s "$SERVICE" -a "$account" -w 2>/dev/null || true
}

CID="$(read_keychain pinkfish.client_id)"
CSEC="$(read_keychain pinkfish.client_secret)"
ORG="$(read_keychain pinkfish.org_id)"
TURL="$(read_keychain pinkfish.token_url)"

if [[ -z "$CID" || -z "$CSEC" || -z "$ORG" || -z "$TURL" ]]; then
  echo "✗ missing Keychain creds under service '$SERVICE'." >&2
  echo "  Need: pinkfish.client_id, pinkfish.client_secret, pinkfish.org_id, pinkfish.token_url" >&2
  echo "  Run \`npm run tauri dev\` and connect to a dev org once to populate them." >&2
  exit 1
fi

# Always wipe the temp config — even if the cleanup script fails
# midway. Don't want secrets lingering on disk.
cleanup() {
  rm -f "$CONFIG_PATH"
}
trap cleanup EXIT INT TERM

WEB_URL="https://$(echo "$TURL" | awk -F/ '{print $3}' | sed 's/^app-api\.//')"
# WEB_URL is best-effort cosmetic (clear-cloud-slate doesn't actually
# read it). Fall back to a generic value if the parse goes sideways.
case "$WEB_URL" in
  https://*) ;;
  *) WEB_URL="https://app.pinkfish.ai" ;;
esac

jq -n \
  --arg repo "$HOME/OpenIT/local" \
  --arg orgId "$ORG" \
  --arg tokenUrl "$TURL" \
  --arg webUrl "$WEB_URL" \
  --arg cid "$CID" \
  --arg csec "$CSEC" \
  '{
    repo: $repo,
    orgId: $orgId,
    credentials: {
      tokenUrl: $tokenUrl,
      webUrl: $webUrl,
      clientId: $cid,
      clientSecret: $csec,
    },
  }' > "$CONFIG_PATH"

cd "$REPO_ROOT"
exec node scripts/clear-cloud-slate.mjs "$@"
