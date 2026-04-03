#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
project_root="$(cd "$script_dir/../.." && pwd)"

if [[ -f "$HOME/.config/project-iris/android-env.sh" ]]; then
  # shellcheck source=/dev/null
  source "$HOME/.config/project-iris/android-env.sh"
fi

if [[ -z "${ANDROID_SDK_ROOT:-}" ]]; then
  echo "ANDROID_SDK_ROOT is not set. Load your Android SDK environment first." >&2
  exit 1
fi

xwayland_pid="$(pgrep -u "$USER" -n Xwayland || true)"
if [[ -z "$xwayland_pid" ]]; then
  echo "No Xwayland process found for the current user." >&2
  exit 1
fi

load_env_var() {
  local name="$1"
  tr '\0' '\n' < "/proc/$xwayland_pid/environ" | awk -F= -v key="$name" '$1 == key { print substr($0, index($0, "=") + 1) }' | tail -n 1
}

display_value="$(load_env_var DISPLAY)"
xauthority_value="$(load_env_var XAUTHORITY)"
wayland_value="$(load_env_var WAYLAND_DISPLAY)"
runtime_value="$(load_env_var XDG_RUNTIME_DIR)"
dbus_value="$(load_env_var DBUS_SESSION_BUS_ADDRESS)"

if [[ -z "$display_value" || -z "$xauthority_value" || -z "$runtime_value" || -z "$dbus_value" ]]; then
  echo "Failed to detect the active desktop session environment." >&2
  exit 1
fi

export DISPLAY="$display_value"
export XAUTHORITY="$xauthority_value"
export XDG_RUNTIME_DIR="$runtime_value"
export DBUS_SESSION_BUS_ADDRESS="$dbus_value"
if [[ -n "$wayland_value" ]]; then
  export WAYLAND_DISPLAY="$wayland_value"
fi

avd_name="${1:-project_iris_api35}"
if [[ $# -gt 0 ]]; then
  shift
fi

cd "$project_root"
exec "$ANDROID_SDK_ROOT/emulator/emulator" \
  -avd "$avd_name" \
  -qt-hide-window \
  -no-audio \
  -no-boot-anim \
  -gpu swiftshader_indirect \
  -accel on \
  -no-snapshot \
  -skip-adb-auth \
  "$@"
