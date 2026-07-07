# Developing Surface

**Status:** Shipped (2026-06)
**Code:** `AGENTS.md`, `.claude/claude.md`, `STATUS.md`, `package.json`, `tsconfig.json`, `test/`

How to work on Surface itself: repo layout, the runtime stack, the npm scripts, what each test covers, and the project conventions.

## Repo layout

```
server/      Express app, DB, auth, SSE, thumbnails, migrations
server/routes/  one router per concern: auth, artifacts, actions, display, integrations
client/      Vanilla-JS PWA (app.js, surface.js, style.css, index.html, pair.html, manifest.json)
bin/         surface.ts — the CLI (canonical agent client)
dist/        surface.mjs — the bundled single-file CLI (built by npm run build:cli, gitignored)
templates/   built-in templates: ask, stream, video, board, doc
examples/    demos/ — bundled example surfaces used by the tutorial + idea portal
archived/    old docs/demos plus the legacy MCP stdio adapter (not maintained)
test/        standalone regression suites plus helpers/run-all.ts
docs/        architecture, roadmap, and the per-topic docs you are reading
scripts/     install-systemd-user-service.sh
```

Key server files: `index.ts` (entrypoint + auth middleware + static serving), `routes/{auth,artifacts,actions,display,integrations}.ts` (HTTP routes, mounted by `routes/index.ts`), `artifacts.ts` (artifact model + link-root enforcement), `db.ts` (database lifecycle), `actionsStore.ts` (action queue), `displayConfig.ts` (theme config), `auth.ts` (pairing tokens + sessions), `sse.ts` (SSE client registry, targets, waiters, heartbeat), `state.ts` (surface state), `streams.ts` (stream chunks), `templates.ts` (template engine), `markdown.ts` (markdown renderer), `bindings.ts` (binding dispatch), `outbound.ts` (SSRF-guarded outbound HTTP), `render.ts` (view shells + runtime injection + thumb placeholder), `presence.ts` (per-device presence), `thumbs.ts` (Chrome thumbnail capture), `migrations.ts` (`PRAGMA user_version` baseline), `paths.ts` (data dir), `startupAccess.ts` + `qrCode.ts` (startup pairing output).

## Runtime stack

- **Express 5** (`express@^5.1.0`) + **better-sqlite3** (`@^11.8.2`) — synchronous SQLite, no ORM.
- **`tsx`** runs TypeScript directly for the dev server (`npm run dev`). For distribution, `npm run build` (run automatically by the `prepare` hook, `scripts/build.mjs`) bundles **both** entrypoints with esbuild: `bin/surface.ts` → `dist/surface.mjs` (fully self-contained; the npm `bin` points at it) and `server/index.ts` → `dist/server.mjs` (npm packages stay external — better-sqlite3 is native). The `surface service` supervisor execs `dist/server.mjs`. `tsconfig.json` targets ES2022 with `strict: true` and exists mainly so `npx tsc --noEmit` can type-check (it excludes `archived/`).
- **Vanilla-JS client, no build step.** `client/index.html` loads `app.js` and `style.css` directly. Cache-bust client assets by bumping the `?v=N` query in `client/index.html` — this is the project convention for shipping client changes.
- **SSE** for all live updates (`server/sse.ts`); no WebSockets.
- Data lives under **`~/.surface/`** (`db.sqlite`, `artifacts/`, `auth-secret`, `install-state.json`, `logs/`, `templates/`, `thumbs/`), overridable with `SURFACE_DATA_DIR`. A pre-baseline `db.sqlite` is archived to `db.sqlite.bak` at boot, never migrated (`server/db.ts`).

## Scripts (`package.json`)

| Script | Command | Purpose |
| --- | --- | --- |
| `npm run dev` | `tsx server/index.ts` | Start the server on `127.0.0.1:3000`. |
| `npm run service` | `tsx server/index.ts` | Same entrypoint from source (production installs run `dist/server.mjs` via `surface service`). |
| `npm run cli` | `tsx bin/surface.ts` | Run the CLI from source without `npm link`. |
| `npm run build` | `node scripts/build.mjs` | Bundle CLI → `dist/surface.mjs` and server → `dist/server.mjs` (also runs via the `prepare` hook; `build:cli` is a legacy alias). |
| `npm test` | `tsx test/run-all.ts` | Build the bundles and run the isolated regression suite aggregate. |
| `npm run test:artifacts` | `tsx test/artifacts.ts` | Artifact HTTP regression test. |
| `npm run test:auth` | `tsx test/auth.ts` | Pairing/session auth acceptance tests. |
| `npm run test:startup-access` | `tsx test/startupAccess.ts` | Startup connection-string / QR unit tests. |
| `npm run test:bindings` | `tsx test/bindings.ts` | Consent-gated binding dispatch contract. |
| `npm run test:content-origin` | `tsx test/contentOrigin.ts` | App/content-origin and Host/Origin protections. |
| `npm run test:cli` | `tsx test/cli.ts` | CLI parser/build smoke tests. |
| `npm run test:e2e` | `tsx test/e2e.ts` | End-to-end test driving an LLM via OpenRouter. |

Each suite is a standalone `tsx` program with its own `assert`/`check` helper. Type-check with `npx tsc --noEmit`. The aggregate `npm test` runs the deterministic suites; `test:e2e` skips unless `SURFACE_TEST_E2E=1`.

## Test coverage

- **`test/artifacts.ts`** — boots an isolated server. Covers workspace artifacts, versioning, rollback, cards, project filters, binary `content_base64`, state, templates, built-ins, stream chunks, linked artifacts, path traversal, symlink escape, and linked update/rollback conflicts.
- **`test/auth.ts`** — spawns a real server **twice** with isolated app/content ports. Boot 1 (loopback trusted): loopback resolves to the `system` role and mints a system bearer. Boot 2 (`SURFACE_TRUST_LOOPBACK=0`, same data dir): every request must authenticate — unauthenticated rejection of `/artifacts`/`/stream`, the bearer surviving the restart, the pairing lifecycle (mint, `pairingUrl` fragment, one-time consumption, reuse/expiry/revocation failures), the device capability split (devices can list/create/click but not display-control/link/present/exec/state-write/inbox/mint), the device registry (`surface devices` listing, label-prefix revocation, immediate access loss), session listing/revocation, and logout.
- **`test/startupAccess.ts`** — pure unit tests for `resolveConnectionHost`/`resolveConnectionString`/`resolveListeningPort`, `buildPairingUrl`/`buildHostedPairingUrl`, and `renderTerminalQrCode` (no server needed).
- **`test/bindings.ts`** — boots an isolated server and verifies command bindings, waiter suppression, non-matching actions, consent gating, cwd/env contract, and ack behavior.
- **`test/contentOrigin.ts`** — boots isolated app/content ports and verifies content-origin serving plus DNS-rebinding Host/Origin rejection.
- **`test/cli.ts`** — checks the bundled CLI parser fails loud on unknown/bad flags and documents wait heartbeat/follow.
- **`test/e2e.ts`** — opt-in with `SURFACE_TEST_E2E=1` and `OPENROUTER_API_KEY`; gives an LLM tool definitions and verifies artifact CRUD through the HTTP API.

## Data location

Everything Surface owns lives under `~/.surface/`: `db.sqlite` (+ WAL/SHM), the `artifacts/` workspace store, `auth-secret` (mode `0600`), `install-state.json`, `logs/bindings/`, `templates/`, and `thumbs/`. Override the directory with `SURFACE_DATA_DIR`. A pre-baseline `db.sqlite` is archived to `db.sqlite.bak` at boot — never row-migrated (`server/db.ts`, `server/migrations.ts`).

## Archived MCP adapter

Surface previously shipped an MCP stdio adapter. It now lives at `archived/mcp.ts` and is **not maintained** (`archived/README.md`). It still calls the HTTP API, but `@modelcontextprotocol/sdk` is no longer a dependency — running it requires installing the SDK manually. It has no bin entry, is excluded from `tsconfig.json`, and is not part of the supported agent contract — the CLI + `SKILL.md` is the canonical path.

## Conventions

- **No new dependencies without a clear reason.** The client has zero runtime dependencies; the server has four (`better-sqlite3`, `dotenv`, `express`, `uuid`).
- **Plain, single-line commit messages.** No Codex/Anthropic/AI co-author or attribution lines (`AGENTS.md`, `.claude/claude.md`).
- Prefer **updating an existing artifact** over creating duplicates; use stable artifact ids for recurring purposes.
- Bump `?v=N` in `client/index.html` whenever you change client assets.
- Never commit `.env` or `~/.surface/` contents (install state lives at `~/.surface/install-state.json`, outside the repo). `.mcp.json` is gitignored.

`STATUS.md` is the branch-neutral one-screen summary of current capabilities and the standard verification gate.

## Related
- [../architecture.md](../architecture.md) — system architecture
- [../roadmap.md](../roadmap.md) — planned work
- [install.md](install.md) — running and the systemd service
- [security.md](security.md) — security model summary
- [../core/cli.md](../core/cli.md) — CLI command reference
