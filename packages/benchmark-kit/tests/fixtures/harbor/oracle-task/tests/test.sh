#!/usr/bin/env bash
set -euo pipefail
mkdir -p /logs/verifier
if [ -f /app/result.txt ] && [ "$(cat /app/result.txt)" = "42" ]; then
  echo '{"reward": 1.0}' > /logs/verifier/reward.json
  exit 0
else
  echo '{"reward": 0.0}' > /logs/verifier/reward.json
  exit 1
fi
