# Surface — For Agents

**You do not install Surface.** The user does, in two commands (`npm install -g
surface-display`, then `surface` — the first run offers setup and links
[`SKILL.md`](SKILL.md) into `~/.agents/skills/` and `~/.claude/skills/` by
itself). If you can read the skill, the machine is already set up. This file is
orientation for an agent landing on a machine where Surface exists — the
contract itself is `SKILL.md`; read it from your skills directory.

## Sanity check

```bash
surface --version        # CLI is on PATH
surface service health   # service reachable + content plane up (exit 0)
surface list             # API answers
surface actions          # your inbox — drain it (see SKILL.md)
```

If `surface` is not on PATH or the service is down, tell the user — the fix is
theirs to run (`npm install -g surface-display && surface`), and a service that
fails to install is a failure to surface, not to work around. **Never run the
server yourself** — no `npm run service`, no hidden background process, no
improvised daemon. An unsupervised server doesn't survive reboot, is invisible
to the user, and squats the ports so every later `surface service install`
fails its health gate.

## The tour

When the user asks for **the Surface tour** (the phrase the installer hands
them): read `docs/TUTORIAL.md` from the installed package (`npm root -g`, then
`surface-display/docs/TUTORIAL.md`) and follow it. Read its rules section
before running anything — the tour is a demo, and most of the ways it goes
wrong are things it explicitly tells you not to do. It builds its own surfaces
from shipped templates (do not improvise markup for it) and ends by running
`surface clear-demos` itself. An interrupted run leaves demo cards behind;
`surface clear-demos` hides them in one step.

## Operating rules

- Treat Surface as a system service. Don't start a second one; reuse the running instance.
- Ask the user before enabling, restarting, or stopping the service.
- Before creating content, run `surface list` and reuse an existing artifact if one fits.
- For files in the agent's working directory, prefer `surface link` over `surface create`.
- Never auto-register wake bindings without the per-project consent recorded in `.surface/config.json` (see SKILL.md).
- Don't commit `.env` or `~/.surface/` contents.

## Skill placement (non-default harnesses)

`surface service install` links the skill into the two directories that cover
almost every harness: `~/.agents/skills/surface/` (the open standard —
agentskills.io: Codex, Cursor, Gemini CLI, Copilot, Zed, Amp, Goose, OpenCode,
Roo, Kilo, Windsurf) and `~/.claude/skills/surface/` (Claude Code reads only
its own directory). A harness that reads somewhere else gets a link with
`surface skill install --to <dir>` (repeatable; `--copy`/`--link` set the mode,
remembered per target). No skills convention at all (e.g. Aider)? Append a
one-line pointer to the canonical copy (`<data-dir>/skills/surface/SKILL.md`)
in the agent's instructions file.

A canonical copy the user edited is kept — and mirrored to every link — until
`surface skill install --force` replaces it with the packaged skill
(`surface service health` reports it as `edited`).

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
without it. `surface upgrade --check` reports without changing anything;
`surface service health` prints a note whenever the package, the running
service, or the skill copies drift. Ask before restarting if the user has
active work on the display.

## External agent gateway (optional)

Surface can fan out user actions to an external HTTP gateway. Two pieces:

1. **The gateway uses Surface** — point its tools at the `surface` CLI.
2. **Surface notifies the gateway** — set `SURFACE_WEBHOOK_URL`, `SURFACE_WEBHOOK_TOKEN`, optionally `SURFACE_WEBHOOK_PATH` in the service `.env`. Default path: `/hooks/agent`. Payload is structured JSON: `{ type: "surface_action", surface_id, surface_title, action, data, created_at }`. `OPENCLAW_GATEWAY_URL` / `OPENCLAW_HOOKS_TOKEN` are accepted as legacy aliases.

Per-surface webhooks (with retry) are usually better: `surface bind <id> --webhook <url>`.

## MCP (archived)

Surface previously shipped an MCP stdio adapter. It now lives in `archived/mcp.ts` for users with existing MCP-based agent configs (its SDK dependency is no longer installed by default — see `archived/README.md`). New installs use the CLI + `SKILL.md` path described here.
