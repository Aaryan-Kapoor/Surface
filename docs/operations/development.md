# Developing Surface

**Status:** Shipped
**Code:** `AGENTS.md`, `.claude/claude.md`, `STATUS.md`, `package.json`, `tsconfig.json`, `test/`

How to work on Surface itself: repo layout, the runtime stack, the npm scripts, what each test covers, and the project conventions.

## Repo layout

```
server/      Express app, routes, DB, auth, SSE, thumbnails, migrations
client/      Vanilla-JS PWA (app.js, style.css, index.html, pair.html, manifest.json)
bin/         surface.ts — the CLI (canonical agent client)
examples/    demos/ — seven example surfaces used by the tutorial + idea portal
archived/    mcp.ts — the legacy MCP stdio adapter (not maintained)
test/        artifacts.ts, auth.ts, e2e.ts, startupAccess.ts
docs/        architecture, roadmap, and the per-topic docs you are reading
scripts/     install-systemd-user-service.sh
```

Key server files: `index.ts` (entrypoint + auth middleware + static serving), `routes.ts` (all HTTP routes), `artifacts.ts` (artifact model + link-root enforcement), `db.ts` (schema accessors + display config), `auth.ts` (pairing tokens + sessions), `sse.ts` (SSE client registry), `thumbs.ts` (Chrome thumbnail capture), `migrations.ts` (`PRAGMA user_version`), `paths.ts` (data dir + legacy migration), `startupAccess.ts` + `qrCode.ts` (startup pairing output).

## Runtime stack

- **Express 5** (`express@^5.1.0`) + **better-sqlite3** (`@^11.8.2`) — synchronous SQLite, no ORM.
- **`tsx`** runs TypeScript directly for the dev server, the service entrypoint, and the CLI — there is no compiled `dist/` for production. `tsconfig.json` targets ES2022 with `strict: true` and exists mainly so `npx tsc --noEmit` can type-check (it excludes `archived/`).
- **Vanilla-JS client, no build step.** `client/index.html` loads `app.js` and `style.css` directly. Cache-bust client assets by bumping the `?v=N` query in `client/index.html` (both `style.css?v=56` and `app.js?v=56` currently) — this is the project convention for shipping client changes.
- **SSE** for all live updates (`server/sse.ts`); no WebSockets.
- Data lives under **`~/.surface/`** (`db.sqlite`, `artifacts/`, `auth-secret`), overridable with `SURFACE_DATA_DIR`; legacy paths auto-migrate on boot (`server/paths.ts`).

## Scripts (`package.json`)

| Script | Command | Purpose |
| --- | --- | --- |
| `npm run dev` | `tsx server/index.ts` | Start the server on `127.0.0.1:3000`. |
| `npm run service` | `tsx server/index.ts` | Same entrypoint, used by the systemd unit. |
| `npm run cli` | `tsx bin/surface.ts` | Run the CLI from source without `npm link`. |
| `npm run test:artifacts` | `tsx test/artifacts.ts` | Artifact HTTP regression test. |
| `npm run test:auth` | `tsx test/auth.ts` | Pairing/session auth acceptance tests. |
| `npm run test:startup-access` | `tsx test/startupAccess.ts` | Startup connection-string / QR unit tests. |
| `npm run test:e2e` | `tsx test/e2e.ts` | End-to-end test driving an LLM via OpenRouter. |

There is no aggregate `test` script and no test framework — each file is a standalone `tsx` program with its own `assert`/`check` helper. Type-check with `npx tsc --noEmit`.

## Test coverage

- **`test/artifacts.ts`** — drives a running server over HTTP (`SURFACE_URL`). Covers workspace artifacts (create, versioning to v2, version list, rollback to v1, file route reflecting the rolled-back version), legacy `/surfaces` create mirroring into an HTML artifact, surface cards, the artifact view shell, and surface actions. The linked-artifact block covers single-file link (`source_type=linked`, `storage_kind=external`, `storage_path` = realpath), directory link with entry + sibling fallback, linking a missing path → 400, `update`/`rollback` on linked → 409, `touch` → 200, URL-encoded path-traversal → 400, and the **symlink-escape** regression (a symlink inside a linked dir pointing outside must not leak bytes).
- **`test/auth.ts`** — spawns a real server with `SURFACE_TRUST_LOOPBACK=0` and a static `SURFACE_TOKEN`, then exercises the full pairing/session lifecycle: unauthenticated rejection of `/surfaces`/`/stream`, owner minting a pairing token, the `pairingUrl` fragment, one-time consumption, cookie + Bearer auth, reuse/expiry/revocation failures, SSE under a paired browser, session listing/revocation, and logout.
- **`test/startupAccess.ts`** — pure unit tests for `resolveConnectionHost`/`resolveConnectionString`/`resolveListeningPort`, `buildPairingUrl`/`buildHostedPairingUrl`, and `renderTerminalQrCode` (no server needed).
- **`test/e2e.ts`** — requires `OPENROUTER_API_KEY`; gives an LLM tool definitions and verifies it can create, read, update, and delete an artifact end-to-end through the HTTP API.

## Data location

Everything Surface owns lives under `~/.surface/`: `db.sqlite` (+ WAL/SHM), the `artifacts/` workspace store, and `auth-secret` (mode `0600`). Override the directory with `SURFACE_DATA_DIR`. A legacy DB at the repo root (`surfaces.db`) and a legacy `~/surface/artifacts/` are copied forward on first boot (`server/paths.ts:37`).

## Archived MCP adapter

Surface previously shipped an MCP stdio adapter. It now lives at `archived/mcp.ts` and is **not maintained** (`archived/README.md`). It still calls the same HTTP API, so it functions if invoked directly (`npx tsx archived/mcp.ts`), but it has no bin entry, is excluded from `tsconfig.json`, and is not part of the supported agent contract — the CLI + `SKILL.md` is the canonical path.

## Conventions

- **No new dependencies without a clear reason.** The client has zero runtime dependencies; the server has five (`better-sqlite3`, `dotenv`, `express`, `uuid`, and `@modelcontextprotocol/sdk`, the last only used by the archived adapter).
- **Plain, single-line commit messages.** No Codex/Anthropic/AI co-author or attribution lines (`AGENTS.md`, `.claude/claude.md`).
- Prefer **updating an existing artifact** over creating duplicates; use stable artifact ids for recurring purposes.
- Bump `?v=N` in `client/index.html` whenever you change client assets.
- Never commit `.env`, `~/.surface/` contents, or local edits to the `INSTALL_FOR_AGENTS.md` state block. `.mcp.json` is gitignored.

`STATUS.md` tracks what is done/verified on the current `feature/artifact-architecture` branch and lists deferred work (iframe sandboxing, `If-Match` preconditions, the N+1 grid fetch, SSE keepalive, legacy `surfaces` table removal).

## Related
- [../architecture.md](../architecture.md) — system architecture and deferred issues
- [../roadmap.md](../roadmap.md) — planned work
- [install.md](install.md) — running and the systemd service
- [security.md](security.md) — security model summary
- [../core/cli.md](../core/cli.md) — CLI command reference
