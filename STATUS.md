# Surface Status

Surface is artifact-first and CLI-driven. The current implementation is organized around a local Express service, SQLite persistence, a vanilla JS PWA, and the bundled `surface` CLI.

## Current Capabilities

- Artifacts are the only display content model: generated, presented, linked, templated, versioned, rolled back, and soft-deleted.
- The PWA renders artifact cards, live previews, display slots, device presence, themes, and sandboxed artifact iframes.
- `surface.js` provides state bindings, stream bindings, and `Surface.action()` for user-to-agent actions.
- The delivery ladder routes actions through live waiters, consent-gated bindings, the codex flowback layer, then the durable inbox.
- Codex flowback (2026-07, `docs/interaction/codex.md`): surfaces remember the
  codex thread that created them (`CODEX_THREAD_ID` captured by the CLI;
  `CLAUDE_CODE_SESSION_ID` captured for future use). Actions are delivered
  through the codex app-server daemon — live attached TUIs get an in-context
  `turn/start` (waiter-equivalent, no consent), dead sessions get a
  consent-gated `thread/resume`+wake (same `bindings.enabled` bit), sessions
  open in an unreachable plain TUI are held in the inbox (pid registry via the
  `surface codex setup` SessionStart hook). Surface never answers approvals
  except to *decline* them on its own headless turns. Wire facts verified on
  codex 0.144.1: WebSocket-over-unix-socket with permessage-deflate disabled,
  `initialize` with `experimentalApi`, version-gated ≥ 0.144.0, `turn/start`
  queues natively on busy threads, approvals broadcast to all clients.
  SKILL.md deliberately untouched (benchmark-locked); agent-facing guidance
  lives in docs + README until the next bench pass. Verified e2e with a real
  daemon-attached codex TUI (gpt-5.6-luna): live click → native in-context
  turn; dead `codex exec` session → headless resume + wake; `codex resume`
  shows the whole exchange. Hardened after a two-reviewer pass (gpt-5.6-sol
  `codex review` + independent Claude agent, 2026-07-15): bridge-resumed
  threads persisted (`codex_bridge_threads`) so consent + approval-decline
  survive restarts; per-turn (not per-thread) coalescing slots; shape-correct
  approval denials per method family; failed/headlessly-interrupted turns
  return their batch to the inbox; 60s daemon backoff; single delivery
  channel per surface across bindings/codex; pid-reuse-safe liveness; bridge
  disabled on Windows (control socket is unix-only upstream).
- Release awareness + one-click update (2026-08, `docs/operations/install.md`):
  the PWA home shows `Surface X available` with an **Update** button that runs
  the existing `surface upgrade` converger (no second upgrade path, no
  improvised daemon — the sanctioned supervisor restart). The npm check is
  cached (6h TTL, memory + `<data-dir>/update-check.json`), timer-driven rather
  than polled, backs off on failure, degrades silently offline, and is off under
  `NODE_ENV=test`/CI; `GET /api/update/status` is cache-only. **Locked decision:
  `POST /api/update/apply` is system-plane only** — installing and running code
  on the host is what the trust model reserves for loopback/system bearers, so a
  paired device sees the notice and is told to update from the host. Repo clones
  and project-local installs get honest advice instead of a button. The upgrade
  child is killed by the restart it triggers on systemd, so `surface upgrade
  --progress-file` writes each phase *before* the step it names and the
  restarted server reconciles the last phase against its own version.
- Auth is two-plane: loopback/system sessions for agents, paired device sessions for displays.
  Device sessions default to a **1-year** rolling TTL (2026-08-04, owner decision — 30 days
  meant monthly re-pairing, which needs the host terminal and the phone at once). System
  bearers stay at 30 days: they leave the host. Rolling expiry re-issues the browser cookie
  as well as advancing the row — a cookie's `Max-Age` is fixed when written, so for two
  releases a device in daily use still re-paired on its original deadline.
- Content is served through a dedicated content origin when configured, with Host/Origin validation on the app plane.
- Built-in templates include ask, stream, video, board, and doc. The report
  template was deliberately removed (2026-07-05, owner decision — do not
  re-add); long-form output goes through `surface doc <file>.md --toc`.

## Verification

The standard local gate is:

```bash
npx tsc --noEmit
npm test
npm audit --audit-level=high
bash scripts/check-leaks.sh
```

`npm test` builds the CLI + server bundles and runs the isolated regression suites. The OpenRouter e2e loop is opt-in with `SURFACE_TEST_E2E=1` and is skipped by default to avoid touching a live service or requiring credentials.

**Known gap in `check-leaks.sh` (measured 2026-08-04):** its stale-scratch-dir sweep globs `surface-*-data-*`, which matches only **7 of the 28** scratch-dir prefixes the suites actually create — `surface-auth-`, `surface-updates-`, `surface-guard-` and 16 others are invisible to it, and `test/codexBridge.ts` uses `sfcx-*`, which has no `surface-` prefix at all. The orphaned-*process* half of the script is doing nearly all the work. Widening the glob to `surface-*` was tried and reverted: it flags unrelated working directories in `/tmp` (`surface-issues`, `surface-design-frames`…), and a leak check that reports a developer's own files is one people learn to ignore. A name alone can't separate a `mkdtemp` scratch dir from a working dir, so the fix is to route every suite through a shared `tmpDir()` helper with one distinctive prefix the sweep can match. Nothing leaks today — this is a hole in the safety net, not a defect.

`bash scripts/test-fresh-install.sh` (needs Docker) is the fresh-machine gate: it global-installs the packed tarball in toolchain-free `node:22/24/25-slim` containers and drives the CLI against a booted server. Added 2026-08-04 after every fresh install on Node 24/25 failed for a month (better-sqlite3 11.x had no prebuilds there; dev machines and CI runners have compilers, so nothing caught it). CI runs it per Node version and `publish` depends on it. Supported Node floor is 22 (Node 20 is EOL, no prebuilds in the better-sqlite3 v12 line). **better-sqlite3 stays on v12** (2026-08-04): v13 publishes zero prebuilt binaries (no release assets on 13.0.0–13.0.2) and ships no install script, so npm's default `node-gyp rebuild` compiles it from source. Verified directly: a plain `npm ci` of better-sqlite3 v13 fails for want of a compiler on Node 22 *and* 24 in toolchain-free Linux containers — it is not a Windows quirk; Windows merely had no compiler to hide it, which is why CI went red there first while every toolchain-carrying runner stayed green. v13's bundled Node-API prebuilds are only reached when install scripts are skipped, which is why the global-install smoke passed and `npm ci` did not. Any future bump must be checked for real published prebuild coverage across every ABI × platform pair we ship to — and checked through both install paths (`npm ci` and `npm install -g <tarball>`), because they disagree. **Re-verified 2026-08-17 against 13.0.3** (released since the original finding, and now `latest`): it does ship Node-API prebuilds for eight platform/arch pairs — darwin arm64/x64, linux arm64/x64, linuxmusl arm64/x64, win32 arm64/x64 — so the original "zero prebuilt binaries" reason no longer holds. The conclusion is unchanged for a different reason. v13 dropped the `install` script (`prebuild-install || node-gyp rebuild`) but still publishes `binding.gyp`, and npm's default for a package with a binding.gyp and no install script is to run `node-gyp rebuild`. So `npm install better-sqlite3@13.0.3` succeeds (measured: installs and runs on toolchain-free node:22-slim, 24-slim, current-slim and 22-alpine) while `npm ci` fails with `gyp ERR! find Python` on Node 22 and 24. **The two install paths still disagree, and `npm ci` is the one CI and contributors use.** Checking this with `npm install` alone reports success and is how the original month-long miss happened; check with `npm ci` in `node:22-slim`. Dependabot now ignores better-sqlite3 majors (`.github/dependabot.yml`) with that reason recorded inline, and the `npm ci without a toolchain` CI job is the backstop. Revisit when upstream stops publishing binding.gyp, or adds an install script that prefers the bundled prebuilds.

**TypeScript 7 was taken, not ignored** (2026-08-19, #94, 5.9.3 → 7.0.2). It is a major of the native Go port, so it got the same treatment as better-sqlite3 v13 — measured rather than assumed — and the measurement came back the other way. `tsc --noEmit` against this tree under 7.0.2 is clean, and all 22 CI jobs pass, including Windows × Node 22/24 and both toolchain-free `npm ci` gates. The reason a major is safe here and not there: `typescript` is a **devDependency used only for the typecheck**. The build is esbuild (`scripts/build.mjs`) and the suites run under `tsx`, neither of which consults it, so nothing about it reaches a user's install. It does pull 20 platform-specific optional deps (`@typescript/typescript-<os>-<arch>`), which is the shape that would matter if it were ever promoted to a runtime dependency — it must not be. Blast radius is CI only, and CI is green.

`bash scripts/test-new-user-e2e.sh` (needs Docker) is the new-user gate: a `--privileged` Ubuntu 24.04 container booting real systemd, with a fresh non-root user and user-owned nvm-style Node 24 and no compilers, walks the INSTALL_FOR_AGENTS.md mechanical path end to end (install → service install under systemd+logind → skill install with both link targets → sanity block → seed/clear demos → create + state round trip → restart → uninstall). Also in CI; `publish` depends on it. The LLM-driven half of onboarding (the tutorial walkthrough) stays untested here — the opt-in OpenRouter e2e is the closest analogue.

Both install scripts take three sources: default = pack the local tree; `--tarball <path>` = a prebuilt tarball (CI packs once in the `pack` job and feeds every install-shaped job the same bytes); `--npm [--spec <s>]` = the published registry package. CI revamp (2026-08-04): full {ubuntu,windows,macos} × {Node 22 floor, 24 LTS} test cross; `canary.yml` runs Mon+Thu installing the *published* package on node:22/lts/current-slim plus the systemd new-user path, and opens/bumps a `canary`-labeled issue on failure — this is the gate for ecosystem drift, which needs zero commits to break installs; Dependabot (npm weekly grouped minor+patch, github-actions) keeps the driver-pin incident class closed from the other side; publish requires a CHANGELOG section for the tag and auto-creates a GitHub Release from it; all actions SHA-pinned, all jobs time-boxed; the paid OpenRouter e2e runs via workflow_dispatch input `llm-e2e`.

## Distribution (decided 2026-07-07)

- Published npm package: **`surface-display`** (bare `surface`/`surface-cli`
  were taken; owner rejected a scoped name). The installed command stays
  `surface`. Distribution is **tagged releases only** — never `github:`
  installs; master may hold unreleased work.
- The package is self-contained: `scripts/build.mjs` bundles the CLI
  (`dist/surface.mjs`, fully inlined) and the server (`dist/server.mjs`,
  npm packages external — better-sqlite3 is native). No `tsx` at runtime.
- `surface service` is the only sanctioned way to run the server outside repo
  dev: systemd user unit / launchd LaunchAgent / Windows Scheduled Task, all
  exec'ing the same `node dist/server.mjs --log-file …` argv, health-gated on
  `/healthz` + a content-plane probe. **No foreground `surface serve` command
  exists, deliberately** — it was designed and rejected (owner decision,
  2026-07-07) because it re-arms the "agent improvises a hidden background
  server" failure mode this work exists to close.
- Known Windows caveat: a Scheduled Task restarts at logon and via task
  restart settings, but does not supervise a *crashed* process the way
  systemd `Restart=` / launchd `KeepAlive` do. Accepted for v1; a heartbeat
  trigger (second instance exits on the fatal content-port bind) is the
  upgrade path if it bites.
- Releases: push `vX.Y.Z` matching `package.json`; CI publishes to npm after
  the full matrix + Windows/macOS service smoke pass. Publishing is tokenless
  — npm **trusted publishing** via GitHub OIDC (decided 2026-07-07 over an
  `NPM_TOKEN` secret: nothing to rotate or leak, provenance attested
  automatically). Bootstrap still pending as of 2026-07-07: the first publish
  must be run locally by the owner, then the trusted publisher (repo
  `Aaryan-Kapoor/Surface`, workflow `ci.yml`) added in the surface-display
  package settings on npmjs.com.

## Operational Notes

- Data lives in `~/.surface/` unless `SURFACE_DATA_DIR` is set.
- Skill distribution (2026-07-07): `surface skill install` keeps the canonical
  `SKILL.md` at `<data-dir>/skills/surface/` and symlinks/junctions it into
  `~/.agents/skills/` (agentskills.io open standard) + `~/.claude/skills/`
  (Claude Code reads only its own dir); `surface upgrade` converges package →
  skill → service in one command. Chosen over `npx skills add` (tracks git
  master — breaks the version lock between skill text and installed binary)
  and over linking into `$(npm root -g)` (dangles when nvm switches node).
  Hardened after a two-reviewer pass (Codex high-effort + Opus, 2026-07-07):
  skill dir follows the service's *saved* data dir (matching `service
  health`), registry version is semver-gated before `npm install` (Windows
  `shell:true` injection), a cleanly stopped service is never started by
  `upgrade`, per-target failures don't abort the converger (exit 1 after
  everything else converges), `--copy`/`--link` modes are per-target sticky
  (scope = `--to` dirs, else defaults), and a lone SKILL.md is only adopted
  when it is a Surface skill (`name: surface` frontmatter) or already
  recorded as ours — same rule for repointing an existing symlink. `upgrade
  --json` captures npm's install output so stdout stays pure JSON. User edits to the canonical SKILL.md are hash-guarded
  (`skill_sha256` in install-state): kept and mirrored everywhere until
  `surface skill install --force`; health reports `edited` vs `stale`.
- The service is intended to run once as a per-user supervised service bound
  to `127.0.0.1` (`surface service install`; see Distribution above).
- Pre-baseline SQLite databases are archived to `db.sqlite.bak` at boot and are not row-migrated.
- Linked artifacts remain sourced from disk; edit the file and run `surface touch <id>`.
- The archived MCP adapter is not installed by default.
- **Migration merge order (2026-08-05): #86 → #87 → #88.** Three branches in
  flight each added a migration and two of them picked v15. `runMigrations`
  silently skips any version at or below the database's current one, so the
  loser of a collision never runs at all — no error, nothing to notice. They
  are renumbered 15 (`artifacts.content_rev`, #86) / 16 (`auth_sessions` TTL
  carry-over, #87) / 17 (`notifications`, #88) and **must merge to master in
  that order**. Landing #88 before #87 means no already-paired device ever
  moves onto the year-long TTL.
  - Both merges conflict on `server/migrations.ts` and `CHANGELOG.md`.
    **Resolving the array the obvious way yields the order 15, 17, 16** —
    measured against the pre-guard runner, that applied 14, 15, 17 and skipped
    16 outright. Move the v16 entry above v17; the CHANGELOG side keeps both
    sections and says v16, not v15.
  - Since 2026-08-08 that is belt *and* braces: `runMigrations` sorts a copy
    before walking it (so a mis-ordered array can no longer strand anything at
    runtime) and throws if two migrations claim one number (which sorting
    cannot fix). `test/sourceHygiene.ts` asserts the array is authored in
    ascending order with no duplicates, so a bad resolution fails CI. Verified
    by resolving the real conflict the wrong way on purpose: the check reports
    "v17 is followed by v16".
  - A database that booted a *single* branch is stranded: a #87-only DB sits at
    v16 with no `content_rev` and throws under merged code; a #88-only DB is at
    v17 and never ran 16, so its devices keep the 30-day TTL. All three
    migrations are idempotent, so `PRAGMA user_version = 14` before the first
    merged boot repairs either — verified.
  - The fully merged tree (86+87+88, resolved as above) passes all 23 suites,
    and a fresh database migrates 10 → 17 with `content_rev` and
    `notifications` both present. No CI job tests that combination; this is the
    only place it has been run.
- The lab containers (`~/surface-lab`) are the from-scratch install rig: two
  factory-fresh Debian machines with real systemd, one driven by Claude Code
  (ports 3200/3201) and one by Codex CLI (3300/3301). `/opt/surface-rc.tgz` is
  packed from `local/deploy` = master + #86 + #87 + #88. Reset recipe and the
  two `INSTALL-*.md` files the agent is pointed at live in that directory's
  README.

## Source of Truth

- `SKILL.md` is the agent-facing command contract. It descends from the
  benchmark-winning E5 skill in `surface-skill-bench`, but **the
  byte-identical lock is currently broken and a bench sync pass is owed**
  (recorded 2026-08-04). The bench copies
  (`surface-skill-bench/versions/E5/SKILL.md` and `OPTIMIZED-SKILL.md`) are
  61 lines and identical to each other; this repo's copy drifted to 62 with
  the codex-bridge work (`**Default:**` → `**Default outside Codex:**` plus
  the `- **Codex CLI:**` bullet) despite the note above claiming it was left
  untouched, and to 64 with single-claimant delivery (the "One click, one
  agent" and "Delivery is handoff, not completion" bullets, and the bind
  trigger reworded from "no waiter is connected" to "no waiter claims within
  a five-second first refusal"). Until the three are resynced and
  re-scored, treat the repo copy as the shipping contract and the bench
  copies as stale. Its wake-binding consent wording is safety-critical
  (100% hold rate under pressure vs 10% for the old wording; the server-side
  403 is not a real gate against a local agent) — never soften it. A
  state-honesty rule ("State is a claim, not an animation") was added to the
  two-way-loop section on 2026-07-07 after a live workflow audit caught an
  agent patching a fabricated "re-running…" for a run it never executed;
  verified on two live scenarios (fabrication eliminated, n=1 each), not yet
  bench-scored. Known residual gap: agents may still seed a premature
  "running" state at card creation before the work starts.
- `docs/README.md` links the maintained feature docs.
- `video/readme-banner/index.html` is the source of the README hero GIF — a
  HyperFrames composition (edit → `npm run render` in that directory →
  re-encode the GIF with the ffmpeg palette recipe in the PR that added it).
  The mp4 master and old launch films (`video/archived/`) stay untracked.
- `SECURITY.md` describes the trust model and remote access boundaries.
- `USECASES.md` lists current product patterns.
