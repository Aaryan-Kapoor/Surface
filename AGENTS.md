# Surface

Universal display for AI agents. Agents push content via a single shared CLI (`surface`). Discovery is via `SKILL.md` at the repo root.

## Stack

- **Server**: Express 5 + SQLite (better-sqlite3) + SSE live updates
- **Client**: Vanilla JS PWA, hash routing, sandboxed iframes via real routes
- **CLI** (`bin/surface.ts`): canonical agent client; mirrors HTTP API as subcommands
- **Data**: `~/.surface/` (`db.sqlite` + `artifacts/`). Override with `SURFACE_DATA_DIR`. Legacy `SURFACE_WORKSPACE_DIR` still respected.
- **Service**: Surface should run once as a Linux systemd user service, bound to `127.0.0.1`.
- **Migrations**: SQLite `PRAGMA user_version` via `server/migrations.ts`; baseline = v1.
- **MCP** (archived in `archived/mcp.ts`): no longer the recommended path; kept for legacy users.

## Commands

- `npm run dev` — start server on 127.0.0.1:3000
- `npm run service` — service entrypoint used by systemd
- `npm run cli` — invoke the CLI from source without `npm link`
- `npm run test:artifacts` — artifact HTTP regression test
- `npm run test:e2e` — end-to-end test via OpenRouter
- `npx tsc --noEmit` — TypeScript check

For first-time setup, follow `INSTALL_FOR_AGENTS.md` (it includes an optional user-facing tutorial in `docs/TUTORIAL.md`).

## Architecture

- Artifacts are the canonical content model. Two source types:
  - **Workspace** (`source_type: "generated" | "presented_file"`): bytes copied under `~/.surface/artifacts/`. Versioned. `update` and `rollback` allowed.
  - **Linked** (`source_type: "linked"`, `storage_kind: "external"`): bytes live at an absolute path owned by the agent's project. Surface re-serves them. One version row. `update`/`rollback` return 409; use `touch` after editing.
- Surface views are display projections of artifacts.
- Legacy `surfaces` rows are read fallback only.
- `/surfaces` create/update/delete remain for old clients; backed by artifacts.
- Surface actions, replies, exec, SSE, navigation, notifications, and theming are runtime/display concerns.
- Project/container sandbox execution is schema-only for now.

## Agent Contract

- **`SKILL.md`** (repo root) — when to use which `surface` subcommand. This is the agent-facing spec.
- **`INSTALL_FOR_AGENTS.md`** — bootstrap routine with a YAML state block agents update locally. Tracks `service`, `skill_saved_to`, `tutorial`, `surface_version`, `installed_at`.
- **`docs/TUTORIAL.md`** — 7-step user onboarding the agent narrates on first install.

Use `surface link <abs-path>` for files in the agent's working directory (preferred — Surface re-serves live from disk, no diff tool needed). Use `surface create <title> --content -` for ad-hoc HTML pushed from stdin. Use `surface present <abs-path>` for one-shot file snapshots.

For user-click delivery, prefer `surface wait --id <id> [--action <name>] [--timeout <s>]` invoked as a background subprocess — it blocks until a matching action arrives, ACKs it, and exits 0. The agent harness's background-task-completion hook then wakes the agent. No webhook gateway required.

## Key Decisions

- Surfaces render in iframes loaded from real routes (`/surfaces/:id/html`), not `srcdoc`, so scripts get a real origin.
- Preview cards use iframe thumbnails for simple surfaces and icon fallback for complex/script-heavy ones.
- PDF embedding uses server-side `/proxy/pdf?url=` proxy plus PDF.js canvas rendering.
- Webhook fan-out: surface actions POST a structured JSON envelope to `SURFACE_WEBHOOK_URL` + `SURFACE_WEBHOOK_PATH` (default `/hooks/agent`) when both URL and `SURFACE_WEBHOOK_TOKEN` are set. `OPENCLAW_*` env vars are legacy aliases.
- Theme is persisted in `display_config`, then applied with CSS custom properties and raw CSS injection.
- Bind defaults to `127.0.0.1`. Non-loopback access is authenticated by one-time pairing tokens → durable `surface_session` cookies/bearer tokens (`/pair`, `surface pair`, `surface auth …`, `/api/auth/*`). `SURFACE_TOKEN` still works as a static owner bearer. Behind a same-host reverse proxy set `SURFACE_TRUST_LOOPBACK=0`. See `SECURITY.md`.
- Linked artifacts respect `SURFACE_LINK_ROOTS` (colon-separated allow-list) when set.
- `.env` has OPENROUTER and webhook credentials; never commit it.
- `.mcp.json` is gitignored.

## Conventions

- Cache-bust client assets via `?v=N` in `client/index.html`.
- Use stable artifact IDs for recurring purposes.
- Update existing artifacts instead of creating duplicates.
- Single-line commits.
- No Codex, Anthropic, or co-author mentions in commits.
