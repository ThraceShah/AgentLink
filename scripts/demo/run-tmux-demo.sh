#!/bin/sh

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
LOG_DIR="$ROOT_DIR/temp_docs"
HUB_PORT="${HUB_PORT:-8787}"
SESSION_NAME="${TMUX_SESSION:-iris-demo-$$}"

mkdir -p "$LOG_DIR"

cleanup() {
  if [ -n "${TMUX_AGENT_PID:-}" ]; then
    kill "$TMUX_AGENT_PID" 2>/dev/null || true
  fi
  if [ -n "${HUB_PID:-}" ]; then
    kill "$HUB_PID" 2>/dev/null || true
  fi
  tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true
}

trap cleanup EXIT INT TERM

tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true

HUB_PORT="$HUB_PORT" npm run dev:hub >"$LOG_DIR/tmux-demo-hub.log" 2>&1 &
HUB_PID=$!
sleep 1

HUB_URL="ws://127.0.0.1:${HUB_PORT}/ws" \
TMUX_SESSION="$SESSION_NAME" \
TMUX_COMMAND="printf 'tmux demo ready\n'; printf 'Approve deployment? [y/N]\n'; read answer; printf 'approval=%s\n' \"\$answer\"" \
npm run dev:tmux-agent >"$LOG_DIR/tmux-demo-agent.log" 2>&1 &
TMUX_AGENT_PID=$!
sleep 1

DEMO_AGENT_ID="tmux-agent" node "$ROOT_DIR/scripts/demo/client.mjs"
