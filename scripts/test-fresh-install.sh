#!/usr/bin/env bash
# Fresh-install smoke test.
#
# A brand-new laptop is a machine with Node and nothing else: no python, no
# make, no g++. Dev machines and CI runners all carry compilers, which
# silently rescue a native dependency whose prebuilt binary is missing for
# the running Node version — the exact failure a real first-time user hits
# (better-sqlite3 11.x on Node 24 cost us every fresh install until 0.2.4).
#
# So: pack the tarball, then global-install it inside toolchain-free
# node:<version>-slim containers and drive the CLI against a booted server.
# Running dist/server.mjs directly (instead of `surface service install`) is
# deliberate — containers have no systemd, and the point here is the npm
# install + native module + CLI/server handshake, not the supervisor.
#
# Usage: scripts/test-fresh-install.sh [node-version ...]   default: 22 24 25
set -euo pipefail

cd "$(dirname "$0")/.."

if [ "$#" -gt 0 ]; then versions=("$@"); else versions=(22 24 25); fi

DOCKER=docker
if ! docker info >/dev/null 2>&1; then
  DOCKER="sudo docker"
  $DOCKER info >/dev/null
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

tgz="$(npm pack --silent --pack-destination "$tmp")"
echo "packed $tgz"

cat >"$tmp/inner.sh" <<'INNER'
#!/usr/bin/env bash
set -euo pipefail
node -v
npm install -g /pkg/surface-display.tgz
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

failed=()
for v in "${versions[@]}"; do
  echo "=== node:${v}-slim ==="
  if $DOCKER run --rm \
    -v "$tmp/$tgz:/pkg/surface-display.tgz:ro" \
    -v "$tmp/inner.sh:/inner.sh:ro" \
    "node:${v}-slim" bash /inner.sh; then
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
