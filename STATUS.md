# Surface Status

Branch: `feature/artifact-architecture`

## Done

- Made artifacts the canonical content model.
- Added SQLite tables for artifacts, versions, files, surface views, and sandbox sessions.
- Added workspace file storage under `~/.surface/artifacts/` (was `~/surface/`); legacy paths auto-migrated on boot.
- Added artifact HTTP APIs: create, update, delete, present file, read, versions, rollback, view, file serving.
- Added **linked artifacts**: `POST /artifacts/link` + `POST /artifacts/:id/touch`. Files live in the agent's project; Surface re-serves live. `update`/`rollback` return 409 on linked; the filesystem is the source of truth.
- Added **CLI** at `bin/surface.ts` — canonical agent client; mirrors HTTP API as subcommands.
- Added **`SKILL.md`** at repo root — agent-facing discovery document.
- Added **`docs/TUTORIAL.md`** — 7-step user onboarding script agents narrate on first install.
- Rewrote `INSTALL_FOR_AGENTS.md` around a YAML state block (`tutorial: pending|in_progress|complete|skipped`, `service`, `skill_saved_to`) agents update locally.
- Archived MCP: moved `server/mcp.ts` → `archived/mcp.ts`, `.mcp.example.json` → `archived/.mcp.example.json`. Removed `surface-mcp` bin and `mcp` script.
- Added `SECURITY.md` with threat model and `SURFACE_TOKEN` / `SURFACE_LINK_ROOTS` doc.
- Bind defaults to `127.0.0.1`. Non-loopback refuses to start without `SURFACE_TOKEN`.
- Added `LICENSE` (MIT).
- Added `server/migrations.ts` with `PRAGMA user_version` framework.
- Added `server/paths.ts` with `SURFACE_DATA_DIR` and legacy-path migration.
- Replaced OpenClaw branding with generic `SURFACE_WEBHOOK_*` (OpenClaw env vars kept as aliases).
- Removed the catalog/Explore feature (routes, registry catalog, and client Explore view).
- Updated `docs/architecture.md`, `README.md`, `AGENTS.md`, `.claude/claude.md`.

## Verified

- `npx tsc --noEmit` passes.
- `npm run test:artifacts` passes — now covers linked artifacts (link / touch / 409 on update+rollback / path-traversal blocked / symlink-escape blocked).
- CLI smoke (isolated server on port 3099, `SURFACE_DATA_DIR=/tmp/...`) covers create / read / link / touch / update-rejection / delete.
- `surface wait` covers live action delivery, action-name filter, pending-on-startup, timeout exit 3, `--no-ack`, reconnect across server bounce, concurrent waiters.
- Auto-migration from legacy paths runs on first boot of fresh data dir.
- Bind hardening: `SURFACE_BIND=0.0.0.0` without `SURFACE_TOKEN` refuses to boot; with token, loopback bypasses auth, non-loopback requires `Authorization: Bearer` or `?token=`.

## QA pass

An Opus subagent ran the full matrix in a forked tree. Two findings:

- **CRITICAL — symlink escape on linked artifacts** (now fixed): a symlink inside a linked directory pointing outside it leaked the target's bytes through the file route. Added `fs.realpathSync` resolution at both link time (`server/artifacts.ts`) and read time (`server/routes.ts`). `SURFACE_LINK_ROOTS` also realpaths candidate and roots so a symlinked path can't bypass the allow-list.
- **MINOR — CLI usage errors exited 1 instead of 2** (now fixed): added `usage()` helper in `bin/surface.ts` that exits 2 directly. Runtime errors still exit 1; timeout still exits 3.

Regression test for the symlink case is in `test/artifacts.ts`.

## Notes

- Project/container sandbox execution is schema-only for now.
- Legacy `surfaces` table removal is future migration work.
- Iframe sandboxing, `If-Match` version preconditions on workspace artifacts, N+1 grid fetches, and SSE keepalive are deferred — see `docs/architecture.md` "Deferred / known issues".
- MCP adapter in `archived/` still works if invoked directly; not maintained.
