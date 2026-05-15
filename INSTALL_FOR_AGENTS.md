---
install_state:
  service: pending          # pending | running | not_installed | failed
  skill_saved_to: null      # absolute path where SKILL.md was copied, or null
  tutorial: pending         # pending | in_progress | complete | skipped
  surface_version: null     # set from package.json on successful install
  installed_at: null        # ISO timestamp
  notes: null               # free-form, for the next agent run
---

# Surface — Install For Agents

This file is the canonical bootstrap routine. Read it top to bottom on every install attempt; you may exit early if the state block above says you're done.

Surface is a single-user, single-deployment local service. The agent contract is two files: `SKILL.md` (when/how to use the CLI) and `docs/TUTORIAL.md` (first-run user onboarding). There is no per-agent protocol — every agent shells out to `surface`.

## State

The YAML frontmatter at the top of this file is your install state. Update it as you progress. Convention: agents edit this file locally; `git status` showing it as modified is expected. Don't commit your local changes back upstream.

States:

- `service`: is the Surface system service reachable on `127.0.0.1:3000`?
- `skill_saved_to`: where you copied `SKILL.md` into the agent's own skills directory.
- `tutorial`: have you walked the user through `docs/TUTORIAL.md`?
- `surface_version`, `installed_at`: stamped on first complete install.
- `notes`: anything the next agent should know.

## Early exit

If `service: running` and `skill_saved_to` points at a file that still exists and `tutorial` is `complete` or `skipped`, you are done. Skip to "Sanity check" at the bottom.

## Step 1 — Check the service

```bash
curl -fsS http://127.0.0.1:3000/surfaces >/dev/null && echo "Surface is running"
systemctl --user status surface.service --no-pager 2>/dev/null
```

If the HTTP check passes: set `service: running` and continue to Step 2.

If not, ask the user before installing:

> I don't see a running Surface service. Want me to install and start the systemd user service for this clone?

If yes: `./scripts/install-systemd-user-service.sh`, then re-run the HTTP check. If still failing, set `service: failed` and `notes: <reason>` and stop — surface the failure to the user.

If the user declines: set `service: not_installed` and stop. Don't proceed without a running service.

## Step 2 — Save SKILL.md to your skills directory

`SKILL.md` is at the repo root. Copy it into your own agent's skill directory so you can read it on future sessions without re-cloning.

Known agent skill directories:

- **Claude Code**: `~/.claude/skills/surface/SKILL.md`
- **Cursor**: `~/.cursor/skills/surface/SKILL.md` (or workspace `.cursor/skills/`)
- **Generic**: whatever path your agent uses for ambient skills

```bash
mkdir -p ~/.claude/skills/surface
cp SKILL.md ~/.claude/skills/surface/SKILL.md
```

Set `skill_saved_to: <absolute path>`.

If the agent has no skills directory convention, document the path in `notes` and read `SKILL.md` from the repo on every session.

## Step 3 — Tutorial

Ask the user:

> Want me to walk you through Surface in five minutes? It covers creating content, hot reload from your project, and reacting to clicks.

- If yes: set `tutorial: in_progress`, run through `docs/TUTORIAL.md` step by step, set `tutorial: complete` at the end.
- If no: set `tutorial: skipped`.

The tutorial is the single best onboarding mechanism. Skipping is fine, but don't silently bypass it — confirm with the user.

## Step 4 — Stamp the install

When everything above is green:

```yaml
service: running
skill_saved_to: /abs/path/to/SKILL.md
tutorial: complete         # or skipped
surface_version: 0.1.0     # read from package.json
installed_at: 2026-05-14T...Z
```

## Sanity check (always run)

```bash
surface --help          # CLI is on PATH (run npm link from the clone if not)
surface list            # service reachable
surface status          # display state
```

If `surface` is not on PATH:

```bash
cd /path/to/Surface
npm install
npm link                # creates a global symlink to ./bin/surface.ts
```

Alternative without `npm link`: invoke directly via `node_modules/.bin/surface` or `npx tsx /path/to/Surface/bin/surface.ts`.

## What to use the CLI for

See `SKILL.md`. Quick reference:

- `surface link <abs-path>` — preferred for files in the user's project (`surface touch <id>` after editing).
- `surface create <title> --content -` — ad-hoc HTML pushed from stdin.
- `surface present <abs-path>` — one-shot snapshot of a PDF/image/markdown.
- `surface list`, `surface read`, `surface delete`, `surface open`, `surface exec`, `surface actions`, `surface reply`, `surface notify`, `surface theme`, `surface stream`.

## Operating rules

- Treat Surface as a system service. Don't start a second one; reuse the running instance.
- Ask the user before installing, enabling, restarting, or stopping the service.
- Before creating content, run `surface list` and reuse an existing artifact if one fits.
- For files in the agent's working directory, prefer `surface link` over `surface create`.
- Don't commit `.env`, `~/.surface/` contents, or any modifications to this file's state block.

## External agent gateway (optional)

Surface can fan out user actions to an external HTTP gateway. Two pieces:

1. **The gateway uses Surface** — point its tools at the `surface` CLI.
2. **Surface notifies the gateway** — set `SURFACE_WEBHOOK_URL`, `SURFACE_WEBHOOK_TOKEN`, optionally `SURFACE_WEBHOOK_PATH` in the service `.env`. Default path: `/hooks/agent`. Payload is structured JSON: `{ type: "surface_action", surface_id, surface_title, action, data, created_at }`. `OPENCLAW_GATEWAY_URL` / `OPENCLAW_HOOKS_TOKEN` are accepted as legacy aliases.

## Upgrading

```bash
cd /path/to/Surface
git pull
npm install
npx tsc --noEmit
npm run test:artifacts
systemctl --user restart surface.service
```

Ask before restarting if the user has active work on the display.

## MCP (archived)

Surface previously shipped an MCP stdio adapter. It now lives in `archived/mcp.ts` for users with existing MCP-based agent configs. New installs should use the CLI + `SKILL.md` path described here. See `archived/README.md` for details.
