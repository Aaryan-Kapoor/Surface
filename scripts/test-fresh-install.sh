#!/usr/bin/env bash
# Fresh-install smoke test.
#
# A brand-new laptop is a machine with Node and nothing else: no python, no
# make, no g++. Dev machines and CI runners all carry compilers, which
# silently rescue a native dependency whose prebuilt binary is missing for
# the running Node version — the exact failure a real first-time user hits
# (better-sqlite3 11.x on Node 24 cost us every fresh install until 0.2.4).
#
# So: global-install Surface inside toolchain-free node:<version>-slim
# containers and drive the CLI against a booted server. Running
# dist/server.mjs directly (instead of `surface service install`) is
# deliberate — containers have no systemd, and the point here is the npm
# install + native module + CLI/server handshake, not the supervisor.
#
# What gets installed comes from one of three sources:
#   (default)          npm-pack the local working tree
#   --tarball <path>   a prebuilt tarball (CI packs once, tests everywhere)
#   --npm              the published package from the npm registry — this is
#                      the canary mode: it tests what users actually type,
#                      so it catches ecosystem drift (a new Node LTS, a
#                      yanked prebuild) with zero commits in this repo
#   --spec <spec>      override the --npm spec (default surface-display@latest)
#
# Remaining arguments are node image tags: 22, 24, 25, lts, current, ...
# (default: 22 24 25). Aliases like lts/current auto-track new Node releases.
#
# Usage: scripts/test-fresh-install.sh [--tarball <path> | --npm [--spec <spec>]] [tag ...]
set -euo pipefail

cd "$(dirname "$0")/.."

mode=pack
tarball=""
spec="surface-display@latest"
versions=()
while [ $# -gt 0 ]; do
  case "$1" in
    --tarball) mode=tarball; tarball="$2"; shift 2 ;;
    --npm) mode=npm; shift ;;
    --spec) spec="$2"; shift 2 ;;
    -*) echo "unknown flag $1" >&2; exit 2 ;;
    *) versions+=("$1"); shift ;;
  esac
done
[ "${#versions[@]}" -gt 0 ] || versions=(22 24 25)

DOCKER=docker
if ! docker info >/dev/null 2>&1; then
  DOCKER="sudo docker"
  $DOCKER info >/dev/null
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

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

cat >"$tmp/inner.sh" <<'INNER'
#!/usr/bin/env bash
set -euo pipefail
node -v
npm install -g "$INSTALL_SPEC"
surface --version
server="$(npm root -g)/surface-display/dist/server.mjs"
node "$server" >/tmp/surface.log 2>&1 &
server_pid=$!
ok=
for _ in $(seq 1 30); do
  if surface list >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
if [ -z "$ok" ]; then
  echo "server never answered 'surface list'" >&2
  tail -50 /tmp/surface.log >&2
  exit 1
fi
echo '<h1>fresh install smoke</h1>' | surface create "Fresh install smoke" --content - >/dev/null
surface list | grep -qi "fresh install smoke"
kill "$server_pid"
echo "FRESH_INSTALL_OK $(node -v)"
INNER

docker_args=(--rm -v "$tmp/inner.sh:/inner.sh:ro")
if [ "$mode" = npm ]; then
  docker_args+=(-e "INSTALL_SPEC=$spec")
else
  docker_args+=(-v "$tarball:/pkg/surface-display.tgz:ro" -e "INSTALL_SPEC=/pkg/surface-display.tgz")
fi

failed=()
for v in "${versions[@]}"; do
  echo "=== node:${v}-slim ==="
  if $DOCKER run "${docker_args[@]}" "node:${v}-slim" bash /inner.sh; then
    echo "=== node:${v}-slim PASS ==="
  else
    echo "=== node:${v}-slim FAIL ===" >&2
    failed+=("$v")
  fi
done

if [ "${#failed[@]}" -gt 0 ]; then
  echo "fresh-install smoke failed on node: ${failed[*]}" >&2
  exit 1
fi
echo "fresh-install smoke passed on: ${versions[*]}"
