# Surface

Universal display for AI agents. Agents push content via a single shared CLI (`surface`). Discovery is via `SKILL.md` at the repo root. Full per-feature docs: `docs/README.md`.

## Stack

- **Server**: Express 5 + SQLite (better-sqlite3) + SSE live updates. Routers per concern in `server/routes/`.
- **Client**: Vanilla JS PWA, hash routing, sandboxed iframes via real routes. `client/surface.js` is the runtime injected into surface HTML.
- **CLI** (`bin/surface.ts`): canonical agent client; bundled to `dist/surface.mjs` by `npm run build` (runs on install via `prepare`; also bundles the server to `dist/server.mjs`); the npm `surface` bin points at the bundle. Published as `surface-display`.
- **Data**: `~/.surface/` (`db.sqlite` + `artifacts/` + `logs/` + `templates/`). Override with `SURFACE_DATA_DIR`.
- **Service**: Surface should run once as a per-user supervised service bound to `127.0.0.1` — `surface service install` picks the native backend (systemd user unit / launchd agent / Windows Scheduled Task), health-gates the start, and logs to `~/.surface/logs/`.
- **Migrations**: SQLite `PRAGMA user_version` via `server/migrations.ts`; fresh-start baseline = v10. Pre-baseline DBs are archived to `db.sqlite.bak` at boot, never migrated.
- **Templates**: built-ins in `templates/` (ask, stream, video, board, doc); resolution project `.surface/templates` → `~/.surface/templates` → built-in.
- **MCP** (archived in `archived/mcp.ts`): not installed by default; needs `npm i @modelcontextprotocol/sdk` to run.

## Commands

- `npm run dev` — start server on 127.0.0.1:3000
- `npm run service` — service entrypoint from source (production supervisors exec `dist/server.mjs` via `surface service install`)
- `npm run cli` — invoke the CLI from source without `npm link`
- `npm run test:artifacts` — HTTP regression suite (needs a running server; use an isolated `SURFACE_DATA_DIR` + `PORT`)
- `npm run test:auth` — two-plane trust-model acceptance tests (spawns its own servers)
- `npm run test:startup-access` — pairing URL/QR helpers
- `npx tsc --noEmit` — TypeScript check

For first-time setup, follow `INSTALL_FOR_AGENTS.md` (state lives in `~/.surface/install-state.json`).

## Architecture

- Artifacts are the only content model. Two source types:
  - **Workspace** (`generated` | `presented_file`): bytes copied under `~/.surface/artifacts/`. Versioned. `update`/`rollback` allowed; `If-Match` gives 412 on version races.
  - **Linked** (`linked`, `storage_kind: "external"`): bytes live at an absolute path in the agent's project. Surface re-serves them live. `update`/`rollback` return 409; use `touch` after editing.
- Surfaces are owned by **projects** (`project_root` stamped from the caller's git root); agents are self-reported labels in `metadata.agent`.
- Every surface has a JSON **state** doc (`surface set/patch`, `state_patch` SSE) and gets `surface.js` injected (`data-surface-bind`, `Surface.action`).
- **Templates** instantiate to normal artifacts (`--template/--param`); re-running with the same id re-renders (no-op when unchanged — `surface sync` relies on it).
- **Delivery ladder** for clicks: live waiter (`surface wait`, suppresses lower layers) → binding (`surface bind`, argv-safe spawn with the action batch on stdin, single-flight + coalesced) → inbox (pending badge; TTL 7d handled / 30d pending).
- Display slots (renderer/home/overlay) are artifacts with `metadata.display_role`.
- Auth: two planes — loopback/app origin = `system` (full power), paired displays/content origin = `device` (view/click/device-authored workspace CRUD/presence). Display control stays system-only. Device-authored surfaces render on `SURFACE_CONTENT_PORT`/`SURFACE_CONTENT_ORIGIN`. `SURFACE_TOKEN` is gone; remote agents use `SURFACE_SESSION` bearers.

## Agent Contract

- **`SKILL.md`** (repo root) — when to use which `surface` subcommand. This is the agent-facing spec.
- **`INSTALL_FOR_AGENTS.md`** — bootstrap routine; state in `~/.surface/install-state.json`.
- **`docs/TUTORIAL.md`** — 7-step user onboarding the agent narrates on first install.
- Per-project: `.surface/` (manifests, config incl. wake-binding consent, templates) + `SURFACE.md`.

## Key Decisions

- Surfaces render in iframes loaded from real routes (`/artifacts/:id/view` → files), not `srcdoc`, so scripts get a real origin; the PWA adds a `sandbox` attribute (top-navigation blocked, same-origin kept for `surface.js`).
- Dashboard cards come from one `GET /artifacts` fetch (full payloads incl. `pending_actions`, `listening`, `agent`).
- PDF embedding uses the SSRF-guarded `/proxy/pdf?url=` proxy.
- Per-surface webhooks (`surface bind --webhook`, with retry) supersede the global `SURFACE_WEBHOOK_*` fan-out for most uses; the global fan-out remains as a firehose.
- Theme persisted in `display_config`, applied with CSS custom properties and raw CSS injection. Slot HTML is *not* config.
- Bind defaults to `127.0.0.1`. Behind a same-host reverse proxy set `SURFACE_TRUST_LOOPBACK=0`. See `SECURITY.md`.
- Linked artifacts respect `SURFACE_LINK_ROOTS` (colon-separated allow-list) when set.
- `.env` has OPENROUTER and webhook credentials; never commit it.

## Conventions

- Cache-bust client assets via `?v=N` in `client/index.html`.
- Use stable artifact IDs for recurring purposes; update instead of duplicating.
- Single-line commits.
- No Codex, Anthropic, or co-author mentions in commits.
