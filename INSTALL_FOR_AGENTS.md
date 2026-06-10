# Surface — Install For Agents

This file is the canonical bootstrap routine. Read it top to bottom on every install attempt; you may exit early if the state file says you're done.

Surface is a single-user, single-deployment local service. The agent contract is two files: `SKILL.md` (when/how to use the CLI) and `docs/TUTORIAL.md` (first-run user onboarding). There is no per-agent protocol — every agent shells out to `surface`.

## State: `~/.surface/install-state.json`

Install state lives outside the repo so the working tree stays clean:

```json
{
  "service": "pending",
  "skill_saved_to": null,
  "tutorial": "pending",
  "surface_version": null,
  "installed_at": null,
  "notes": null
}
```

- `service`: `pending | running | not_installed | failed` — is the Surface service reachable on `127.0.0.1:3000`?
- `skill_saved_to`: where you copied `SKILL.md` into your own skills directory.
- `tutorial`: `pending | in_progress | complete | skipped`.
- `surface_version`, `installed_at`: stamped on first complete install.
- `notes`: anything the next agent should know.

Read it first (`cat ~/.surface/install-state.json`); create it with the defaults above if missing. Update it as you progress.

(Older installs kept this state as YAML frontmatter at the top of this file. If you find such a block locally, move its values into `~/.surface/install-state.json` and discard the local file edit.)

## Early exit

If `service` is `"running"` and `skill_saved_to` points at a file that still exists and `tutorial` is `"complete"` or `"skipped"`, you are done. Skip to "Sanity check" at the bottom.

## Step 1 — Check the service

```bash
curl -fsS http://127.0.0.1:3000/artifacts >/dev/null && echo "Surface is running"
systemctl --user status surface.service --no-pager 2>/dev/null
```

If the HTTP check passes: set `service: "running"` and continue to Step 2.

If not, ask the user before installing:

> I don't see a running Surface service. Want me to install and start the systemd user service for this clone?

If yes: `./scripts/install-systemd-user-service.sh`, then re-run the HTTP check. If still failing, set `service: "failed"` and `notes: <reason>` and stop — surface the failure to the user.

If the user declines: set `service: "not_installed"` and stop. Don't proceed without a running service.

> **Note (fresh-start schema, 2026-06):** the first boot of a current build archives any pre-existing database to `~/.surface/db.sqlite.bak` and starts clean. Surfaces from older versions are not migrated — re-link or re-create them (`surface sync` recreates anything a project declared in `.surface/`).

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

Set `skill_saved_to: "<absolute path>"`.

If the agent has no skills directory convention, document the path in `notes` and read `SKILL.md` from the repo on every session.

## Step 3 — Tutorial

Ask the user:

> Want me to walk you through Surface in five minutes? It covers creating content, hot reload from your project, and reacting to clicks.

If yes:

1. Set `tutorial: "in_progress"`.
2. Run `surface seed-demos` — links the seven example surfaces from `examples/demos/` (or unhides them if a previous tour left them archived). Each row is tagged `metadata.demo = true` so it's identifiable.
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
surface --help          # CLI is on PATH (run npm link from the clone if not)
surface list            # service reachable
surface status          # per-device display state
surface actions         # your inbox — drain it (see SKILL.md)
```

If `surface` is not on PATH:

```bash
cd /path/to/Surface
npm install             # also builds the single-file CLI bundle (dist/surface.cjs)
npm link
```

Alternative without `npm link`: invoke via `node /path/to/Surface/dist/surface.cjs` or `npx tsx /path/to/Surface/bin/surface.ts`.

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
cd /path/to/Surface
git pull
npm install
npx tsc --noEmit
npm run test:artifacts
systemctl --user restart surface.service
```

Ask before restarting if the user has active work on the display.

## MCP (archived)

Surface previously shipped an MCP stdio adapter. It now lives in `archived/mcp.ts` for users with existing MCP-based agent configs (its SDK dependency is no longer installed by default — see `archived/README.md`). New installs use the CLI + `SKILL.md` path described here.
