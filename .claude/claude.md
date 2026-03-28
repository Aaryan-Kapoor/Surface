# Surface

Universal canvas for AI agents. Agents push HTML/CSS/JS to a PWA via CRUD API or MCP tools.

## Stack

- **Server**: Express 5 + SQLite (better-sqlite3) + SSE live updates
- **Client**: Vanilla JS PWA, hash routing, sandboxed iframes via `src=/surfaces/:id/html`
- **MCP**: `server/mcp.ts` — 13 tools (surface CRUD, actions, display control, theming, exec)
- **Runtime**: `bun` for MCP server, `tsx` for dev server

## Commands

- `npm run dev` — start server on 0.0.0.0:3000
- `npm run test:e2e` — end-to-end test via OpenRouter

## Key decisions

- Surfaces render in iframes loaded from `/surfaces/:id/html` (not srcdoc) so they get a real origin for script loading
- Preview cards use iframe thumbnails for simple surfaces, icon fallback for complex/script-heavy ones
- PDF embedding uses server-side `/proxy/pdf?url=` proxy + PDF.js v3 canvas rendering
- OpenClaw integration: MCP server registered in openclaw.json, webhook fan-out via `/hooks/agent` on surface actions
- Display control: agents own the display end-to-end — theme, navigation, notifications, JS execution
- Theme persisted in `display_config` table, applied via CSS custom properties + raw CSS injection
- `.env` has OPENROUTER and OPENCLAW credentials — never commit

## Conventions

- Cache-bust client assets via `?v=N` in index.html
- Single-line commits, no Claude/Anthropic mentions
