# Project Ownership & Agent Attribution

**Status:** Shipped (2026-06)
**Code:** `bin/surface.ts` (`resolveProjectRoot`, `attributionMetadata`), `server/routes/artifacts.ts` (`--project`/`--agent` filters), `server/migrations.ts` (`artifacts.project_root`)

Surfaces are owned by **the user's git projects**, not by agents. The project directory is the one identity that is unambiguous, durable, and free: it's where the agent was standing when it created the surface, and the project's own git history already records which agent changed what — better than Surface ever could. Agent identity in Surface is deliberately just a courtesy label.

## Why not per-agent identity

Every agent on the machine runs as the same OS user. Tokens, env vars (`SURFACE_AGENT`-style), and config files are all readable and writable by every other agent, so per-agent credentials are friction without isolation, and even a per-harness env var ends up shared in practice. Accountability is therefore delegated downward (to the OS user boundary) and outward (to the project's git history). See [trust-model.md](trust-model.md).

## Project ownership

On every create path (`surface create`, `surface link`, `surface present`, template instantiation), the CLI resolves the project root and stamps it:

- Resolution: `git rev-parse --show-toplevel` from the working directory; fallback to the working directory itself when not in a git repo.
- Storage: the `artifacts.project_root TEXT` column (nullable — surfaces created outside any project context, e.g. by a daemon, have none), indexed for filtering.
- Override: the HTTP API takes `project_root` directly in the body, for callers acting on behalf of a different project than their cwd.

What it buys:

- **Card attribution** — cards carry their project (and agent label) so the grid can show `myapp · claude-code · 2h ago`.
- **Scoped listing** — `surface list --project <root>` shows only that project's surfaces (`GET /artifacts?project=`); SKILL.md tells agents to check this before creating duplicates.
- **`.surface/` reconciliation** — the project directory convention ([../state/project-directory.md](../state/project-directory.md)) keys off the same root.

## Agent attribution

A minimal, self-reported field, filled at the same place agents already fill the surface's title:

```bash
surface create "Build status" --agent claude-code …
surface link ./report.html --agent codex …
```

- Storage: `metadata.agent` (string label). No schema column; it rides the existing metadata JSON.
- Display: cards show `myapp · claude-code · 2h ago`; `surface list --agent codex` filters (`GET /artifacts?agent=`).
- Contract: SKILL.md instructs each harness to pass its own name. Nothing enforces honesty — see [trust-model.md](trust-model.md) for why that's acceptable.
- Attribution also rides actions and state writes where useful (`--agent` on `surface set`, used by the [board template](../templates/board.md) to key sections).

## What this replaces

- The earlier `SURFACE_AGENT` env-var idea: rejected (shared env across agents).
- Per-agent sessions/tokens: rejected (no real isolation on a shared uid).
- `artifact_versions.created_by` (never populated): superseded by `metadata.agent`; dropped in the fresh-start baseline.

## Related

- [trust-model.md](trust-model.md) — the two-plane model this fits into
- [../state/project-directory.md](../state/project-directory.md) — `.surface/` and `SURFACE.md`
- [../templates/board.md](../templates/board.md) — attribution as board sections
