# Security Model Summary

**Status:** Shipped (2026-06)
**Code:** `SECURITY.md` (canonical), `server/index.ts` (auth middleware), `server/auth.ts` (token hashing/sessions), `server/routes/` (dangerous primitives), `server/artifacts.ts` (link-root enforcement)

This page summarizes Surface's security posture and points at the relevant code. **[SECURITY.md](../../SECURITY.md) at the repo root is canonical** — defer to it for the full threat model and reporting process. The claims below were verified against the implementation.

## Trust model

Surface is a single-user, self-hosted local service. It trusts three things by design:

- **The local user** — anyone with shell access to the host has the same authority as Surface.
- **Every system-plane agent** — anything on loopback (or carrying a system bearer) has full authority over content, display, and proxies. There is **no per-agent capability scoping** within the system plane ([../auth/project-ownership.md](../auth/project-ownership.md)); the role split that does exist is `system` vs `device` — paired displays can view, click, do workspace-artifact CRUD, and drive the display, but cannot touch the filesystem, execute code, drain the inbox, or mint credentials ([../auth/trust-model.md](../auth/trust-model.md)).
- **Every artifact's HTML/JS** — surfaces run in iframes loaded from the Surface origin (`/artifacts/:id/view`, `/artifacts/:id/files/*`). Surface code can call any Surface endpoint, read every other artifact, and hit the LLM proxy. Treat artifact authors like agents.

## Auth resolution

The single auth middleware (`server/index.ts`) resolves in this order: **trusted loopback → `surface_session` cookie → `Authorization: Bearer <session-token>` → public bootstrap paths → 401**. (The static `SURFACE_TOKEN` path is gone; a set env var is ignored with a startup warning.)

- Loopback (`127.0.0.1`, `::1`, IPv4-mapped, `localhost`) is trusted unconditionally **by default** (`TRUST_LOOPBACK`, `server/index.ts`) and resolves to the `system` role.
- A small allow-list of paths is public before pairing: the app shell (`/`, `/index.html`, `/app.js`, `/style.css`, `/manifest.json`, `/pair`, `/pair.html`, `/favicon.ico`), `GET /api/auth/session`, and `POST /api/auth/bootstrap` (`PUBLIC_BOOTSTRAP_GET_PATHS`, `server/index.ts`). Everything else — `/artifacts/*`, `/stream`, `/display/*`, credential management — requires auth.
- Cookies are the transport for SSE/`EventSource`, which cannot set custom headers.

### Reverse-proxy footgun

Because loopback is trusted by source address, fronting Surface with a **same-host reverse proxy** (Tailscale Serve, Caddy, Nginx, Cloudflare Tunnel) makes every proxied request appear to come from `127.0.0.1` and be trusted with no pairing. In that deployment you **must** set `SURFACE_TRUST_LOOPBACK=0` so Surface authenticates by session instead of source address. Trusting loopback is only safe when Surface binds the externally reachable interface directly. The recommended posture is a TLS-terminating proxy + `SURFACE_TRUST_LOOPBACK=0` + browsers paired through `/pair` over HTTPS.

## Token hashing

Pairing tokens and session tokens are stored **only** as `sha256(serverSecret:token)` (`hashToken`, `server/auth.ts`). The `serverSecret` is 32 random bytes persisted at `~/.surface/auth-secret` with mode `0600` (`getServerSecret`), so a leaked database does not directly yield usable credentials.

- **Pairing tokens**: short-lived (5 min default), single-use, from a confusion-free alphabet, minting `device`-role sessions by default. Consumed atomically with a single `UPDATE … RETURNING` so a token can only ever be consumed once (`consumePairingToken`).
- **Sessions**: long-lived (30-day TTL, rolling — each use extends expiry), delivered as an `HttpOnly` `surface_session` cookie for browsers or usable as a Bearer token for CLI/agents. Individually revocable; revocation is checked per request.

See [device pairing](../auth/device-pairing.md) and [trust model](../auth/trust-model.md).

### `SURFACE_TOKEN` removal

The static `SURFACE_TOKEN` credential (unhashed, no expiry, no revocation) was removed outright, along with the `?token=` query form and the legacy `surface_token` cookie. The one legitimate use it had — an agent on a remote machine — is served by minting a revocable system bearer from loopback: `surface auth session issue --role system`. See [trust model](../auth/trust-model.md).

## Same-origin iframes and exec

Surfaces are loaded from real Surface routes, not `srcdoc`, so they share the Surface origin. This is what makes `POST /artifacts/:id/exec` work — the agent pushes JS that the PWA runs via `iframe.contentWindow.eval` inside the surface frame (`server/routes/actions.ts`, `client/app.js`). It also means a surface's own scripts can reach every Surface endpoint. This is intentional under the trust model, not a sandbox. `exec` is **system-plane only** — a paired device cannot inject JS.

## Linked-artifact path protections

`POST /artifacts/link` registers an absolute on-disk path as a live artifact — and is **system-plane only**. Protections (`server/artifacts.ts`, `server/routes/artifacts.ts`, detailed in `SECURITY.md`):

- **`SURFACE_LINK_ROOTS`** (colon-separated absolute paths) restricts which paths may be linked. Both candidate and roots are resolved with `fs.realpathSync` before a separator-aware containment check, so a symlink can't smuggle a target past the gate (`server/artifacts.ts`).
- **File-serving** at `GET /artifacts/:id/files/:relpath` realpaths the requested path and returns `403 Path escapes linked root` if it escapes the registered directory — defeating symlinks added after registration (`server/routes/artifacts.ts`).

See [linked artifacts](../core/linked-artifacts.md).

## SSRF protection on `/proxy/pdf`

`GET /proxy/pdf?url=` is a server-side fetch (so surfaces can embed PDFs past X-Frame-Options). It refuses any URL whose hostname resolves to a loopback, RFC1918, link-local, ULA, IPv4-mapped, or multicast/reserved address (`isPrivateIp`/`resolvesPrivate`, `server/routes/integrations.ts`), fails closed on DNS errors, and does **not** follow redirects automatically (a redirect into a private IP returns 502).

## Other dangerous primitives (by design)

These exist for agent control and are gated to the `system` plane (`SECURITY.md` "Dangerous Primitives"):

- `POST /artifacts/present-file` reads any local file the process can read and stores it (system-only).
- `POST /artifacts/:id/exec` injects arbitrary JS into a surface iframe (system-only).
- `POST /artifacts/:id/bindings` registers arbitrary command execution (system-only; see [../interaction/bindings.md](../interaction/bindings.md)).
- `POST /api/chat` spends the host's `OPENROUTER_API_KEY` (rate-limited per-minute, `server/routes/integrations.ts`).

## Out of scope

Surface deliberately does **not** defend against: a malicious/compromised agent on the system plane, a malicious surface installed by a trusted agent, or anyone with read access to `~/.surface/`. See `SECURITY.md` "Threat Model".

## Related
- [SECURITY.md](../../SECURITY.md) — canonical threat model
- [../auth/trust-model.md](../auth/trust-model.md) — roles and `SURFACE_TOKEN` removal
- [../auth/device-pairing.md](../auth/device-pairing.md) — pairing/session flow
- [../core/linked-artifacts.md](../core/linked-artifacts.md) — link-root enforcement
- [install.md](install.md) — env vars and deployment
