# Installing and Running Surface

**Status:** Shipped
**Code:** `README.md`, `INSTALL_FOR_AGENTS.md`, `package.json`, `server/index.ts`, `server/startupAccess.ts`, `server/paths.ts`, `scripts/install-systemd-user-service.sh`

Surface is a single long-running Node service plus a vanilla-JS PWA, with a `surface` CLI as the agent client. There is no build step. This page covers requirements, running it (dev and as a systemd user service), the environment variables, startup pairing output, the agent bootstrap flow, and demo seeding.

## Requirements

- **Node 22+** (`@types/node` and `tsconfig` target ES2022; the codebase is run directly with `tsx`, never compiled to `dist` for production).
- **`better-sqlite3`** — a native module, compiled on `npm install`.
- **Chrome/Chromium (optional)** — only needed for card thumbnails. Without it, dashboards fall back to SVG/icon placeholders (`server/index.ts:165`, `server/thumbs.ts`). Override the binary with `SURFACE_CHROME`.

## Running

```bash
git clone https://github.com/Aaryan-Kapoor/Surface.git
cd Surface
npm install
npm run dev        # tsx server/index.ts → http://127.0.0.1:3000
```

`npm run service` is the same entrypoint (`tsx server/index.ts`), used by the systemd unit. Make the CLI available on `$PATH` with `npm link` (creates a global symlink to `bin/surface.ts`), or invoke it directly via `node_modules/.bin/surface` / `npx tsx bin/surface.ts`.

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
| `PORT` | `3000` | Listen port (`server/index.ts:19`). |
| `SURFACE_BIND` | `127.0.0.1` | Bind host. A non-loopback bind triggers startup pairing output (`server/index.ts:20,148`). |
| `SURFACE_TOKEN` | — | Static owner Bearer credential; also accepted via `?token=` and the legacy `surface_token` cookie (`server/index.ts:23,77`). Unhashed, no expiry. |
| `SURFACE_TRUST_LOOPBACK` | `1` | Trust requests from `127.0.0.1`/`::1` unconditionally. **Set `0` behind a same-host reverse proxy** (`server/index.ts:32`). See [security.md](security.md). |
| `SURFACE_PUBLIC_URL` | — | Externally reachable origin; used for printed pairing URLs and resolves a usable connection string for wildcard binds (`server/index.ts:39`). |
| `SURFACE_PAIR_ON_START` | — | `1` forces a startup pairing token even on a loopback bind (`server/index.ts:148`). |
| `SURFACE_CHROME` | autodetect | Path to the Chrome/Chromium binary for thumbnails (`server/thumbs.ts:35`). |
| `SURFACE_LINK_ROOTS` | — | Colon-separated absolute paths; restricts `POST /artifacts/link` to these roots (`server/artifacts.ts:453`). See [linked artifacts](../core/linked-artifacts.md). |
| `SURFACE_WEBHOOK_URL` | — | Optional external gateway base URL for action fan-out (`server/routes.ts:11`). Legacy alias: `OPENCLAW_GATEWAY_URL`. |
| `SURFACE_WEBHOOK_TOKEN` | — | Bearer token sent with webhook posts; required for fan-out (`server/routes.ts:12`). Legacy alias: `OPENCLAW_HOOKS_TOKEN`. |
| `SURFACE_WEBHOOK_PATH` | `/hooks/agent` | Path appended to the webhook URL (`server/routes.ts:13`). |
| `OPENROUTER_API_KEY` | — | Required for `POST /api/chat`, which proxies to OpenRouter (`server/routes.ts:1068,1095`). Without it the endpoint returns 500; the rest of Surface works without it. |
| `OPENROUTER_MODEL` | `anthropic/claude-sonnet-4` | Default model for `/api/chat` (`server/routes.ts:1069`). |
| `SURFACE_CHAT_RATE_LIMIT` | `30` | Per-minute rate limit on `/api/chat` (`server/routes.ts:1070`). |
| `SURFACE_DATA_DIR` | `~/.surface` | Data directory (`db.sqlite` + `artifacts/`, plus `auth-secret`) (`server/paths.ts:16`). |
| `SURFACE_WORKSPACE_DIR` | — | Legacy override for the directory containing `artifacts/` (`server/paths.ts:31`). |

`OPENROUTER_API_KEY` is confirmed in code: `/api/chat` is the only consumer, and it is the only path that spends OpenRouter quota.

## Startup pairing output

When Surface binds beyond loopback (or `SURFACE_PAIR_ON_START=1`), it mints a one-time pairing token at startup and prints a connection block (`server/index.ts:148`, `formatHeadlessAccessOutput` in `server/startupAccess.ts:91`):

```
Surface server is ready.
Connection string: http://<host>:<port>
Token: UKKD5N47XXZ8
Pairing URL: http://<host>:<port>/pair#token=UKKD5N47XXZ8
<terminal QR code>
```

The token rides in the URL **fragment**, never the query string. A wildcard bind (`0.0.0.0`) resolves to a concrete interface address instead of printing `0.0.0.0` (`resolveConnectionHost`, `server/startupAccess.ts:33`). The terminal QR is rendered by `server/qrCode.ts` via `renderTerminalQrCode`. `SURFACE_PUBLIC_URL` overrides the printed origin. See [device pairing](../auth/device-pairing.md) and [security.md](security.md).

## Agent bootstrap (`INSTALL_FOR_AGENTS.md`)

The canonical first-run routine for agents. It carries a YAML frontmatter **state block** that the agent edits locally (and does not commit upstream):

- `service` — `pending | running | not_installed | failed` (is the service reachable on `127.0.0.1:3000`).
- `skill_saved_to` — absolute path where `SKILL.md` was copied into the agent's skills directory, or null.
- `tutorial` — `pending | in_progress | complete | skipped`.
- `surface_version`, `installed_at` — stamped on first complete install.
- `notes` — free-form for the next run.

The flow: check the service (offer to install the systemd unit), copy `SKILL.md` into the agent's skills directory, optionally run the tutorial, then stamp the state. An early-exit clause lets re-runs skip when the service is running, `SKILL.md` is in place, and the tutorial is done/skipped.

## Demo seeding

The tutorial uses seven example surfaces in `examples/demos/` (`3d-astronaut.html`, `maps-apple-park.html`, `pacman.html`, `spotify-rickroll.html`, `tweet-trq212.html`, `windy-globe.html`, `yatch-problem.html`):

- `surface seed-demos` — links each demo as a linked artifact tagged `metadata.demo = true` (`bin/surface.ts:357`). Idempotent: if a previous `clear-demos` left a row archived, it un-hides it in place rather than re-linking.
- `surface clear-demos` — flips `metadata.hidden = true` on every demo-tagged row so they vanish from the dashboard (`bin/surface.ts:402`). The artifact records are kept, so `seed-demos` can revive them. Note the CLI help text labels this "Delete" but it actually soft-hides.

The same demos back the empty-state idea portal in the PWA (served at `/demos/`, `server/index.ts:139`).

## Tutorial

`docs/TUTORIAL.md` is the seven-step user-facing onboarding script the agent narrates on first install. The PWA's "Start Tutorial" button hands the user a copy-paste prompt pointing at it (`client/app.js:149`).

## Related
- [security.md](security.md) — trust model, exposing beyond loopback
- [development.md](development.md) — repo layout, tests, conventions
- [../auth/device-pairing.md](../auth/device-pairing.md) — pairing flow detail
- [../core/cli.md](../core/cli.md) — full CLI reference
- [../core/linked-artifacts.md](../core/linked-artifacts.md) — `surface link` and `SURFACE_LINK_ROOTS`
