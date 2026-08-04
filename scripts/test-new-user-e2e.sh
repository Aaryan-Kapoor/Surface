#!/usr/bin/env bash
# New-user end-to-end test.
#
# Boots a real systemd (Ubuntu 24.04) container with a fresh non-root user
# and walks the INSTALL_FOR_AGENTS.md path exactly as a new user's agent
# would: user-owned Node 24, no compiler toolchain, global install,
# `surface service install` against real systemd+logind, `surface skill
# install`, the doc's sanity checks, demo seeding, a first surface with
# live state, then restart + uninstall teardown.
#
# Complements scripts/test-fresh-install.sh (npm/prebuild layer, many Node
# versions) — this one owns the supervisor + skill + first-use layer.
#
# Install source (same contract as test-fresh-install.sh):
#   (default)          npm-pack the local working tree
#   --tarball <path>   a prebuilt tarball (CI packs once, tests everywhere)
#   --npm              the published package — canary mode, catches
#                      ecosystem drift with zero commits in this repo
#   --spec <spec>      override the --npm spec (default surface-display@latest)
#
# Usage: scripts/test-new-user-e2e.sh [--tarball <path> | --npm [--spec <spec>]]
set -euo pipefail

cd "$(dirname "$0")/.."

mode=pack
tarball=""
spec="surface-display@latest"
while [ $# -gt 0 ]; do
  case "$1" in
    --tarball) mode=tarball; tarball="$2"; shift 2 ;;
    --npm) mode=npm; shift ;;
    --spec) spec="$2"; shift 2 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done

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

case "$mode" in
  pack)
    tgz="$(npm pack --silent --pack-destination "$tmp")"
    tarball="$tmp/$tgz"
    echo "packed $tgz"
    ;;
  tarball)
    tarball="$(realpath "$tarball")"
    echo "using tarball $tarball"
    ;;
  npm)
    echo "installing from npm: $spec"
    ;;
esac

$DOCKER build -t surface-new-user-e2e scripts/new-user-e2e

run_args=(-d --privileged -v "$PWD/scripts/new-user-e2e/user.sh:/user.sh:ro")
if [ "$mode" != npm ]; then
  run_args+=(-v "$tarball:/pkg/surface-display.tgz:ro")
fi
cid="$($DOCKER run "${run_args[@]}" surface-new-user-e2e)"

# Wait for systemd to finish booting (degraded is fine in a container).
state=""
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

exec_args=(
  -u newbie
  -e "HOME=/home/newbie"
  -e "XDG_RUNTIME_DIR=/run/user/$uid"
  -e "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$uid/bus"
)
if [ "$mode" = npm ]; then
  exec_args+=(-e "INSTALL_SPEC=$spec")
fi

$DOCKER exec "${exec_args[@]}" "$cid" bash /user.sh

echo "new-user e2e passed"
