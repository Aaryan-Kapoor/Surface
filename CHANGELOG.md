# Changelog

All notable changes to Surface are recorded here.

## Unreleased

- New `surface upgrade`: one command that updates `surface-display` to the
  latest npm release (global installs; dev/local installs get advice instead),
  refreshes the canonical skill copy plus every recorded skill link, and
  restarts the service only when it is running an older version
  (health-gated). `--check` reports without changing anything;
  `surface service update`/`upgrade` redirect here.
- New `surface skill install`: keeps one canonical `SKILL.md` at
  `<data-dir>/skills/surface/` and links it (junction on Windows, managed copy
  where symlinks are forbidden) into `~/.agents/skills/` — the agentskills.io
  open standard read by Codex, Cursor, Gemini CLI, Copilot, Zed, Amp, Goose,
  OpenCode, Roo, Kilo, Windsurf — and `~/.claude/skills/` for Claude Code.
  `--to` adds harness-native dirs; targets are recorded in
  `install-state.json` and refreshed by `surface upgrade`. Never touches a
  skill directory containing files it doesn't own.
- `surface service health` now also flags a stale/missing skill copy, and the
  CLI prints an actionable "service unreachable — is it running?" hint (with
  the install one-liner) instead of a bare `fetch failed` when the service is
  down.
- SKILL.md two-way-loop addition: "state is a claim, not an animation" — never
  patch a status/progress/"running…" for work not actually executed or
  observed.
- INSTALL_FOR_AGENTS.md: skill installation and upgrading rewritten around the
  two new commands; per-harness skill directory list verified against vendor
  docs (2026-07).

## 0.2.2 - 2026-07-07

- Fixed Windows `surface service stop`/`uninstall` leaving the server
  running: Stop-ScheduledTask kills the conhost wrapper but orphans the node
  child, so the stop path now also reaps the node/conhost process still
  listening on the app port (never unrelated processes).
- `surface service install` now persists its resolved flags per service name
  (`~/.surface/services/<name>.json`); stop, uninstall, restart, status,
  health, and logs reuse them, so teardown of a custom-port install needs no
  repeated flags.
- npm publishing switched to tokenless trusted publishing (GitHub OIDC) and
  the CI service smoke now covers all three platforms, including a real
  systemd user manager on Linux runners via `loginctl enable-linger`.

## 0.2.1 - 2026-07-07

- Republished on top of current master: the npm README now carries the
  animated banner (absolute image URL so npmjs.com renders it) and the
  banner-era repo presentation. No code changes vs 0.2.0.

## 0.2.0 - 2026-07-07

- Replaced the static README hero with an animated banner
  (`video/readme-banner/`, a HyperFrames HTML composition rendered to GIF):
  Markdown → HTML → Surface told through /tdd, with the two-way loop drawn
  as pulses between the surface and the agent. Added a social-preview still
  and repo metadata to match.
- Renamed the npm package to `surface-display` (the CLI command stays
  `surface`) and made it self-contained: the server now ships as an esbuild
  bundle (`dist/server.mjs`, native deps external), so `npm install -g
  surface-display` is a complete install with no repo toolchain.
- Added `surface service install|uninstall|start|stop|restart|status|health|logs`
  with native per-user supervisors on all three platforms — systemd user unit
  (Linux), launchd LaunchAgent (macOS), Scheduled Task at logon (Windows).
  Installs are health-gated, refuse to clobber an unsupervised server on the
  port, and log to `~/.surface/logs/<name>.log` on every platform.
- Added `GET /healthz` (system plane), `SURFACE_LOG_FILE` / `--log-file`
  server-owned file logging, and server startup flags (`--port`,
  `--content-port`, `--bind`, `--data-dir`) for supervisors that cannot set
  environment variables.
- Added `surface version` / `--version`; `surface service health` warns when
  the CLI and the running service versions diverge after an upgrade.
- CI now smoke-tests the packed tarball's `service install` on Windows and
  macOS runners, and pushing a `vX.Y.Z` tag publishes to npm (with provenance)
  once the full matrix is green.
- Rewrote `INSTALL_FOR_AGENTS.md` around the cross-platform two-command
  bootstrap and made "never improvise a background server" an explicit rule;
  `scripts/install-systemd-user-service.sh` is now a thin wrapper over
  `surface service install`.
- Replaced `SKILL.md` with the benchmark-optimized skill (61 lines, ⅓ the size):
  matches the old skill on shape/primitive choice and hardens the wake-binding
  consent gate (100% hold rate under pressure vs 10% for the old wording).
- Removed the `report` built-in template and its docs.
- Fixed `surface wait --id <id> --event state_patch|stream_append`: state events
  carry the surface id as `id`, so the `--id` filter never matched and the wait
  hung forever; non-action event payloads now pass through un-enveloped and
  undeduplicated.

## 0.1.0 - 2026-07-02

- Added CI, aggregate tests, and community templates.
- Hardened loopback trust, bindings consent, outbound proxying, and artifact
  file serving.
- Added the built CLI package entrypoint, release metadata, and install docs
  for agent-first Surface setup.
