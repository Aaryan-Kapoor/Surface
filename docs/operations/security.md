# Security Model Summary

**Status:** Shipped
**Code:** `SECURITY.md` (canonical), `server/index.ts` (auth middleware), `server/auth.ts` (token hashing/sessions), `server/routes.ts` (dangerous primitives), `server/artifacts.ts` (link-root enforcement)

This page summarizes Surface's security posture and points at the relevant code. **[SECURITY.md](../../SECURITY.md) at the repo root is canonical** — defer to it for the full threat model and reporting process. The claims below were verified against the implementation.

## Trust model

Surface is a single-user, self-hosted local service. It trusts three things by design:

- **The local user** — anyone with shell access to the host has the same authority as Surface.
- **Every connected agent** — anything that can reach the HTTP API (directly or via the CLI) has full authority over content, display, and proxies. There is **no per-agent capability scoping**; only the `owner` role exists today (`server/auth.ts:60`).
- **Every artifact's HTML/JS** — surfaces run in iframes loaded from the Surface origin (`/surfaces/:id/html`, `/artifacts/:id/view`). Surface code can call any Surface endpoint, read every other artifact, and hit the LLM proxy. Treat artifact authors like agents.

## Auth resolution

The single auth middleware (`server/index.ts:99`) resolves in this order: **trusted loopback → `surface_session` cookie → `Authorization: Bearer <session-token>` → static `SURFACE_TOKEN` → public bootstrap paths → 401**.

- Loopback (`127.0.0.1`, `::1`, IPv4-mapped, `localhost`) is trusted unconditionally **by default** (`TRUST_LOOPBACK`, `server/index.ts:32`).
- A small allow-list of paths is public before pairing: the app shell (`/`, `/index.html`, `/app.js`, `/style.css`, `/manifest.json`, `/pair`, `/pair.html`, `/favicon.ico`), `GET /api/auth/session`, and `POST /api/auth/bootstrap` (`PUBLIC_BOOTSTRAP_GET_PATHS`, `server/index.ts:48`). Everything else — `/surfaces`, `/artifacts/*`, `/stream`, `/display/*`, credential management — requires auth.
- Cookies are the transport for SSE/`EventSource`, which cannot set custom headers.

### Reverse-proxy footgun

Because loopback is trusted by source address, fronting Surface with a **same-host reverse proxy** (Tailscale Serve, Caddy, Nginx, Cloudflare Tunnel) makes every proxied request appear to come from `127.0.0.1` and be trusted with no pairing. In that deployment you **must** set `SURFACE_TRUST_LOOPBACK=0` so Surface authenticates by session instead of source address. Trusting loopback is only safe when Surface binds the externally reachable interface directly. The recommended posture is a TLS-terminating proxy + `SURFACE_TRUST_LOOPBACK=0` + browsers paired through `/pair` over HTTPS.

## Token hashing

Pairing tokens and session tokens are stored **only** as `sha256(serverSecret:token)` (`hashToken`, `server/auth.ts:35`). The `serverSecret` is 32 random bytes persisted at `~/.surface/auth-secret` with mode `0600` (`getServerSecret`, `server/auth.ts:15`), so a leaked database does not directly yield usable credentials.

- **Pairing tokens**: short-lived (5 min default), single-use, from a confusion-free alphabet. Consumed atomically with a single `UPDATE … RETURNING` so a token can only ever be consumed once (`consumePairingToken`, `server/auth.ts:139`).
- **Sessions**: long-lived (30 day default), delivered as an `HttpOnly` `surface_session` cookie for browsers or usable as a Bearer token for CLI/agents (`server/auth.ts:177`).

See [device pairing](../auth/device-pairing.md) and [trust model](../auth/trust-model.md).

### Static `SURFACE_TOKEN` caveat

`SURFACE_TOKEN` remains a valid static owner Bearer credential (also via `?token=` and the legacy `surface_token` cookie) so existing CLI/agent configs keep working (`staticTokenMatch`, `server/index.ts:77`). Unlike sessions it is **unhashed and never expires**. Its retirement is approved — see [trust model](../auth/trust-model.md).

## Same-origin iframes and exec

Surfaces are loaded from real Surface routes, not `srcdoc`, so they share the Surface origin. This is what makes `POST /surfaces/:id/exec` work — the agent pushes JS that the PWA runs via `iframe.contentWindow.eval` inside the surface frame (`server/routes.ts:934`, `client/app.js:1418`). It also means a surface's own scripts can reach every Surface endpoint. This is intentional under the trust model, not a sandbox.

## Linked-artifact path protections

`POST /artifacts/link` registers an absolute on-disk path as a live artifact. Protections (`server/artifacts.ts`, `server/routes.ts`, detailed in `SECURITY.md`):

- **`SURFACE_LINK_ROOTS`** (colon-separated absolute paths) restricts which paths may be linked. Both candidate and roots are resolved with `fs.realpathSync` before a separator-aware containment check, so a symlink can't smuggle a target past the gate (`server/artifacts.ts:453`).
- **File-serving** at `GET /artifacts/:id/files/:relpath` realpaths the requested path and returns `403 Path escapes linked root` if it escapes the registered directory — defeating symlinks added after registration (`server/routes.ts:734`).

See [linked artifacts](../core/linked-artifacts.md).

## SSRF protection on `/proxy/pdf`

`GET /proxy/pdf?url=` is a server-side fetch (so surfaces can embed PDFs past X-Frame-Options). It refuses any URL whose hostname resolves to a loopback, RFC1918, link-local, ULA, IPv4-mapped, or multicast/reserved address (`isPrivateIp`/`resolvesPrivate`, `server/routes.ts:1145,1174`), fails closed on DNS errors, and does **not** follow redirects automatically (a redirect into a private IP returns 502) (`server/routes.ts:1188`).

## Other dangerous primitives (by design)

These exist for agent control and require authenticated access for non-loopback binds (`SECURITY.md` "Dangerous Primitives"):

- `POST /artifacts/present-file` reads any local file the process can read and stores it.
- `POST /surfaces/:id/exec` injects arbitrary JS into a surface iframe.
- `POST /api/chat` spends the host's `OPENROUTER_API_KEY` (rate-limited per-minute, `server/routes.ts:1088`).

## Out of scope

Surface deliberately does **not** defend against: a malicious/compromised agent, a malicious surface installed by a trusted agent, a hostile party on the same network when bound non-loopback without a token, or anyone with read access to `~/.surface/`. See `SECURITY.md` "Threat Model".

## Related
- [SECURITY.md](../../SECURITY.md) — canonical threat model
- [../auth/trust-model.md](../auth/trust-model.md) — roles and `SURFACE_TOKEN` retirement
- [../auth/device-pairing.md](../auth/device-pairing.md) — pairing/session flow
- [../core/linked-artifacts.md](../core/linked-artifacts.md) — link-root enforcement
- [install.md](install.md) — env vars and deployment
