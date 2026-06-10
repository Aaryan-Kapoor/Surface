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
examples/    demos/ — seven example surfaces used by the tutorial + idea portal
archived/    mcp.ts — the legacy MCP stdio adapter (not maintained)
test/        artifacts.ts, auth.ts, e2e.ts, startupAccess.ts
docs/        architecture, roadmap, and the per-topic docs you are reading
scripts/     install-systemd-user-service.sh
```

Key server files: `index.ts` (entrypoint + auth middleware + static serving), `routes/{auth,artifacts,actions,display,integrations}.ts` (HTTP routes, mounted by `routes/index.ts`), `artifacts.ts` (artifact model + link-root enforcement), `db.ts` (schema accessors + display config + action TTL sweep), `auth.ts` (pairing tokens + sessions), `sse.ts` (SSE client registry, targets, waiters, heartbeat), `state.ts` (surface state), `streams.ts` (stream chunks), `templates.ts` (template engine), `markdown.ts` (markdown renderer), `bindings.ts` (binding dispatch), `render.ts` (view shells + runtime injection + thumb placeholder), `presence.ts` (per-device presence), `thumbs.ts` (Chrome thumbnail capture), `migrations.ts` (`PRAGMA user_version` baseline), `paths.ts` (data dir), `startupAccess.ts` + `qrCode.ts` (startup pairing output).

## Runtime stack

- **Express 5** (`express@^5.1.0`) + **better-sqlite3** (`@^11.8.2`) — synchronous SQLite, no ORM.
- **`tsx`** runs TypeScript directly for the dev server and the service entrypoint — the server is never compiled. The **CLI** is the exception: `npm run build:cli` (run automatically by the `prepare` hook) bundles `bin/surface.ts` to `dist/surface.mjs` with esbuild, and the npm `bin` entry points at the bundle. `tsconfig.json` targets ES2022 with `strict: true` and exists mainly so `npx tsc --noEmit` can type-check (it excludes `archived/`).
- **Vanilla-JS client, no build step.** `client/index.html` loads `app.js` and `style.css` directly. Cache-bust client assets by bumping the `?v=N` query in `client/index.html` — this is the project convention for shipping client changes.
- **SSE** for all live updates (`server/sse.ts`); no WebSockets.
- Data lives under **`~/.surface/`** (`db.sqlite`, `artifacts/`, `auth-secret`, `install-state.json`, `logs/`, `templates/`, `thumbs/`), overridable with `SURFACE_DATA_DIR`. A pre-baseline `db.sqlite` is archived to `db.sqlite.bak` at boot, never migrated (`server/db.ts`).

## Scripts (`package.json`)

| Script | Command | Purpose |
| --- | --- | --- |
| `npm run dev` | `tsx server/index.ts` | Start the server on `127.0.0.1:3000`. |
| `npm run service` | `tsx server/index.ts` | Same entrypoint, used by the systemd unit. |
| `npm run cli` | `tsx bin/surface.ts` | Run the CLI from source without `npm link`. |
| `npm run build:cli` | `esbuild bin/surface.ts --bundle …` | Bundle the CLI to `dist/surface.mjs` (also runs via the `prepare` hook). |
| `npm run test:artifacts` | `tsx test/artifacts.ts` | Artifact HTTP regression test. |
| `npm run test:auth` | `tsx test/auth.ts` | Pairing/session auth acceptance tests. |
| `npm run test:startup-access` | `tsx test/startupAccess.ts` | Startup connection-string / QR unit tests. |
| `npm run test:e2e` | `tsx test/e2e.ts` | End-to-end test driving an LLM via OpenRouter. |

There is no aggregate `test` script and no test framework — each file is a standalone `tsx` program with its own `assert`/`check` helper. Type-check with `npx tsc --noEmit`.

## Test coverage

- **`test/artifacts.ts`** — drives a running server over HTTP (`SURFACE_URL`). Covers workspace artifacts (create, versioning, version list, rollback, file route reflecting the rolled-back version), surface cards and project filters, the artifact view shell, surface actions, **surface state** (version bumps, deep merge, `null` deletes), **the template engine** (a project-local template: listing, instantiation, state defaults, idempotent re-render, unknown template → 400) and **built-ins** (`ask` open→answered), and **stream chunks**. The linked-artifact block covers single-file link (`source_type=linked`, `storage_kind=external`, `storage_path` = realpath), directory link with entry + sibling fallback, linking a missing path → 400, `update`/`rollback` on linked → 409, `touch` → 200, URL-encoded path-traversal → 400, and the **symlink-escape** regression (a symlink inside a linked dir pointing outside must not leak bytes).
- **`test/auth.ts`** — spawns a real server **twice** with 35 checks. Boot 1 (loopback trusted): loopback resolves to the `system` role and mints a system bearer. Boot 2 (`SURFACE_TRUST_LOOPBACK=0`, same data dir): every request must authenticate — unauthenticated rejection of `/artifacts`/`/stream`, the bearer surviving the restart, the pairing lifecycle (mint, `pairingUrl` fragment, one-time consumption, reuse/expiry/revocation failures), the device capability split (devices can list/create/click/theme but not link/present/exec/state-write/inbox/mint), the device registry (`surface devices` listing, label-prefix revocation, immediate access loss), session listing/revocation, and logout.
- **`test/startupAccess.ts`** — pure unit tests for `resolveConnectionHost`/`resolveConnectionString`/`resolveListeningPort`, `buildPairingUrl`/`buildHostedPairingUrl`, and `renderTerminalQrCode` (no server needed).
- **`test/e2e.ts`** — requires `OPENROUTER_API_KEY`; gives an LLM tool definitions and verifies it can create, read, update, and delete an artifact end-to-end through the HTTP API.

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

`STATUS.md` is the one-screen summary of what is done and verified on the current `feature/artifact-architecture` branch — all four roadmap phases.

## Related
- [../architecture.md](../architecture.md) — system architecture
- [../roadmap.md](../roadmap.md) — planned work
- [install.md](install.md) — running and the systemd service
- [security.md](security.md) — security model summary
- [../core/cli.md](../core/cli.md) — CLI command reference
