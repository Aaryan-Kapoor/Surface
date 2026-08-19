#!/usr/bin/env bash
# Runs as the fresh non-root user inside the systemd container: the
# user install path from the README, top to bottom, then teardown.
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

# install-state.json is CLI bookkeeping now (skill_saved_to/skill_sha256,
# stamped by the skill sync) — nothing here creates or edits it by hand.
state="$HOME/.surface/install-state.json"

# Step 1 — CLI + service, exactly the user's commands.
# INSTALL_SPEC: the local tarball by default; an npm spec in canary mode.
INSTALL_SPEC="${INSTALL_SPEC:-/pkg/surface-display.tgz}"
if command -v surface; then echo "surface unexpectedly preinstalled" >&2; exit 1; fi
npm install -g "$INSTALL_SPEC"
surface --version
surface service install --timeout 90
# service install now links the skill itself — assert the machine is
# agent-ready before any explicit `surface skill install` runs.
test -f "$HOME/.agents/skills/surface/SKILL.md"
test -f "$HOME/.claude/skills/surface/SKILL.md"
surface service health
surface service status

# The service install linked the skill itself; assert the stamp it left,
# then re-run the explicit command to prove idempotence.
grep -q "name: surface" "$HOME/.claude/skills/surface/SKILL.md"
surface skill install
test -f "$HOME/.agents/skills/surface/SKILL.md"
test -f "$HOME/.claude/skills/surface/SKILL.md"
node -e '
  const fs = require("fs");
  const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (!s.skill_saved_to || !fs.existsSync(s.skill_saved_to)) {
    console.error("surface skill install did not stamp a valid skill_saved_to:", s.skill_saved_to);
    process.exit(1);
  }
' "$state"

# Sanity check block from INSTALL_FOR_AGENTS.md.
surface --version
surface service health
surface list
surface status
surface actions

# The tour itself is LLM-driven and can't run here; exercise its
# deterministic cleanup half.
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
