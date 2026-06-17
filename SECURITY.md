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

Surface data and control routes such as `/artifacts/*`, `/stream`, `/display/*`, and credential-management endpoints still require loopback trust, a session cookie, or a session bearer token.

### Authentication order and roles

Every request resolves auth in this order: trusted loopback → `surface_session` cookie → `Authorization: Bearer <session-token>` → 401. Cookies are the right transport for `EventSource`/SSE (`/stream`, `/artifacts/:id/stream`), which cannot set custom headers.

Two roles (see `docs/auth/trust-model.md`): **`system`** — loopback and explicitly minted system bearers; full power. **`device`** — paired displays; viewing, clicking, workspace-artifact CRUD, presence, and display control only. Anything that touches the host filesystem (`link`, `present-file`), executes code (`exec`), drains the action inbox, writes surface state, registers bindings, or mints credentials requires `system`.

The static `SURFACE_TOKEN` credential is **removed** (2026-06). A set env var is ignored with a startup warning. Remote agents mint a revocable, hashed session bearer instead: `surface auth session issue --role system --label <where>`, carried as `SURFACE_SESSION` in the agent's environment.

### `SURFACE_TRUST_LOOPBACK` — read this before proxying

Loopback (`127.0.0.1`/`::1`) is trusted unconditionally **by default** (`SURFACE_TRUST_LOOPBACK=1`).

**If you front Surface with a reverse proxy on the same host (Tailscale Serve, Caddy, Nginx, Cloudflare Tunnel), every proxied request arrives from `127.0.0.1` and would be trusted with no pairing.** In that deployment you **must** set `SURFACE_TRUST_LOOPBACK=0` so Surface authenticates by session instead of by source address. Trusting loopback is only safe when Surface binds the externally reachable interface directly.

The recommended posture is still to front Surface with a reverse proxy that handles TLS, set `SURFACE_TRUST_LOOPBACK=0`, and pair browsers through `/pair` over HTTPS.

## Dangerous Primitives

These endpoints exist by design and exist for agent control. They are powerful enough to be worth calling out explicitly:

- `POST /artifacts/present-file` reads any local file the Surface process can read and stores its content as an artifact. Anyone with **system-plane** access can read SSH keys, `.env`, source files, etc. (Paired devices cannot call it.)
- `POST /artifacts/link` registers an absolute path on disk as a live artifact (system-plane only). The bytes are re-served on every request, so the file remains readable through Surface for the lifetime of the registration. See `SURFACE_LINK_ROOTS` below to narrow the allowed paths.
- `POST /artifacts/:id/exec` injects arbitrary JavaScript into a surface's iframe in the user's browser (system-plane only).
- `POST /artifacts/:id/bindings` registers a command Surface will execute when a user clicks (system-plane only; the command is argv-tokenized — never run through a shell — and click data only ever reaches it on stdin). Captured output lands in `~/.surface/logs/bindings/`.
- `GET /proxy/pdf?url=...` is a server-side fetch; it refuses URLs resolving to loopback/private/metadata addresses but is still an outbound fetch on your behalf.
- `POST /api/chat` proxies to OpenRouter using the host's `OPENROUTER_API_KEY`. Anyone with API access can spend that quota (rate-limited per minute).

These are not bugs; they are why the system/device split exists and why non-loopback access requires pairing.

### Surface content isolation

Surface HTML renders in same-origin iframes by design — the injected `surface.js` runtime needs same-origin `fetch`/SSE for state and actions. The PWA applies an iframe `sandbox` attribute that blocks top-navigation and modal abuse, but a malicious surface *script* still runs same-origin. The trust assumption is explicit: surfaces are authored by the user's own agents on the user's own machine. Don't link or present HTML from sources you don't trust. (A second-origin content domain was considered and deferred — it complicates pairing and remote access for a single-user tool; revisit if the trust assumption changes.)

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
