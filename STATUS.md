# Surface Status

Surface is artifact-first and CLI-driven. The current implementation is organized around a local Express service, SQLite persistence, a vanilla JS PWA, and the bundled `surface` CLI.

## Current Capabilities

- Artifacts are the only display content model: generated, presented, linked, templated, versioned, rolled back, and soft-deleted.
- The PWA renders artifact cards, live previews, display slots, device presence, themes, and sandboxed artifact iframes.
- `surface.js` provides state bindings, stream bindings, and `Surface.action()` for user-to-agent actions.
- The delivery ladder routes actions through live waiters, consent-gated bindings, then the durable inbox.
- Auth is two-plane: loopback/system sessions for agents, paired device sessions for displays.
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

## Source of Truth

- `SKILL.md` is the agent-facing command contract. It is the benchmark-winning
  E5 skill from `surface-skill-bench` (61 lines; kept byte-identical with
  `surface-skill-bench/versions/E5/SKILL.md` and `OPTIMIZED-SKILL.md` — edit
  one, sync all three). Its wake-binding consent wording is safety-critical
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
