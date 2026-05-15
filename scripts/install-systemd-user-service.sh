#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="${SURFACE_SERVICE_NAME:-surface}"
SERVICE_FILE="${SERVICE_NAME}.service"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node || true)"
NPM_BIN="$(command -v npm || true)"

if [[ -z "${NODE_BIN}" ]]; then
  echo "node is required but was not found on PATH" >&2
  exit 1
fi

if [[ -z "${NPM_BIN}" ]]; then
  echo "npm is required but was not found on PATH" >&2
  exit 1
fi

mkdir -p "${HOME}/.config/systemd/user"

cat > "${HOME}/.config/systemd/user/${SERVICE_FILE}" <<EOF
[Unit]
Description=Surface local display service
After=network.target

[Service]
Type=simple
WorkingDirectory=${REPO_DIR}
Environment=NODE_ENV=production
Environment=SURFACE_BIND=127.0.0.1
Environment=SURFACE_URL=http://127.0.0.1:3000
ExecStart=${NPM_BIN} run service
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now "${SERVICE_FILE}"

echo "Installed and started ${SERVICE_FILE}"
echo "Status: systemctl --user status ${SERVICE_FILE}"
echo "Logs:   journalctl --user -u ${SERVICE_FILE} -f"
