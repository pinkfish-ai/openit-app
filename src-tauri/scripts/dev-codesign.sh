#!/usr/bin/env bash
# Cargo runner: codesign the dev binary with a stable identity, then exec it.
# Without this, every `tauri dev` rebuild produces a fresh hash and macOS
# re-prompts for keychain access. A stable signing identity makes the
# keychain ACL persist across rebuilds.
#
# We sign by SHA-1 hash rather than name so this works even when the cert
# isn't trusted for the codesigning policy (self-signed certs aren't, by
# default — and we don't need policy trust for local signing).
set -euo pipefail

BIN="$1"; shift
IDENTITY="${OPENIT_DEV_SIGNING_IDENTITY:-OpenIT Dev}"

SHA1="$(security find-identity 2>/dev/null | awk -v id="\"$IDENTITY\"" '$0 ~ id { print $2; exit }')"

if [[ -n "$SHA1" ]]; then
  codesign --force --sign "$SHA1" "$BIN" >/dev/null 2>&1 || \
    echo "warning: codesign failed for '$BIN' (sha1=$SHA1)" >&2
else
  echo "note: signing identity '$IDENTITY' not found in keychain — running unsigned (keychain prompts will recur each rebuild). See src-tauri/scripts/README.md to set this up." >&2
fi

exec "$BIN" "$@"
