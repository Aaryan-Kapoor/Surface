# Surface

Universal display for AI agents. Agents push HTML/CSS/JS to a PWA via the `surface` CLI (canonical) or HTTP directly. Discovery via `SKILL.md` at the repo root.

## Stack

- **Server**: Express 5 + SQLite (better-sqlite3) + SSE live updates
- **Client**: Vanilla JS PWA, hash routing, sandboxed iframes via `src=/surfaces/:id/html`
- **CLI**: `bin/surface.ts` — canonical agent interface, mirrors HTTP API as subcommands
- **Agent contract**: `SKILL.md` (when/how) + `INSTALL_FOR_AGENTS.md` (bootstrap + tutorial state)
- **MCP**: archived at `archived/mcp.ts` — kept for legacy users, not the recommended path
- **Runtime**: `tsx` for dev server and CLI

## Commands

- `npm run dev` — start server on 127.0.0.1:3000
- `npm run cli` — invoke CLI from source
- `npm run test:artifacts` — artifact HTTP regression test
- `npm run test:e2e` — end-to-end test via OpenRouter

## Key decisions

- Binds to 127.0.0.1 by default. Non-loopback access uses one-time pairing tokens → durable sessions (cookie or bearer); `SURFACE_TOKEN` still works as a static owner bearer. Set `SURFACE_TRUST_LOOPBACK=0` when behind a same-host reverse proxy. See `SECURITY.md`.
- Data lives in `~/.surface/` (`db.sqlite` + `artifacts/`). Override with `SURFACE_DATA_DIR`.
- Surfaces render in iframes loaded from `/surfaces/:id/html` (not srcdoc) so they get a real origin for script loading
- Preview cards use iframe thumbnails for simple surfaces, icon fallback for complex/script-heavy ones
- PDF embedding uses server-side `/proxy/pdf?url=` proxy + PDF.js v3 canvas rendering
- Webhook fan-out: structured JSON envelope to `SURFACE_WEBHOOK_URL` + `SURFACE_WEBHOOK_PATH` (default `/hooks/agent`) when token is set. `OPENCLAW_*` are legacy aliases.
- Display control: agents own the display end-to-end — theme, navigation, notifications, JS execution
- Theme persisted in `display_config` table, applied via CSS custom properties + raw CSS injection
- Marketplace gated by `SURFACE_FEATURES_MARKETPLACE=1`; disabled by default.
- Migrations: SQLite `PRAGMA user_version` via `server/migrations.ts`.
- Linked artifacts (`source_type: "linked"`, `storage_kind: "external"`): bytes live in agent's project dir; `surface touch <id>` after edits. `update`/`rollback` return 409.
- `SURFACE_LINK_ROOTS` (colon-separated) narrows accepted link paths if set.
- `.env` has OPENROUTER and webhook credentials — never commit

## Conventions

- Cache-bust client assets via `?v=N` in index.html
- Single-line commits, no Claude/Anthropic mentions
