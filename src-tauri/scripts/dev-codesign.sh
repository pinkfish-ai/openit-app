#!/usr/bin/env bash
# Cargo runner: codesign the dev binary with a stable identity, then exec it.
# Without this, every `tauri dev` rebuild produces a fresh hash and macOS
# re-prompts for keychain access. Signing with an Apple Development cert
# (which carries a stable Team ID) makes the keychain partition ACL persist
# across rebuilds — self-signed certs don't work because they have no Team
# ID and the partition falls back to per-binary CDHash.
#
# We resolve the identity by SHA-1 hash so the codesign call works regardless
# of policy trust state.
set -euo pipefail

BIN="$1"; shift
IDENTITY="${OPENIT_DEV_SIGNING_IDENTITY:-Apple Development: Sankalp Gunturi (KYRSC6AHU2)}"

SHA1="$(security find-identity 2>/dev/null | awk -v id="\"$IDENTITY\"" 'index($0, id) { print $2; exit }')"

if [[ -n "$SHA1" ]]; then
  codesign --force --sign "$SHA1" "$BIN" >/dev/null 2>&1 || \
    echo "warning: codesign failed for '$BIN' (sha1=$SHA1)" >&2
else
  echo "note: signing identity '$IDENTITY' not found in keychain — running unsigned (keychain prompts will recur each rebuild). See src-tauri/scripts/README.md to set this up." >&2
fi

exec "$BIN" "$@"
