# Installing and Running Surface

**Status:** Shipped (2026-06)
**Code:** `README.md`, `INSTALL_FOR_AGENTS.md`, `package.json`, `server/index.ts`, `server/startupAccess.ts`, `server/paths.ts`, `scripts/install-systemd-user-service.sh`

Surface is a single long-running Node service plus a vanilla-JS PWA, with a `surface` CLI as the agent client. The server and client have no build step in the browser sense; both the CLI and the server are bundled to single files in `dist/` (`scripts/build.mjs`, run by the `prepare` hook). This page covers requirements, installing (npm package and repo clone), the service supervisor, the environment variables, startup pairing output, the agent bootstrap flow, and demo seeding.

## Requirements

- **Node 22+** (`engines` in `package.json`; `tsconfig` targets ES2022). The floor tracks `better-sqlite3` prebuilt-binary coverage — a fresh machine has no compiler toolchain, so a Node version without a prebuild means a failed install (`scripts/test-fresh-install.sh` guards this; Node 20 was dropped in 0.2.4 after its prebuilds ended). The dependency is pinned to the **v12** line deliberately: v13 publishes no prebuilt binaries and has no install script, so npm falls back to compiling it with `node-gyp`. When bumping this dependency, check that the target version actually ships prebuilds for every ABI/platform pair we support.
- **`better-sqlite3`** — a native module, installed as a regular dependency (it stays external to the server bundle).
- **Chrome/Chromium (optional)** — only needed for card thumbnails. Without it, dashboards fall back to SVG/icon placeholders (`server/index.ts`, `server/thumbs.ts`). Override the binary with `SURFACE_CHROME`.

## Installing

The published package is **`surface-display`** (the command is still `surface`):

```bash
npm install -g surface-display
surface service install    # register + start the per-user service, health-gated
```

Working from a repo clone instead:

```bash
git clone https://github.com/Aaryan-Kapoor/Surface.git
cd Surface
npm install        # prepare hook bundles CLI + server into dist/
npm run dev        # foreground dev server → app :3000, content :3100
npm link           # optional: local `surface` on $PATH
```

### The service supervisor (`surface service`)

`surface service install` writes and starts the native per-user supervisor —
a systemd user unit on Linux (`~/.config/systemd/user/<name>.service`), a
launchd LaunchAgent on macOS (`~/Library/LaunchAgents/com.surface-display.<name>.plist`),
or a Scheduled Task at logon on Windows. All three exec the same
`node dist/server.mjs --log-file … [--port …]` argv, restart on failure
(Linux/macOS natively; Windows via task restart settings), and log to
`~/.surface/logs/<name>.log`, which `surface service logs` reads identically
everywhere. The install succeeds only once `/healthz` answers and the content
plane accepts connections; if another server already holds the port it
refuses rather than fight it.

```bash
surface service health         # /healthz + content-plane probe; exit 0/1; --json
surface service status         # supervisor view: registered? running? where?
surface service logs --follow
surface service start|stop|restart|uninstall
surface service install --name surface-test --port 3457 --content-port 3557 --data-dir /tmp/x   # isolated second instance
```

`scripts/install-systemd-user-service.sh` survives as a thin wrapper over
`surface service install` (it honors `SURFACE_SERVICE_NAME`).

### Update notification and one-click update

The PWA home carries a small release notice in the grid header
(`client/app.js`, `server/updates.ts`, `server/routes/updates.ts`):

```
Surface 0.2.4 available   [ Update ]
```

**The check.** The server asks the npm registry for `surface-display@latest`
on a self-rearming timer — first run 30 seconds after boot, then once per TTL
(`SURFACE_UPDATE_CHECK_TTL_HOURS`, default 6). The answer is cached in memory
and written through to `<data-dir>/update-check.json`, so a restart does not
re-ask. `GET /api/update/status` serves **that cache only and never touches
the network**, which is why an offline host answers instantly instead of
holding a page load open on a dead socket. A failed check keeps the last known
good version, records the reason, and backs off (30 min × consecutive
failures, capped at the TTL) rather than retrying in a loop — it logs nothing.
The check is **off by default under `NODE_ENV=test` and in CI**; set
`SURFACE_UPDATE_CHECK=0` to turn it off anywhere else, or `=1` to force it on.

**The button.** It is offered only where it can actually work:

| Install | Notice | Button |
| --- | --- | --- |
| Global (`npm install -g surface-display`) | ✓ | ✓ |
| Repo clone (`git clone` + `npm run dev`) | ✓ | ✗ — "this is a repo clone — update with: `git pull && npm install && npm test`" |
| Project-local (`npm i surface-display` in a project) | ✓ | ✗ — "update with: `npm update surface-display` (in that project)" |
| Paired device (phone, tablet) | ✓ | ✗ — "open Surface on the host (or run `surface upgrade` there)" |

The context is detected by the same `installContext()` `surface upgrade` uses,
so the two can never disagree. The device-plane refusal is a trust-model
decision, not an oversight — see
[../auth/trust-model.md](../auth/trust-model.md#why-the-update-button-is-system-only).

**The apply.** `POST /api/update/apply` (system plane only) starts exactly one
thing: `surface upgrade --json --name <this service> --progress-file
<data-dir>/update-state.json`, detached, with a fixed argv and no shell. There
is no second upgrade path — the converger updates the package, refreshes the
skill copies and links, and restarts the service through the supervisor,
health-gated, exactly as it does from a terminal. No daemon is introduced and
nothing runs unsupervised.

Because the converger restarts the service, it kills its own process on
systemd (the child lives in the unit's cgroup). That is expected and designed
for: each phase is written to the progress file **before** the step it names,
and the restarted server reconciles the last phase against the version it is
now running — landing on `done` if the new version is live, or `failed`
("Surface restarted but is still running 0.2.3") if it is not. A run that
stops reporting for ten minutes is reported failed rather than spinning
forever. Failures are never reported optimistically: a broken npm install
(a dependency with no prebuilds, a registry 500) ends the run as `failed` with
npm's exit status, and the package on disk is untouched.

In the PWA the flow reads: **Update** → "Installing 0.2.4…" → "Restarting
Surface…" (the connection drops here — the process serving the page is the one
being replaced) → the shell reconnects, reloads once so the client bundle
matches the new server, and shows "Updated to 0.2.4". If the service does not
come back within two minutes the notice says so and points at
`surface service health` instead of spinning.

`surface upgrade` and `surface upgrade --check` from a terminal remain the
canonical path and are unchanged.

The intended posture is to run Surface **once** as this user service — agents reuse the running instance rather than starting a second one (`INSTALL_FOR_AGENTS.md`, operating rules). Agents must never improvise a hidden background server when an install fails; recording `failed` and stopping is the sanctioned outcome.

## Environment variables

Read from `process.env` (via `dotenv/config`, so a `.env` in the server's
working directory works — the service backends set that to the data dir).
Supervisors that cannot set environment variables (Windows Scheduled Tasks)
pass flags instead: the server maps `--port`, `--content-port`, `--bind`,
`--data-dir`, and `--log-file` onto the corresponding variables at startup,
and flags win over `.env` (`server/index.ts`).

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
| `SURFACE_LOG_FILE` | — | Tee server stdout/stderr into this append-only file with timestamps (`server/logging.ts`); how every `surface service` backend captures logs. |
| `SURFACE_UPDATE_CHECK` | on (off in tests/CI) | `0` disables the cached npm release check entirely; `1` forces it on under `NODE_ENV=test`/`CI` (`server/updates.ts`). |
| `SURFACE_UPDATE_CHECK_TTL_HOURS` | `6` | How long a release check is cached before the next one is due. |
| `SURFACE_UPDATE_CHECK_DELAY_MS` | `30000` | Delay before the first check after boot. Lowered by the test suite; no reason to change it in production. |
| `SURFACE_NPM_REGISTRY` | `https://registry.npmjs.org` | Registry queried by the release check and by `surface upgrade`. |
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

The flow: check the service with `surface service health` (offer `surface service install` if absent — never an improvised background process), copy `SKILL.md` into the agent's skills directory, optionally run the tutorial, then stamp the state. An early-exit clause lets re-runs skip when the service is running, `SKILL.md` is in place, and the tutorial is done/skipped.

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
