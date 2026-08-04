#!/usr/bin/env bash
# New-user end-to-end test.
#
# Boots a real systemd (Ubuntu 24.04) container with a fresh non-root user
# and walks the INSTALL_FOR_AGENTS.md path exactly as a new user's agent
# would: user-owned Node 24, no compiler toolchain, global-install of the
# packed tarball, `surface service install` against real systemd+logind,
# `surface skill install`, the doc's sanity checks, demo seeding, a first
# surface with live state, then restart + uninstall teardown.
#
# Complements scripts/test-fresh-install.sh (npm/prebuild layer, many Node
# versions) — this one owns the supervisor + skill + first-use layer.
#
# Usage: scripts/test-new-user-e2e.sh
set -euo pipefail

cd "$(dirname "$0")/.."

DOCKER=docker
if ! docker info >/dev/null 2>&1; then
  DOCKER="sudo docker"
  $DOCKER info >/dev/null
fi

tmp="$(mktemp -d)"
cid=""
cleanup() {
  [ -n "$cid" ] && $DOCKER rm -f "$cid" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT

tgz="$(npm pack --silent --pack-destination "$tmp")"
echo "packed $tgz"

$DOCKER build -t surface-new-user-e2e scripts/new-user-e2e

cid="$($DOCKER run -d --privileged \
  -v "$tmp/$tgz:/pkg/surface-display.tgz:ro" \
  -v "$PWD/scripts/new-user-e2e/user.sh:/user.sh:ro" \
  surface-new-user-e2e)"

# Wait for systemd to finish booting (degraded is fine in a container).
for _ in $(seq 1 30); do
  state="$($DOCKER exec "$cid" systemctl is-system-running 2>/dev/null || true)"
  case "$state" in running|degraded) break ;; esac
  sleep 1
done
case "$state" in
  running|degraded) echo "systemd is $state" ;;
  *) echo "systemd never came up (state: ${state:-none})" >&2; exit 1 ;;
esac

# A user-session bus is what `systemctl --user` needs; linger provides it
# without an interactive login, same as CI's service-smoke does.
$DOCKER exec "$cid" loginctl enable-linger newbie
uid="$($DOCKER exec "$cid" id -u newbie)"
for _ in $(seq 1 30); do
  $DOCKER exec "$cid" test -S "/run/user/$uid/bus" && break
  sleep 1
done
$DOCKER exec "$cid" test -S "/run/user/$uid/bus"

$DOCKER exec \
  -u newbie \
  -e "HOME=/home/newbie" \
  -e "XDG_RUNTIME_DIR=/run/user/$uid" \
  -e "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$uid/bus" \
  "$cid" bash /user.sh

echo "new-user e2e passed"
