#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
ANDROID_DIR="$ROOT_DIR/android-client"
APK_SOURCE="$ANDROID_DIR/app/build/outputs/apk/debug/app-debug.apk"
APK_TARGET="$ROOT_DIR/temp_docs/apk/agentlink-debug.apk"
SERIAL="${ANDROID_SERIAL:-emulator-5554}"
APP_ID="im.agent.link"
MAIN_ACTIVITY="$APP_ID/.MainActivity"
HUB_PORT="${HUB_PORT:-8787}"
HUB_HTTP_URL="http://127.0.0.1:${HUB_PORT}"
LOG_DIR="$ROOT_DIR/temp_docs/android-selftest"
HUB_LOG="$LOG_DIR/hub.log"
SESSION_NAME="${SELFTEST_SESSION_NAME:-android-selftest}"
SESSION_WORKDIR="${SELFTEST_WORKDIR:-tests/android_selftest}"
SESSION_PROFILE=""
mkdir -p "$LOG_DIR" "$(dirname "$APK_TARGET")"

source "$HOME/.config/project-iris/android-env.sh"

cleanup() {
  if [[ -n "${HUB_PID:-}" ]]; then
    kill "$HUB_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "${SESSION_PROFILE:-}" ]]; then
    curl --fail --silent -X POST "$HUB_HTTP_URL/api/sessions/delete" \
      -H "content-type: application/json" \
      -d "{\"sessionName\":\"${SESSION_NAME}\"}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "[1/8] Build debug APK"
(cd "$ANDROID_DIR" && ./gradlew :app:assembleDebug >/dev/null)

echo "[2/8] Verify emulator availability"
adb -s "$SERIAL" get-state >/dev/null

echo "[3/8] Start temporary hub"
if curl --fail --silent "$HUB_HTTP_URL/healthz" >/dev/null 2>&1; then
  echo "Reusing existing hub on ${HUB_HTTP_URL}"
else
  (
    cd "$ROOT_DIR"
    HUB_PORT="$HUB_PORT" npm run dev:hub >"$HUB_LOG" 2>&1
  ) &
  HUB_PID=$!
  sleep 2
  curl --fail --silent "$HUB_HTTP_URL/healthz" >/dev/null
fi

echo "[4/8] Create temporary tmux-backed session"
SESSION_PROFILE="$(
  curl --fail --silent "$HUB_HTTP_URL/api/agent-profiles" \
    | jq -r '.profiles[].id' \
    | awk 'BEGIN { order["qwen"]=1; order["opencode"]=2; order["codex"]=3; order["copilot"]=4 } ($0 in order) { print order[$0], $0 }' \
    | sort -n \
    | awk 'NR == 1 { print $2 }'
)"

if [[ -z "$SESSION_PROFILE" ]]; then
  echo "No supported tmux-backed profile is available for Android self-test." >&2
  exit 1
fi

curl --fail --silent -X POST "$HUB_HTTP_URL/api/sessions" \
  -H "content-type: application/json" \
  -d "{\"sessionName\":\"${SESSION_NAME}\",\"profileId\":\"${SESSION_PROFILE}\",\"workdir\":\"${SESSION_WORKDIR}\"}" >/dev/null
sleep 3
curl --fail --silent "$HUB_HTTP_URL/api/bootstrap" | grep -q "\"agentId\":\"${SESSION_NAME}\""

echo "[5/8] Install APK on emulator"
adb -s "$SERIAL" install -r "$APK_SOURCE" >/dev/null

echo "[6/8] Launch app with adb reverse"
adb -s "$SERIAL" reverse "tcp:${HUB_PORT}" "tcp:${HUB_PORT}" >/dev/null
adb -s "$SERIAL" shell am force-stop "$APP_ID" >/dev/null 2>&1 || true
adb -s "$SERIAL" logcat -c
START_OUTPUT=""
for _attempt in 1 2 3; do
  START_OUTPUT="$(
    adb -s "$SERIAL" shell am start \
      -n "$MAIN_ACTIVITY" \
      --es debug_hub_origin "$HUB_HTTP_URL" \
      --ez debug_probe_enabled true \
      --es debug_probe_agent_id "$SESSION_NAME" \
      --es debug_probe_command status \
      --el debug_probe_delay_ms 1500 2>&1
  )"
  if ! grep -q "Error type 3" <<<"$START_OUTPUT"; then
    break
  fi
  sleep 1
done
if grep -q "Error type 3" <<<"$START_OUTPUT"; then
  printf '%s\n' "$START_OUTPUT" >&2
  exit 1
fi

echo "[7/8] Verify probe result from logcat"
sleep 4
PID="$(adb -s "$SERIAL" shell pidof "$APP_ID" | tr -d '\r')"
if [[ -n "$PID" ]]; then
  LOG_OUTPUT="$(adb -s "$SERIAL" logcat -d --pid="$PID")"
else
  LOG_OUTPUT="$(adb -s "$SERIAL" logcat -d)"
fi
printf '%s\n' "$LOG_OUTPUT" >"$LOG_DIR/app-logcat.txt"
printf '%s\n' "$LOG_OUTPUT" | grep -q "HTTP command accepted: status -> ${SESSION_NAME}"

echo "[8/8] Refresh deliverable APK"
cp "$APK_SOURCE" "$APK_TARGET"
stat --printf="APK refreshed: %n (%s bytes)\n" "$APK_TARGET"

echo "Android emulator self-test completed successfully."
