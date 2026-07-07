# Surface

Universal display for AI agents. Agents push surfaces via the `surface` CLI (canonical) or HTTP directly. Discovery via `SKILL.md` at the repo root; per-feature docs in `docs/`.

## Stack

- **Server**: Express 5 + SQLite (better-sqlite3) + SSE; routers in `server/routes/`
- **Client**: Vanilla JS PWA + `client/surface.js` runtime injected into surface HTML
- **CLI**: `bin/surface.ts`, bundled to `dist/surface.mjs` on install (`prepare` → `npm run build`, which also bundles `server/index.ts` → `dist/server.mjs`); published to npm as `surface-display`
- **Agent contract**: `SKILL.md` (when/how) + `INSTALL_FOR_AGENTS.md` (bootstrap; state in `~/.surface/install-state.json`)
- **Templates**: `templates/` built-ins (ask, stream, video, board, doc); project/user overrides
- **MCP**: archived at `archived/mcp.ts`; SDK not installed by default
- **Runtime**: `tsx` for dev server; tests in `test/`

## Commands

- `npm run dev` — server on 127.0.0.1:3000
- `npm run test:artifacts` (needs running server) · `npm run test:auth` (self-contained) · `npm run test:startup-access`
- `npx tsc --noEmit`

## Key decisions

- Two-plane auth: loopback = `system` (agents, full power); paired displays = `device` (view/click/workspace-CRUD/display control only). `SURFACE_TOKEN` removed — remote agents use `SURFACE_SESSION` bearers (`surface auth session issue --role system`). `SURFACE_TRUST_LOOPBACK=0` behind same-host proxies.
- Fresh-start schema: baseline migration v10; pre-baseline `~/.surface/db.sqlite` archived to `.bak` at boot, not migrated.
- Artifacts only (no legacy `surfaces`); cards from one `GET /artifacts` fetch; surfaces owned by `project_root` (git root), agents are `metadata.agent` labels.
- Per-surface JSON state (`surface set/patch` → `state_patch` SSE) + `surface.js` bindings; templates instantiate to normal artifacts and re-render idempotently.
- Delivery ladder: `surface wait` (waiter suppresses bindings) → `surface bind` (argv-safe spawn, action batch on stdin, single-flight + coalescing, logs in `~/.surface/logs/bindings/`) → inbox (badges; TTL 7d/30d).
- Display slots (renderer/home/overlay) are artifacts with `metadata.display_role` (`surface slot`).
- Surfaces render from real routes with a `sandbox` iframe attr; PDF via SSRF-guarded `/proxy/pdf`; linked artifacts respect `SURFACE_LINK_ROOTS`.
- `.env` has OPENROUTER and webhook credentials — never commit.

## Conventions

- Cache-bust client assets via `?v=N` in index.html
- Single-line commits, no Claude/Anthropic mentions
