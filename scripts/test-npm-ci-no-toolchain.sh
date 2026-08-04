#!/usr/bin/env bash
# Contributor-path install test: `npm ci` with no compiler toolchain.
#
# scripts/test-fresh-install.sh covers what a USER runs
# (`npm install -g surface-display`). This covers what a CONTRIBUTOR and CI
# run (`npm ci` against the lockfile) — and the two genuinely disagree:
# better-sqlite3 v13 installs fine via the global-tarball path (npm reaches
# its bundled Node-API prebuild) but compiles from source under `npm ci`,
# so it needs python + a C++ compiler. Every hosted runner and dev box has
# those, so that difference is invisible until it lands on a machine that
# doesn't — which is how it reached CI as a red Windows job.
#
# Runs the checked-out tree (via `git archive`, so no node_modules and no
# host writes) through `npm ci` inside toolchain-free node:<tag>-slim
# containers, then imports the native module and builds the bundles.
#
# Usage: scripts/test-npm-ci-no-toolchain.sh [node-tag ...]   default: 22 24
set -euo pipefail

cd "$(dirname "$0")/.."

if [ "$#" -gt 0 ]; then versions=("$@"); else versions=(22 24); fi

DOCKER=docker
if ! docker info >/dev/null 2>&1; then
  DOCKER="sudo docker"
  $DOCKER info >/dev/null
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# A clean tree at HEAD: no node_modules, no build output, nothing untracked.
git archive --format=tar HEAD > "$tmp/tree.tar"

cat >"$tmp/inner.sh" <<'INNER'
#!/usr/bin/env bash
set -euo pipefail
node -v
# The property under test: nothing here can compile a native module.
! command -v make
! command -v g++
! command -v python3
mkdir -p /app && tar -xf /src/tree.tar -C /app
cd /app
npm ci
node -e "const db=require('better-sqlite3')(':memory:'); db.exec('create table t(x)'); console.log('native module OK')"
node dist/surface.mjs --version
echo "NPM_CI_OK $(node -v)"
INNER

failed=()
for v in "${versions[@]}"; do
  echo "=== npm ci on node:${v}-slim (no toolchain) ==="
  if $DOCKER run --rm \
    -v "$tmp/tree.tar:/src/tree.tar:ro" \
    -v "$tmp/inner.sh:/inner.sh:ro" \
    "node:${v}-slim" bash /inner.sh; then
    echo "=== node:${v}-slim PASS ==="
  else
    echo "=== node:${v}-slim FAIL ===" >&2
    failed+=("$v")
  fi
done

if [ "${#failed[@]}" -gt 0 ]; then
  echo "npm ci needs a compiler on node: ${failed[*]} — a dependency lost its prebuilt binaries" >&2
  exit 1
fi
echo "npm ci is toolchain-free on: ${versions[*]}"
