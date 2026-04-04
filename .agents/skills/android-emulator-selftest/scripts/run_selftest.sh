#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
ANDROID_DIR="$ROOT_DIR/android-client"
APK_SOURCE="$ANDROID_DIR/app/build/outputs/apk/debug/app-debug.apk"
APK_TARGET="$ROOT_DIR/temp_docs/apk/personal-agent-im-debug.apk"
SERIAL="${ANDROID_SERIAL:-emulator-5554}"
APP_ID="im.agent.personal"
MAIN_ACTIVITY="$APP_ID/.MainActivity"
HUB_PORT="${HUB_PORT:-8787}"
HUB_HTTP_URL="http://127.0.0.1:${HUB_PORT}"
HUB_WS_URL="ws://127.0.0.1:${HUB_PORT}/ws"
LOG_DIR="$ROOT_DIR/temp_docs/android-selftest"
HUB_LOG="$LOG_DIR/hub.log"
AGENT_LOG="$LOG_DIR/demo-agent.log"
mkdir -p "$LOG_DIR" "$(dirname "$APK_TARGET")"

source "$HOME/.config/project-iris/android-env.sh"

cleanup() {
  if [[ -n "${AGENT_PID:-}" ]]; then
    kill "$AGENT_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "${HUB_PID:-}" ]]; then
    kill "$HUB_PID" >/dev/null 2>&1 || true
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

echo "[4/8] Start temporary demo agent"
(
  cd "$ROOT_DIR"
  HUB_URL="$HUB_WS_URL" npm run dev:demo-agent >"$AGENT_LOG" 2>&1
) &
AGENT_PID=$!
sleep 3
curl --fail --silent "$HUB_HTTP_URL/api/bootstrap" | grep -q '"agentId":"demo-agent"'

echo "[5/8] Install APK on emulator"
adb -s "$SERIAL" install -r "$APK_SOURCE" >/dev/null

echo "[6/8] Launch app with adb reverse"
adb -s "$SERIAL" reverse "tcp:${HUB_PORT}" "tcp:${HUB_PORT}" >/dev/null
adb -s "$SERIAL" shell am force-stop "$APP_ID" >/dev/null 2>&1 || true
adb -s "$SERIAL" logcat -c
adb -s "$SERIAL" shell am start \
  -n "$MAIN_ACTIVITY" \
  --es debug_hub_origin "$HUB_HTTP_URL" \
  --ez debug_probe_enabled true \
  --es debug_probe_agent_id demo-agent \
  --es debug_probe_command status \
  --el debug_probe_delay_ms 1500 >/dev/null

echo "[7/8] Verify probe result from logcat"
sleep 4
PID="$(adb -s "$SERIAL" shell pidof "$APP_ID" | tr -d '\r')"
if [[ -z "$PID" ]]; then
  echo "App process not found after launch" >&2
  exit 1
fi
LOG_OUTPUT="$(adb -s "$SERIAL" logcat -d --pid="$PID")"
printf '%s\n' "$LOG_OUTPUT" >"$LOG_DIR/app-logcat.txt"
printf '%s\n' "$LOG_OUTPUT" | grep -q "HTTP command accepted: status -> demo-agent"

echo "[8/8] Refresh deliverable APK"
cp "$APK_SOURCE" "$APK_TARGET"
stat --printf="APK refreshed: %n (%s bytes)\n" "$APK_TARGET"

echo "Android emulator self-test completed successfully."
