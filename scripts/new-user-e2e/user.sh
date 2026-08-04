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

# The install-state contract from INSTALL_FOR_AGENTS.md: create it with the
# documented defaults and walk its transitions like the doc tells agents to.
state="$HOME/.surface/install-state.json"
mkdir -p "$HOME/.surface"
cat >"$state" <<'JSON'
{
  "service": "pending",
  "skill_saved_to": null,
  "skill_sha256": null,
  "tutorial": "pending",
  "surface_version": null,
  "installed_at": null,
  "notes": null
}
JSON
set_state() {
  node -e '
    const fs = require("fs");
    const [file, key, value] = process.argv.slice(1);
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    s[key] = value;
    fs.writeFileSync(file, JSON.stringify(s, null, 2));
  ' "$state" "$1" "$2"
}

# Step 1 — CLI + service. surface isn't on PATH yet, so health must fail
# and the install path must be taken (mirrors the doc's ordering).
# INSTALL_SPEC: the local tarball by default; an npm spec in canary mode.
INSTALL_SPEC="${INSTALL_SPEC:-/pkg/surface-display.tgz}"
if command -v surface; then echo "surface unexpectedly preinstalled" >&2; exit 1; fi
npm install -g "$INSTALL_SPEC"
surface --version
surface service install --timeout 90
surface service health
surface service status
set_state service running

# Step 2 — skill install: canonical copy + both default link targets. The
# CLI stamps skill_saved_to/skill_sha256 in the state file itself (the doc
# says never to set those by hand) — assert it actually did.
surface skill install
test -f "$HOME/.agents/skills/surface/SKILL.md"
test -f "$HOME/.claude/skills/surface/SKILL.md"
grep -q "name: surface" "$HOME/.claude/skills/surface/SKILL.md"
node -e '
  const fs = require("fs");
  const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (!s.skill_saved_to || !fs.existsSync(s.skill_saved_to)) {
    console.error("surface skill install did not stamp a valid skill_saved_to:", s.skill_saved_to);
    process.exit(1);
  }
' "$state"

# Sanity check block from the doc.
surface --version
surface service health
surface list
surface status
surface actions

# Step 3 — tutorial. The walkthrough itself is LLM-driven and can't run
# here; exercise the deterministic half (seed/clear are idempotent) and
# record the documented "skipped" outcome.
surface seed-demos
surface clear-demos
set_state tutorial skipped

# Step 4 — stamp the install, then assert the doc's early-exit condition
# holds: a next agent reading this state file would correctly skip to the
# sanity check.
set_state surface_version "$(surface --version)"
set_state installed_at "$(date -Iseconds)"
node -e '
  const fs = require("fs");
  const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const done = s.service === "running"
    && s.skill_saved_to && fs.existsSync(s.skill_saved_to)
    && ["complete", "skipped"].includes(s.tutorial);
  if (!done) {
    console.error("early-exit condition not met after full install:", JSON.stringify(s, null, 2));
    process.exit(1);
  }
' "$state"

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
