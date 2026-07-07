#!/usr/bin/env bash
# Compatibility wrapper. The canonical, cross-platform installer is:
#   surface service install
# which writes the same systemd user unit on Linux (and a launchd agent on
# macOS, a Scheduled Task on Windows), then health-gates the start.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="${REPO_DIR}/dist/surface.mjs"

if [[ ! -f "${CLI}" ]]; then
  echo "dist/surface.mjs not found — run: npm install (the prepare hook builds it)" >&2
  exit 1
fi

exec node "${CLI}" service install ${SURFACE_SERVICE_NAME:+--name "${SURFACE_SERVICE_NAME}"} "$@"
