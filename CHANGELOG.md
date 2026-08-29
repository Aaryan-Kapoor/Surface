# Changelog

All notable changes to Surface are recorded here.

## 0.2.5 - 2026-08-29

- **Fixed: the pairing page 404'd for anyone using a Node version manager.**
  `GET /pair` served `client/pair.html` with `res.sendFile` and no options.
  With no `root`, `send` applies its default `dotfiles: "ignore"` to *every*
  segment of the absolute path — including segments of the install location,
  which the request never chose. Node from nvm, fnm, volta or asdf lives under
  `~/.nvm`, `~/.fnm`, `~/.volta`, `~/.asdf`, so a global install put the file
  behind a dot segment and the route answered 404 with nothing missing and
  nothing unreadable. The URL `surface pair` prints is the only way to add a
  phone or a second screen, so for those users the feature did not exist.
  Broken in every release through 0.2.4. It survived because CI runners and
  containers install Node at `/usr/local`, which has no dot segment — every
  test environment was immune, and only a real version-manager install shows
  it. This is the same defect already fixed for artifact files under
  `~/.surface` (`SEND_FILE_OPTS`); the `/pair` route was missed.
- `test:source-hygiene` now asserts that every `res.sendFile` in `server/`
  passes a dotfiles option. A functional test cannot catch this without a
  dot-path install, so the call shape is asserted instead — which covers the
  next call site rather than only this one.

- **Test harness: a slow CI runner no longer looks like a broken server.**
  `waitForReady` had a fixed 15s boot budget and no way to tell a slow start
  from a dead process, so it failed release 0.2.4's master run on a healthy
  server while the identical job passed on the concurrent tag run and on every
  other platform. The budget is now 60s (`SURFACE_TEST_READY_TIMEOUT_MS`
  overrides), and it takes the child handle: a server that exits during boot is
  reported the instant it dies, with its exit code and stderr tail, rather than
  waiting out the clock. Measured on a deliberately fatal start — 322ms with
  the real reason, versus 15s of "did not become ready". Test-only; the
  published package contains no test files.

## 0.2.4 - 2026-08-19

- **Installing Surface is the user's job now, in every document.**
  `INSTALL_FOR_AGENTS.md` is no longer a bootstrap routine an agent executes —
  it is orientation for an agent landing on an installed machine: sanity
  check, tour routing, operating rules, skill placement for non-default
  harnesses. The agent-maintained half of `~/.surface/install-state.json`
  (`service`/`tutorial`/`installed_at`/`notes`) is dead; the file remains as
  the CLI's own skill-link bookkeeping. The README's "paste this to your
  agent" bootstrap block is gone — setup links the skill itself, so there is
  nothing to paste. The new-user e2e now walks the README's user path.

- **First run prints one address, not a manual.** The wizard's tail was the
  service-install detail block, a boxed pairing call-out, a five-line command
  list and a tour instruction — enough output that the thing the user actually
  needs (the display URL) was lost in it. It now confirms two lines, prints the
  display URL under "Open your display", and names `surface pair` and
  `surface --help` on one line each. The tour is not mentioned in the terminal
  at all: the display's own empty state already hands the user a copy-paste
  prompt for their agent, which is where that belongs. `surface service
  install --quiet` (new) is what the wizard uses to suppress the detail block;
  the standalone command is unchanged.
- **`surface` with no arguments is now the installer.** On an interactive
  terminal with no service installed, bare `surface` offers first-run setup —
  install the background service, link the agent skill — then points at
  `surface pair` and the tour. Non-TTY invocations and machines with a service
  keep getting plain help, so scripts never hang on a hidden prompt.
- **`surface service install` now links SKILL.md into the default agent skill
  dirs** (`~/.agents/skills`, `~/.claude/skills`) as part of a successful
  install, so one command leaves the machine agent-ready. A failed link is
  reported and never fails a healthy install; `--no-skill` opts out, and
  `surface skill install` remains for `--to`/`--copy`/`--force` control.
- **SKILL.md now routes "the Surface tour"**: a fresh agent that has only the
  skill knows to read `docs/TUTORIAL.md` from the installed package when the
  user asks for the Surface tour — scoped explicitly to *Surface's* tour so it
  never hijacks a request to tour the user's own project.

- **Removed `surface seed-demos`.** It duplicated the tour's job with the
  weaker medium: a gallery of static HTML renderings, which is exactly what
  Surface is not. The guided tour (`docs/TUTORIAL.md`) is the one showcase,
  and the bundled `examples/demos/` files keep their real home backing the
  empty-state idea portal on the display (served at `/demos/`).
  `surface clear-demos` stays — it is the tour's cleanup step.

- New update notification on the Surface home: when a newer `surface-display`
  release exists on npm, the grid header shows `Surface X available` with an
  **Update** button that runs the existing `surface upgrade` converger and
  brings the service back health-gated (`docs/operations/install.md`). The
  release check is cached (6h TTL, in memory + `<data-dir>/update-check.json`),
  runs on a self-rearming timer rather than a poll loop, backs off on failure
  instead of retrying, degrades silently offline, and is **off by default under
  `NODE_ENV=test` and in CI**. `GET /api/update/status` serves the cache only
  and never touches the network.
- `POST /api/update/apply` is **system-plane only** — installing and running new
  code on the host is exactly what the trust model reserves for loopback/system
  bearers. Paired devices and the content plane see the notice and are told
  where to update; they cannot press the button
  (`docs/auth/trust-model.md`, `SECURITY.md`).
- Repo clones and project-local installs are detected (by the same
  `installContext()` `surface upgrade` uses) and shown honest advice —
  `git pull …` / `npm update surface-display` — instead of a one-click button.
- Failures are reported, never assumed away: a failed `npm install` (a
  dependency with no prebuilds, a registry error) ends the run as `failed` with
  npm's exit status; a service that restarts without landing the new version
  reports "restarted but is still running X"; a run that stops reporting for ten
  minutes fails instead of spinning. The PWA gives up on a restart after two
  minutes and points at `surface service health`.
- `surface upgrade --progress-file <file>` writes each phase as it happens. The
  converger is killed by the very restart it triggers on systemd, so phases are
  written *before* the step they name and the restarted server reconciles the
  last one against the version it is now running.

- **Paired devices now last a year, and stop re-pairing while in use.** The
  device session TTL went from 30 days to 365. More importantly, rolling
  expiry only ever rolled the database row: the `surface_session` cookie
  carried a `Max-Age` fixed at pairing time, so a phone used every day still
  dropped its cookie on the original deadline and had to be re-paired from
  the host terminal. The auth middleware now re-issues the cookie whenever a
  session's deadline moves. Migration v16 carries already-paired devices onto
  the new TTL, so nobody has to re-pair *once* to stop re-pairing. System
  bearers deliberately keep the 30-day default — they get carried off the
  host, and are not sitting in front of the person who would notice them
  going missing.
- **Fixed fresh installs on current Node.** `npm install -g surface-display`
  failed on Node 24/25 (any machine without python/make/g++): better-sqlite3
  11.x has no prebuilt binaries there, so npm fell back to a node-gyp source
  build and died. better-sqlite3 is now ^12.11.1 — published prebuilds for
  ABI 127/137/141/147 (Node 22/24/25/26) across win32, darwin, linux and
  linuxmusl — and the supported Node floor is 22 (Node 20 is EOL and has no
  prebuilds in the v12 line). v13 was tried first and reverted: it publishes
  no prebuilt binaries at all and ships no install script, so npm's default
  `node-gyp rebuild` compiles it from source on any machine where install
  scripts run.
- New `scripts/test-fresh-install.sh` + CI job: global-installs the packed
  tarball in toolchain-free `node:*-slim` containers and drives the CLI
  against a booted server, so a missing native prebuild can never reach a
  release again. Publishing now depends on it.
- New `scripts/test-new-user-e2e.sh` + CI job: a real-systemd Ubuntu
  container with a fresh non-root user and user-owned Node 24 walks
  INSTALL_FOR_AGENTS.md end to end — tarball install, `surface service
  install`, `surface skill install` (both link targets verified), the
  sanity block, demo seed/clear, a first surface with live state, restart,
  uninstall. Publishing depends on this too.
- New `scripts/test-npm-ci-no-toolchain.sh` + CI job covering the
  *contributor* install path (`npm ci`) with no compiler present. It is a
  genuinely different path from the user one: v13 resolved to its bundled
  prebuild as a global tarball install but compiled from source under
  `npm ci`, and every runner and dev box has a toolchain to hide that.
- CI revamp: one packed tarball artifact feeds every install-shaped job;
  the test matrix is the full {ubuntu, windows, macos} × {Node 22, 24}
  cross; a scheduled canary installs the *published* package on
  node:22/lts/current and files an issue when it breaks (ecosystem drift
  needs no commit to break installs); Dependabot watches npm and actions;
  releases gain a CHANGELOG gate and an auto-created GitHub Release; all
  jobs have timeouts and SHA-pinned actions. The paid OpenRouter e2e is
  now runnable on demand via workflow_dispatch.
- Dashboard redesign (`docs/display/pwa.md`). The homepage is a grid of framed
  16:10 previews cropped from the top, with a left-aligned caption underneath —
  the circular portholes are gone; they cropped titles at both edges and threw
  away most of the screenshot. Header, search and filters collapse into a sticky
  60px bar plus a filter row that only offers filters with members. The shell
  now derives everything from two tokens (`--bg` / `--fg`, everything else via
  `color-mix`) and ships a real light scheme via `prefers-color-scheme`; agent
  themes map onto those tokens instead of unused legacy names.
- The in-surface topbar is a single 40px row (was ~56px of stacked title and
  screaming-caps meta): chevron back, title, kind · age · live, and copy-link /
  open-raw actions. Escape leaves the surface; under 760px the meta collapses so
  the title keeps the width.
- A surface with no capture yet wears a designed cover — a tinted field keyed to
  its id with the title set large — instead of a file-extension chip. The
  dashboard paints its own equivalent client-side (`has_thumb` on
  `GET /artifacts`) rather than fetching a placeholder it would replace seconds
  later.
- Thumbnails are ~50x faster to backfill (`docs/core/thumbnails.md`). Every
  capture used to spawn its own Chrome against a throwaway profile dir, paying a
  full cold start each time — ~30s per capture, so a fresh Surface sat on
  placeholders for minutes. The queue now holds one browser across a burst and
  drains it with three workers, each capture in its own throwaway browser
  context, and waits for load + fonts + two frames instead of a flat 6.5s sleep.
  Cold backfill of ten surfaces: ~300s -> ~9.6s. Tunable via
  `SURFACE_THUMB_SETTLE_MS` / `_CONCURRENCY` / `_TIMEOUT_MS` / `_IDLE_MS`.
- Grid performance: thumbnails load through an `IntersectionObserver`, cards use
  `content-visibility` and containment, previews declare their aspect ratio so
  nothing jumps as images land, and a versioned capture is now cached
  `immutable` instead of `max-age=60`. The starfield/nebula/comet substrate is
  retired (~180 hidden DOM nodes per grid render plus a mousemove listener), and
  the artifact shell no longer tries to pull Inter from Google Fonts — a display
  has to render offline.

## 0.2.3 - 2026-07-31

- New Codex flowback bridge (`docs/interaction/codex.md`): surfaces created
  from a Codex session remember their thread (`CODEX_THREAD_ID`, captured
  automatically by the CLI) and the delivery ladder gains a layer between
  bindings and the inbox — clicks land as native turns in the live Codex TUI
  via the codex app-server daemon, and consent-gated headless wakes revive
  dead threads in place (the exchange shows up in `codex resume`). One-time
  `surface codex setup` starts the daemon and installs a SessionStart hook;
  `surface codex status` reports both halves. Surface never grants approvals:
  requests on bridge-woken turns are declined shape-correctly per method,
  everything else is left to the user's own client. Failed (and headlessly
  interrupted) handling turns return their batch to the inbox. Windows: the
  layer is a clean no-op (the codex control socket is unix-only).
- Artifact creation now records the creating agent session
  (`CODEX_THREAD_ID`/`CLAUDE_CODE_SESSION_ID` from the shell env) and defaults
  the `metadata.agent` display label to `codex`/`claude` when `--agent` is not
  given — surfaces created by agents are now labeled without extra flags.

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
  `install-state.json` and refreshed by `surface upgrade`. `--copy`/`--link`
  set the mode for the run's targets and are remembered per target. Never
  touches a skill directory containing files it doesn't own; a lone
  non-Surface `SKILL.md` is skipped too (only legacy Surface copies are
  adopted).
- Upgrade/skill hardening (review findings): the registry-reported version is
  semver-validated before it reaches `npm install`; the canonical skill and
  `install-state.json` live in the service's saved data dir (matching
  `service health`), and state writes are atomic; one unwritable skill target
  no longer aborts `surface upgrade` halfway (reported, everything else still
  converges, exit 1); a cleanly stopped service is left stopped instead of
  being started by `upgrade`; an unrecorded `surface` symlink pointing at a
  non-Surface skill is skipped, never repointed; and `upgrade --json` keeps
  npm's install output off stdout so the report stays machine-parsable.
- User-edited skills are never clobbered: `install-state.json` records the
  hash of the `SKILL.md` Surface last wrote (`skill_sha256`), so upgrades can
  tell their own stale copies (converged as before) from local edits (kept,
  mirrored to every link/copy, reported as `edited` by `skill install`,
  `upgrade`, `--check`, and `service health`). `surface skill install
  --force` replaces an edit with the packaged skill.
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
