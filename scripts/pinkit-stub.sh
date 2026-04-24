#!/usr/bin/env bash
# Stub for the `pinkit` CLI used by OpenIT's Deploy button before the real
# CLI ships. Activated when OPENIT_PINKIT_STUB=1 is set and `pinkit` is not on PATH.
# Echoes a believable phased deploy and exits 0.
set -e

env="dev"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) env="$2"; shift 2;;
    *) shift;;
  esac
done

echo "▸ pinkit deploy --env $env (stub)"
sleep 0.2
echo "▸ resolving solution config..."
sleep 0.3
echo "▸ uploading workflows (3)..."
sleep 0.4
echo "▸ provisioning Slack app..."
sleep 0.4
echo "▸ wiring webhooks..."
sleep 0.3
echo "✔ deploy complete (stub)"
exit 0
