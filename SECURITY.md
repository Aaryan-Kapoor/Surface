# Surface Security

Surface is a self-hosted local service. It is designed for a single user running it as a personal display, with multiple trusted AI agents connected to it through the `surface` CLI or HTTP.

## Threat Model

Surface trusts:

- **The local user.** Anyone with shell access to the host can do anything Surface can do.
- **Every connected agent.** Agents that can reach the HTTP API (directly or via the CLI) have the same authority as the local user over Surface's content, display, and proxies. There is no per-agent capability scoping.
- **Every artifact's HTML/JS.** Surfaces execute in iframes loaded from the Surface origin. Code inside a surface can call any HTTP endpoint Surface exposes, read every other artifact, and use the LLM proxy. Treat artifact authors the same way you treat agents.

Surface does **not** protect against:

- A malicious or compromised agent connected via the CLI or HTTP.
- A malicious surface installed by a trusted agent.
- A hostile party on the same network when Surface binds to a non-loopback address without a token.
- Anyone with read access to `~/.surface/` or the SQLite database.

## Defaults

- Surface binds to `127.0.0.1` by default. Only the local host can reach the HTTP API.
- All data lives under `~/.surface/` (override with `SURFACE_DATA_DIR`).
- The marketplace is disabled by default.

## Exposing Surface Beyond Loopback

Surface authenticates non-loopback access with **one-time pairing tokens** that are exchanged for **durable sessions**:

- `pairing_tokens` are short-lived (5 min default), single-use credentials, drawn from a human-friendly alphabet, used only to establish trust.
- `sessions` are long-lived (30 day default) credentials representing a paired browser, CLI, or agent. They are delivered as an `HttpOnly` cookie (`surface_session`) for browsers and usable as `Authorization: Bearer <session-token>` for CLI/agents.

Only `owner`-role credentials exist today; scoped `client` roles may be added later.

Both pairing tokens and session tokens are stored only as `sha256(serverSecret:token)` hashes. The `serverSecret` lives at `~/.surface/auth-secret` (mode `0600`), so a leaked database (see below) does not directly yield usable credentials.

### Pairing flow

When Surface binds to a non-loopback address (or `SURFACE_PAIR_ON_START=1`), it mints and prints a one-time token at startup:

```
Surface server is ready.
Connection string: https://surface-host
Token: UKKD5N47XXZ8
Pairing URL: https://surface-host/pair#token=UKKD5N47XXZ8
```

Startup output also includes a terminal QR code for the pairing URL. If Surface binds a wildcard host such as `0.0.0.0`, the printed connection string resolves to a concrete network interface address instead of `0.0.0.0`.

The token rides in the URL **fragment**, never the query string, so it does not reach server logs. A new browser opens `/pair`, the page strips the token from the URL, exchanges it at `POST /api/auth/bootstrap`, and receives a session cookie.

To create another pairing link from a trusted local shell, run:

```
surface pair --base-url https://surface-host
```

For hosted pairing pages that need to remember the backend separately, use:

```
surface pair --base-url https://backend-host --hosted-url https://surface-host
```

Use `surface auth pairing …` and `surface auth session …` for lower-level credential management, or the `/api/auth/*` endpoints when building integrations.

Set `SURFACE_PUBLIC_URL` to the externally reachable origin so printed pairing URLs are clickable from another device.

### What is public before pairing

Unauthenticated access is limited to the bootstrap path only:

- the app shell files needed to load and redirect (`/`, `/index.html`, `/app.js`, `/style.css`, `/manifest.json`, `/pair`, `/pair.html`, `/favicon.ico`)
- `GET /api/auth/session`, which reports whether the browser already has a valid session
- `POST /api/auth/bootstrap`, which exchanges a valid one-time pairing token for a session cookie

Surface data and control routes such as `/surfaces`, `/artifacts/*`, `/stream`, `/display/*`, and credential-management endpoints still require loopback trust, a session cookie, a session bearer token, or the static `SURFACE_TOKEN`.

### Authentication order

Every request resolves auth in this order: trusted loopback → `surface_session` cookie → `Authorization: Bearer <session-token>` → static `SURFACE_TOKEN` → 401. Cookies are the right transport for `EventSource`/SSE (`/stream`, `/surfaces/:id/stream`), which cannot set custom headers.

`SURFACE_TOKEN` remains valid as a static `owner` Bearer credential (and via `?token=` / the legacy `surface_token` cookie) so existing CLI/agent configs keep working.

### `SURFACE_TRUST_LOOPBACK` — read this before proxying

Loopback (`127.0.0.1`/`::1`) is trusted unconditionally **by default** (`SURFACE_TRUST_LOOPBACK=1`).

**If you front Surface with a reverse proxy on the same host (Tailscale Serve, Caddy, Nginx, Cloudflare Tunnel), every proxied request arrives from `127.0.0.1` and would be trusted with no pairing.** In that deployment you **must** set `SURFACE_TRUST_LOOPBACK=0` so Surface authenticates by session instead of by source address. Trusting loopback is only safe when Surface binds the externally reachable interface directly.

The recommended posture is still to front Surface with a reverse proxy that handles TLS, set `SURFACE_TRUST_LOOPBACK=0`, and pair browsers through `/pair` over HTTPS.

## Dangerous Primitives

These endpoints exist by design and exist for agent control. They are powerful enough to be worth calling out explicitly:

- `POST /artifacts/present-file` reads any local file the Surface process can read and stores its content as an artifact. Anyone with API access can read SSH keys, `.env`, source files, etc.
- `POST /artifacts/link` registers an absolute path on disk as a live artifact. The bytes are re-served on every request, so the file remains readable through Surface for the lifetime of the registration. See `SURFACE_LINK_ROOTS` below to narrow the allowed paths.
- `POST /surfaces/:id/exec` injects arbitrary JavaScript into a surface's iframe in the user's browser.
- `GET /proxy/pdf?url=...` is an unrestricted server-side fetch. It can reach loopback ports, RFC1918 ranges, and cloud metadata endpoints.
- `POST /api/chat` proxies to OpenRouter using the host's `OPENROUTER_API_KEY`. Anyone with API access can spend that quota.

These are not bugs. They are why Surface requires authenticated access for non-loopback binds.

## Narrowing Linked Artifacts

By default, `POST /artifacts/link` accepts any path the Surface process can read. To restrict it, set:

```
SURFACE_LINK_ROOTS=/home/user/projects:/srv/work
```

Colon-separated absolute paths. `link` refuses any path not under one of these roots. Both the candidate path and the configured roots are resolved with `fs.realpathSync` before the containment check, so a symlink pointing outside a root (or a symlinked root pointing into the configured path) cannot smuggle the real target past the gate. Prefix matching is separator-aware to prevent `~/projects-evil` from satisfying `~/projects`.

Independent of `artifact_present_file`, which still copies bytes on read.

## Symlinks Inside Linked Directories

The file route `GET /artifacts/<id>/files/<relpath>` resolves the requested path through `fs.realpathSync` before reading. If the realpath escapes the registered linked root, the request returns `403 Path escapes linked root`. This protects against a symlink being added to the linked directory after registration whose target is outside that directory. The realpath check runs even when the lexical containment check passes.

The exception is a **single-file link of a symlink**: `POST /artifacts/link` with a path that is itself a symlink follows the symlink at link time. The artifact's `storage_path` becomes the realpath of the target, the workspace root becomes the realpath's parent, and `SURFACE_LINK_ROOTS` is enforced against the realpath. This is consistent with the trust model — agents choose the paths they pass to `link`, and `SURFACE_LINK_ROOTS` is the mechanism for narrowing that trust.

## Reporting Vulnerabilities

Open a GitHub issue tagged `security`, or email the maintainer. Please do not include exploit details in public issues until a fix is available.
