#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

mkdir -p temp_docs

cleanup() {
  if [[ -n "${HUB_PID:-}" ]]; then
    kill "$HUB_PID" 2>/dev/null || true
  fi
  if [[ -n "${AGENT_PID:-}" ]]; then
    kill "$AGENT_PID" 2>/dev/null || true
  fi
}

trap cleanup EXIT

npm run dev:hub > temp_docs/demo-hub.log 2>&1 &
HUB_PID=$!

sleep 1

npm run dev:demo-agent > temp_docs/demo-agent.log 2>&1 &
AGENT_PID=$!

sleep 1

node scripts/demo/client.mjs
