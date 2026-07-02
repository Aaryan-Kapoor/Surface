# Installing and Running Surface

**Status:** Shipped (2026-06)
**Code:** `README.md`, `INSTALL_FOR_AGENTS.md`, `package.json`, `server/index.ts`, `server/startupAccess.ts`, `server/paths.ts`, `scripts/install-systemd-user-service.sh`

Surface is a single long-running Node service plus a vanilla-JS PWA, with a `surface` CLI as the agent client. The server and client have no build step; the CLI is bundled to a single file. This page covers requirements, running it (dev and as a systemd user service), the environment variables, startup pairing output, the agent bootstrap flow, and demo seeding.

## Requirements

- **Node 22+** (`@types/node` and `tsconfig` target ES2022; the server runs directly with `tsx` — only the CLI is bundled, to `dist/surface.mjs`).
- **`better-sqlite3`** — a native module, compiled on `npm install`.
- **Chrome/Chromium (optional)** — only needed for card thumbnails. Without it, dashboards fall back to SVG/icon placeholders (`server/index.ts`, `server/thumbs.ts`). Override the binary with `SURFACE_CHROME`.

## Running

```bash
git clone https://github.com/Aaryan-Kapoor/Surface.git
cd Surface
npm install
npm run dev        # tsx server/index.ts → app :3000, content :3100
```

`npm run service` is the same entrypoint (`tsx server/index.ts`), used by the systemd unit. Make the CLI available on `$PATH` with `npm link` — the npm `bin` entry points at the single-file bundle `dist/surface.mjs`, built automatically by the `prepare` hook (`npm run build:cli`). The bundle runs with plain `node`, so the installed `surface` command needs no repo toolchain; `npm run cli` still runs straight from source.

### systemd user service

`scripts/install-systemd-user-service.sh` writes `~/.config/systemd/user/surface.service`, runs `daemon-reload`, and `enable --now`. The generated unit pins `WorkingDirectory` to the clone, sets `NODE_ENV=production`, `SURFACE_BIND=127.0.0.1`, `SURFACE_URL=http://127.0.0.1:3000`, `ExecStart=npm run service`, and `Restart=on-failure`. The service name is overridable with `SURFACE_SERVICE_NAME` (default `surface`).

```bash
./scripts/install-systemd-user-service.sh
systemctl --user status surface.service --no-pager
journalctl --user -u surface.service -f
```

The intended posture is to run Surface **once** as this user service — agents reuse the running instance rather than starting a second one (`INSTALL_FOR_AGENTS.md`, operating rules).

## Environment variables

Read from `process.env` (via `dotenv/config`, so a repo-root `.env` works):

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Listen port (`server/index.ts`). |
| `SURFACE_CONTENT_PORT` | `3100` | Mandatory second listener for device-authored surface HTML. Must differ from `PORT`; isolated tests should set a unique value. |
| `SURFACE_CONTENT_ORIGIN` | — | External content origin used by the PWA when `host:SURFACE_CONTENT_PORT` is not directly reachable. |
| `SURFACE_BIND` | `127.0.0.1` | Bind host. A non-loopback bind triggers startup pairing output. |
| `SURFACE_TOKEN` | — | **Removed.** No longer accepted as a credential; a set variable is ignored and logs a startup warning. Remote agents use a `SURFACE_SESSION` bearer instead (`surface auth session issue --role system`). See [../auth/trust-model.md](../auth/trust-model.md). |
| `SURFACE_TRUST_LOOPBACK` | `1` | Trust requests from `127.0.0.1`/`::1` unconditionally. **Set `0` behind a same-host reverse proxy** (`server/index.ts`). See [security.md](security.md). |
| `SURFACE_PUBLIC_URL` | — | Externally reachable origin; used for printed pairing URLs and resolves a usable connection string for wildcard binds. |
| `SURFACE_PAIR_ON_START` | — | `1` forces a startup pairing token even on a loopback bind. |
| `SURFACE_CHROME` | autodetect | Path to the Chrome/Chromium binary for thumbnails (`server/thumbs.ts`). |
| `SURFACE_LINK_ROOTS` | — | Colon-separated absolute paths; restricts `POST /artifacts/link` to these roots (`server/artifacts.ts`). See [linked artifacts](../core/linked-artifacts.md). |
| `SURFACE_WEBHOOK_URL` | — | Optional external gateway base URL for action fan-out (`server/routes/actions.ts`). Legacy alias: `OPENCLAW_GATEWAY_URL`. |
| `SURFACE_WEBHOOK_TOKEN` | — | Bearer token sent with webhook posts; required for fan-out. Legacy alias: `OPENCLAW_HOOKS_TOKEN`. |
| `SURFACE_WEBHOOK_PATH` | `/hooks/agent` | Path appended to the webhook URL. |
| `OPENROUTER_API_KEY` | — | Required for `POST /api/chat`, which proxies to OpenRouter (`server/routes/integrations.ts`). Without it the endpoint errors; the rest of Surface works without it. |
| `OPENROUTER_MODEL` | `anthropic/claude-sonnet-4` | Default model for `/api/chat`. |
| `SURFACE_CHAT_RATE_LIMIT` | `30` | Per-minute rate limit on `/api/chat`. |
| `SURFACE_DATA_DIR` | `~/.surface` | Data directory (`db.sqlite` + `artifacts/`, plus `auth-secret`, `install-state.json`, `logs/`, `templates/`) (`server/paths.ts`). |
| `SURFACE_WORKSPACE_DIR` | — | Legacy override for the directory containing `artifacts/` (`server/paths.ts`). |

The CLI itself reads `SURFACE_URL` and `SURFACE_SESSION` — see [../core/cli.md](../core/cli.md).

`OPENROUTER_API_KEY` is confirmed in code: `/api/chat` is the only consumer, and it is the only path that spends OpenRouter quota.

## Startup pairing output

When Surface binds beyond loopback (or `SURFACE_PAIR_ON_START=1`), it mints a one-time pairing token at startup and prints a connection block (`server/index.ts`, `formatHeadlessAccessOutput` in `server/startupAccess.ts`):

```
Surface server is ready.
Connection string: http://<host>:<port>
Token: UKKD5N47XXZ8
Pairing URL: http://<host>:<port>/pair#token=UKKD5N47XXZ8
<terminal QR code>
```

The token rides in the URL **fragment**, never the query string. A wildcard bind (`0.0.0.0`) resolves to a concrete interface address instead of printing `0.0.0.0` (`resolveConnectionHost`, `server/startupAccess.ts`). The terminal QR is rendered by `server/qrCode.ts` via `renderTerminalQrCode`. `SURFACE_PUBLIC_URL` overrides the printed origin. See [device pairing](../auth/device-pairing.md) and [security.md](security.md).

## Agent bootstrap (`INSTALL_FOR_AGENTS.md`)

The canonical first-run routine for agents. Install state lives at **`~/.surface/install-state.json`** — a JSON file the agent reads first and updates as it progresses (the doc itself stays clean; older installs that kept the state as YAML frontmatter inside `INSTALL_FOR_AGENTS.md` migrate their values into the JSON file). Fields:

- `service` — `pending | running | not_installed | failed` (is the service reachable on `127.0.0.1:3000`).
- `skill_saved_to` — absolute path where `SKILL.md` was copied into the agent's skills directory, or null.
- `tutorial` — `pending | in_progress | complete | skipped`.
- `surface_version`, `installed_at` — stamped on first complete install.
- `notes` — free-form for the next run.

The flow: check the service (offer to install the systemd unit), copy `SKILL.md` into the agent's skills directory, optionally run the tutorial, then stamp the state. An early-exit clause lets re-runs skip when the service is running, `SKILL.md` is in place, and the tutorial is done/skipped.

## Demo seeding

The tutorial uses the bundled example surfaces in `examples/demos/`:

- `surface seed-demos` — links each demo as a linked artifact tagged `metadata.demo = true`. Idempotent: if a previous `clear-demos` left a row archived, it un-hides it in place rather than re-linking.
- `surface clear-demos` — flips `metadata.hidden = true` on every demo-tagged row so they vanish from the dashboard. The artifact records are kept, so `seed-demos` can revive them.

The same demos back the empty-state idea portal in the PWA (served at `/demos/`, `server/index.ts`).

## Tutorial

`docs/TUTORIAL.md` is the seven-step user-facing onboarding script the agent narrates on first install. The PWA's "Start Tutorial" button hands the user a copy-paste prompt pointing at it (`client/app.js`).

## Related
- [security.md](security.md) — trust model, exposing beyond loopback
- [development.md](development.md) — repo layout, tests, conventions
- [../auth/device-pairing.md](../auth/device-pairing.md) — pairing flow detail
- [../core/cli.md](../core/cli.md) — full CLI reference
- [../core/linked-artifacts.md](../core/linked-artifacts.md) — `surface link` and `SURFACE_LINK_ROOTS`
