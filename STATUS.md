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
- Marketplace gated behind `SURFACE_FEATURES_MARKETPLACE=1`; off by default.
- Updated `docs/architecture.md`, `README.md`, `AGENTS.md`, `.claude/claude.md`.

## Verified

- `npx tsc --noEmit` passes.
- `npm run test:artifacts` passes.
- CLI smoke (isolated server on port 3099, `SURFACE_DATA_DIR=/tmp/...`) covers create / read / link / touch / update-rejection / delete.
- Auto-migration from legacy paths runs on first boot of fresh data dir.
- Marketplace flag gates routes and Explore button correctly.

## Notes

- Project/container sandbox execution is schema-only for now.
- Legacy `surfaces` table removal is future migration work.
- Iframe sandboxing, `If-Match` version preconditions on workspace artifacts, N+1 grid fetches, and SSE keepalive are deferred — see `docs/architecture.md` "Deferred / known issues".
- MCP adapter in `archived/` still works if invoked directly; not maintained.
