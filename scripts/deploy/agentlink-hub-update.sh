#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

IMAGE_NAME="${IMAGE_NAME:-agentlink-hub:latest}"
CONTAINER_NAME="${CONTAINER_NAME:-agentlink-hub}"
SERVICE_NAME="${SERVICE_NAME:-agentlink-hub.service}"
HUB_PORT="${HUB_PORT:-8787}"
HUB_HOST="${HUB_HOST:-0.0.0.0}"
SESSION_WORKDIR_ROOT_RELATIVE="${SESSION_WORKDIR_ROOT_RELATIVE:-code}"
RUN_USER="${RUN_USER:-$(id -un)}"
RUN_GROUP="${RUN_GROUP:-$(id -gn)}"
RUN_UID="${RUN_UID:-$(id -u)}"
RUN_GID="${RUN_GID:-$(id -g)}"
RUN_HOME="${RUN_HOME:-${HOME}}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
SERVICE_PATH="${SYSTEMD_DIR}/${SERVICE_NAME}"
UNIT_SOURCE="${PROJECT_ROOT}/deploy/${SERVICE_NAME}"

require_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "error: this script must run as root because it installs a system service and talks to Docker" >&2
    echo "hint: sudo $0" >&2
    exit 1
  fi
}

render_unit() {
  sed \
    -e "s|__RUN_UID__|${RUN_UID}|g" \
    -e "s|__RUN_GID__|${RUN_GID}|g" \
    -e "s|__RUN_HOME__|${RUN_HOME}|g" \
    -e "s|__RUN_USER__|${RUN_USER}|g" \
    -e "s|__HUB_HOST__|${HUB_HOST}|g" \
    -e "s|__HUB_PORT__|${HUB_PORT}|g" \
    -e "s|__SESSION_WORKDIR_ROOT_RELATIVE__|${SESSION_WORKDIR_ROOT_RELATIVE}|g" \
    -e "s|__PROJECT_ROOT__|${PROJECT_ROOT}|g" \
    -e "s|__IMAGE_NAME__|${IMAGE_NAME}|g" \
    "${UNIT_SOURCE}"
}

wait_for_healthz() {
  local attempt
  for attempt in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:${HUB_PORT}/healthz" >/tmp/agentlink-hub-healthz.json; then
      cat /tmp/agentlink-hub-healthz.json
      echo
      return 0
    fi
    sleep 1
  done

  echo "error: Hub did not become healthy on port ${HUB_PORT}" >&2
  systemctl --no-pager --full status "${SERVICE_NAME}" >&2 || true
  docker logs "${CONTAINER_NAME}" >&2 || true
  return 1
}

require_root

cd "${PROJECT_ROOT}"
mkdir -p data
chown "${RUN_UID}:${RUN_GID}" data

echo "Building ${IMAGE_NAME}"
docker build -f Dockerfile.hub -t "${IMAGE_NAME}" .

echo "Installing ${SERVICE_NAME}"
render_unit > "${SERVICE_PATH}"
chmod 0644 "${SERVICE_PATH}"

echo "Restarting ${SERVICE_NAME}"
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"

echo "Checking Hub health"
wait_for_healthz

echo "Hub service is running: ${SERVICE_NAME}"
