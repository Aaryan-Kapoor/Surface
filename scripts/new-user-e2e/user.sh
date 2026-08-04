#!/usr/bin/env bash
# Runs as the fresh non-root user inside the systemd container: the
# INSTALL_FOR_AGENTS.md mechanical path, top to bottom, then teardown.
set -euxo pipefail

# Node, nvm-style: user-owned, on PATH — the layout a real laptop has.
mkdir -p "$HOME/.local"
tar -xJf /opt/node.tar.xz -C "$HOME/.local"
mv "$HOME"/.local/node-v* "$HOME/.local/node"
export PATH="$HOME/.local/node/bin:$PATH"
node -v
npm -v

# The property that makes this test honest: no toolchain to rescue a
# missing native prebuild.
! command -v make
! command -v g++

# Step 1 — CLI + service. surface isn't on PATH yet, so health must fail
# and the install path must be taken (mirrors the doc's ordering).
if command -v surface; then echo "surface unexpectedly preinstalled" >&2; exit 1; fi
npm install -g /pkg/surface-display.tgz
surface --version
surface service install --timeout 90
surface service health
surface service status

# Step 2 — skill install: canonical copy + both default link targets.
surface skill install
test -f "$HOME/.agents/skills/surface/SKILL.md"
test -f "$HOME/.claude/skills/surface/SKILL.md"
grep -q "name: surface" "$HOME/.claude/skills/surface/SKILL.md"

# Sanity check block from the doc.
surface --version
surface service health
surface list
surface status
surface actions

# Tutorial demo seeding (the deterministic half of Step 3).
surface seed-demos
surface clear-demos

# First real use: create a surface, confirm it lists, exercise state.
echo '<h1 data-surface-bind="msg">hello</h1>' | surface create "New user smoke" --id newuser-smoke --content -
surface list | grep -qi "New user smoke"
surface set newuser-smoke msg "it works"
surface state newuser-smoke | grep -q "it works"

# Service survives a restart and teardown leaves the machine clean.
surface service restart
surface service health
surface service uninstall
if surface service health; then
  echo "service still answering after uninstall" >&2
  exit 1
fi

echo NEW_USER_E2E_OK
