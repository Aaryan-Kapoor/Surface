# Surface

Universal display for AI agents. Agents create durable artifacts; Surface presents them as live displayable surfaces in the PWA.

## Stack

- **Server**: Express 5 + SQLite (better-sqlite3) + SSE live updates
- **Client**: Vanilla JS PWA, hash routing, sandboxed iframes via real routes
- **Artifacts**: Versioned files under `SURFACE_WORKSPACE_DIR` / `~/surface`
- **Service**: Surface should run once as a Linux systemd user service
- **MCP**: `server/mcp.ts` is a stdio adapter that connects to the running Surface HTTP service
- **Runtime**: `tsx` for dev, service, and MCP script execution

## Commands

- `npm run dev` - start server on 0.0.0.0:3000
- `npm run service` - service entrypoint used by systemd
- `npm run test:artifacts` - artifact HTTP regression test
- `npm run test:e2e` - end-to-end test via OpenRouter
- `npx tsc --noEmit` - TypeScript check

For first-time setup by an external agent, follow `INSTALL_FOR_AGENTS.md`.

## Architecture

- Artifacts are the source of truth for durable content, files, metadata, and version history.
- Surface is local infrastructure: one service owns SQLite, artifact storage, display state, and SSE.
- Agents connect through MCP/HTTP and should not each start their own Surface server.
- Surface views are display/card projections of artifacts.
- Legacy `surfaces` rows are compatibility fallback only; new writes should use artifacts.
- `/surfaces` create/update/delete routes remain for old clients, but they operate on backing artifacts where possible.
- `/surfaces/:id/html` serves artifact HTML first and falls back to legacy surface HTML only if needed.
- Surface actions, replies, exec, SSE, navigation, notifications, and theming are runtime/display concerns.
- Project/container sandbox execution is schema-only for now.

## MCP Guidance

- Prefer `artifact_create`, `artifact_update`, `artifact_present_file`, and `artifact_delete` for content lifecycle.
- Check whether the Surface service is already running before setting it up.
- Ask the user before creating, enabling, restarting, stopping, or replacing the service.
- Use `surface_list` for displayable cards and `artifact_list` for durable stored artifacts.
- Use `display_navigate` to open an artifact-backed surface.
- Use `surface_exec` for live JavaScript changes without creating a new artifact version.
- Use `surface_actions`, `surface_ack`, and `reply` for two-way interactions.
- Do not use or advertise legacy `surface_create`, `surface_read`, `surface_update`, or `surface_delete` in new flows.

## Key Decisions

- Surfaces render in iframes loaded from real routes, not `srcdoc`, so scripts get a real origin.
- Preview cards use iframe thumbnails for simple surfaces and icon fallback for complex or script-heavy ones.
- PDF embedding uses server-side `/proxy/pdf?url=` proxy plus PDF.js canvas rendering.
- OpenClaw integration fans out surface actions through `/hooks/agent` when configured.
- Theme is persisted in `display_config`, then applied with CSS custom properties and raw CSS injection.
- `.env` has OPENROUTER and OPENCLAW credentials; never commit it.
- Avoid committing machine-specific MCP config paths.

## Conventions

- Cache-bust client assets via `?v=N` in `client/index.html`.
- Use stable artifact IDs for recurring purposes.
- Update existing artifacts instead of creating duplicates.
- Single-line commits.
- No Codex, Anthropic, or co-author mentions in commits.
