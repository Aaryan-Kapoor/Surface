# Surface — Install For Agents

This file is the canonical bootstrap routine. Read it top to bottom on every install attempt; you may exit early if the state file says you're done.

Surface is a single-user, single-deployment local service. The agent contract is two files: `SKILL.md` (when/how to use the CLI) and `docs/TUTORIAL.md` (first-run user onboarding). There is no per-agent protocol — every agent shells out to `surface`.

## State: `~/.surface/install-state.json`

Install state lives outside the repo so the working tree stays clean:

```json
{
  "service": "pending",
  "skill_saved_to": null,
  "skill_sha256": null,
  "tutorial": "pending",
  "surface_version": null,
  "installed_at": null,
  "notes": null
}
```

- `service`: `pending | running | not_installed | failed` — is the Surface service reachable on `127.0.0.1:3000`?
- `skill_saved_to`: the canonical `SKILL.md` copy (stamped by `surface skill install`, which also records its links under `skill_links` and the hash of what it wrote under `skill_sha256` — never set these by hand; they are how upgrades tell their own stale copies from user edits).
- `tutorial`: `pending | in_progress | complete | skipped`.
- `surface_version`, `installed_at`: stamped on first complete install.
- `notes`: anything the next agent should know.

Read it first (`cat ~/.surface/install-state.json`); create it with the defaults above if missing. Update it as you progress.

(Older installs kept this state as YAML frontmatter at the top of this file. If you find such a block locally, move its values into `~/.surface/install-state.json` and discard the local file edit.)

## Early exit

If `service` is `"running"` and `skill_saved_to` points at a file that still exists and `tutorial` is `"complete"` or `"skipped"`, you are done. Skip to "Sanity check" at the bottom.

## Step 1 — Install the CLI and check the service

Both commands below are identical in bash and PowerShell on Linux, macOS, and
Windows. There is no per-platform install path.

```bash
surface service health || npm install -g surface-display
```

If `surface service health` exits 0: set `service: "running"` and continue to Step 2.

If the service is not healthy, ask the user before installing:

> I don't see a running Surface service. Want me to install and start it as a
> background service (systemd user unit on Linux, launchd agent on macOS,
> Scheduled Task on Windows)?

If yes:

```bash
surface service install
```

The install is health-gated: it registers the native supervisor, starts the
server, and succeeds only once `/healthz` answers and the content plane
accepts connections. On success set `service: "running"`. If it fails, it
prints the last log lines — set `service: "failed"` and `notes: <reason>` and
stop; surface the failure to the user.

**Never run the server yourself as a fallback** — no `npm run service`, no
hidden background process, no improvised daemon. An unsupervised server
doesn't survive reboot, is invisible to the user, and squats the ports so
every later `surface service install` fails its health gate. If
`surface service install` doesn't work on this machine, `failed` + stop is
the correct outcome.

Surface also binds a mandatory content listener on `SURFACE_CONTENT_PORT`
(default `3100`). If startup fails with a content-origin bind error, free that
port or pass `surface service install --content-port <n>`; it must differ
from the app port.

If the user declines: set `service: "not_installed"` and stop. Don't proceed without a running service.

> **Note (fresh-start schema, 2026-06):** the first boot of a current build archives any pre-existing database to `~/.surface/db.sqlite.bak` and starts clean. Surfaces from older versions are not migrated — re-link or re-create them (`surface sync` recreates anything a project declared in `.surface/`).

## Step 2 — Install SKILL.md into your skills directory

```bash
surface skill install
```

One command. It keeps a canonical copy at `<data-dir>/skills/surface/SKILL.md`
(the service's data dir: the one saved by `surface service install`, else
`SURFACE_DATA_DIR`, else `~/.surface`) and links it — directory symlink,
junction on Windows — into the two locations that cover almost every harness
(paths verified against vendor docs, 2026-07):

- `~/.agents/skills/surface/` — the neutral open standard (agentskills.io),
  read by Codex, Cursor, Gemini CLI, Copilot, Zed, Amp, Goose, OpenCode, Roo,
  Kilo, and Windsurf.
- `~/.claude/skills/surface/` — Claude Code (it does **not** read
  `~/.agents/`).

Because they are links to one canonical copy, `surface upgrade` refreshes the
skill everywhere at once. Where symlinks aren't permitted it falls back to
managed copies and records them, so upgrades rewrite those too. It stamps
`skill_saved_to` and `skill_links` in the state file for you — no manual
bookkeeping. Ownership rules: a skill directory containing anything besides a
`SKILL.md` is never touched; a directory holding only a *Surface* `SKILL.md`
(frontmatter `name: surface` — the legacy manual copies older instructions
created) is adopted and upgraded to a link; a lone non-Surface `SKILL.md` is
skipped; an existing symlink is only repointed when it is recorded as ours or
resolves to a Surface skill. A canonical copy the user edited is kept — and mirrored to every
link and managed copy — until `surface skill install --force` replaces it
with the packaged skill (`service health` reports it as `edited`).
Idempotent; re-run any time.

Your harness reads its own directory instead? Add it with `--to` (repeatable).
`--copy` / `--link` set copies-vs-links for the run's targets (the `--to`
dirs, or the two defaults when no `--to` is given); each target's mode is
remembered per target and kept by later runs and `surface upgrade`:

```bash
surface skill install --to ~/.cline/skills
```

Native global dirs, for reference — every non-Claude harness here also reads
`~/.agents/skills/`, so `--to` is rarely needed: Cursor
`~/.cursor/skills/`, Copilot (VS Code) `~/.copilot/skills/`, Gemini CLI
`~/.gemini/skills/`, Windsurf `~/.codeium/windsurf/skills/`, Cline
`~/.cline/skills/` (off by default — enable Settings → Features → Skills,
v3.48+), Roo Code `~/.roo/skills/`, Kilo Code `~/.kilo/skills/` (`.kilo`, not
`.kilocode`), OpenCode `~/.config/opencode/skills/`, Goose
`~/.config/goose/skills/`, Amp `~/.config/agents/skills/`. Project-scoped:
the repo-relative equivalents (`.agents/skills/`, `.claude/skills/`, …) via
`--to`.

No skills convention (e.g. Aider)? Append a one-line pointer to the canonical
copy in your agent's instructions file (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`,
`.github/copilot-instructions.md`, Aider's `CONVENTIONS.md`), record the path
in `notes`, and read `SKILL.md` from there on every session.

## Step 3 — Tutorial

Ask the user:

> Want me to walk you through Surface in five minutes? It covers creating content, hot reload from your project, and reacting to clicks.

If yes:

1. Set `tutorial: "in_progress"`.
2. Run `surface seed-demos` — links the bundled example surfaces from `examples/demos/` (or unhides them if a previous tour left them archived). Each row is tagged `metadata.demo = true` so it's identifiable.
3. Walk the user through `docs/TUTORIAL.md` step by step.
4. At the end, run `surface clear-demos` — flips `metadata.hidden = true` on every demo-tagged row so they vanish from the dashboard. The artifact records are kept; running `surface seed-demos` again revives them in place rather than re-creating. Set `tutorial: "complete"`.

If no:

- Don't seed demos. Set `tutorial: "skipped"`.
- If a previous interrupted run left demos behind, run `surface clear-demos` now to clean up.

The tutorial is the single best onboarding mechanism. Skipping is fine, but don't silently bypass it — confirm with the user.

Both `seed-demos` and `clear-demos` are idempotent — repeated calls are safe.

## Step 4 — Stamp the install

When everything above is green, finish the state file:

```json
{
  "service": "running",
  "skill_saved_to": "/abs/path/to/SKILL.md",
  "tutorial": "complete",
  "surface_version": "0.1.0",
  "installed_at": "2026-06-10T00:00:00Z",
  "notes": null
}
```

## Sanity check (always run)

```bash
surface --version        # CLI is on PATH
surface service health   # service reachable + content plane up (exit 0)
surface list             # API answers
surface status           # per-device display state
surface actions          # your inbox — drain it (see SKILL.md)
```

If `surface` is not on PATH: `npm install -g surface-display`. (Working from a
repo clone instead: `npm install && npm link` — the `prepare` hook builds
`dist/surface.mjs`.)

## What to use the CLI for

See `SKILL.md` — it is the contract. Quick reference:

- `surface ask <question> --options a,b --wait` — ask the user; answerable from any paired display.
- `surface link <abs-path>` — preferred for files in the user's project (`surface touch <id>` after editing).
- `surface doc <path>` / `surface video <url>` — markdown and video done right.
- `surface create <title> --content -` — ad-hoc HTML from stdin; `--template <name> --param k=v` for reusable UI.
- `surface set <id> <key> <value>` — live state; never rewrite HTML to change a number.
- `surface present <abs-path>` — one-shot snapshot of a PDF/image/markdown.
- `surface seed-demos` / `surface clear-demos` — tutorial-only example surfaces (clear hides; seed revives).
- `surface list`, `surface read`, `surface delete`, `surface open --on <device>`, `surface exec`, `surface actions`, `surface reply`, `surface notify`, `surface theme`, `surface stream`, `surface devices`.

## Operating rules

- Treat Surface as a system service. Don't start a second one; reuse the running instance.
- Ask the user before installing, enabling, restarting, or stopping the service.
- Before creating content, run `surface list` and reuse an existing artifact if one fits.
- For files in the agent's working directory, prefer `surface link` over `surface create`.
- Never auto-register wake bindings without the per-project consent recorded in `.surface/config.json` (see SKILL.md).
- Don't commit `.env` or `~/.surface/` contents.

## External agent gateway (optional)

Surface can fan out user actions to an external HTTP gateway. Two pieces:

1. **The gateway uses Surface** — point its tools at the `surface` CLI.
2. **Surface notifies the gateway** — set `SURFACE_WEBHOOK_URL`, `SURFACE_WEBHOOK_TOKEN`, optionally `SURFACE_WEBHOOK_PATH` in the service `.env`. Default path: `/hooks/agent`. Payload is structured JSON: `{ type: "surface_action", surface_id, surface_title, action, data, created_at }`. `OPENCLAW_GATEWAY_URL` / `OPENCLAW_HOOKS_TOKEN` are accepted as legacy aliases.

Per-surface webhooks (with retry) are usually better: `surface bind <id> --webhook <url>`.

## Upgrading

```bash
surface upgrade
```

One command, three legs: updates `surface-display` to the latest npm release
(global installs only — it detects and skips repo clones and project-local
installs with advice), refreshes the canonical `SKILL.md` plus every recorded
skill link/copy, and restarts the service if it is running an older version
(health-gated; a cleanly stopped service is left stopped). It is a converger —
safe to run any time, including to finish a manual `npm update -g` someone ran
without it. A skill target that can't be written is reported and skipped (exit
1 after everything else converges), never allowed to abort the run halfway. A
user-edited skill is kept, reported as `edited` — upgrade converges versions,
not opinions; only `surface skill install --force` replaces the edit.

`surface upgrade --check` reports without changing anything. `surface service
health` prints a note whenever the package, the running service, or the skill
copies drift — that note is your cue.

(Repo clone instead: `git pull && npm install && npm test`, then
`surface upgrade` — it skips the npm step but still converges skill and
service.)

Ask before restarting if the user has active work on the display.

## MCP (archived)

Surface previously shipped an MCP stdio adapter. It now lives in `archived/mcp.ts` for users with existing MCP-based agent configs (its SDK dependency is no longer installed by default — see `archived/README.md`). New installs use the CLI + `SKILL.md` path described here.
