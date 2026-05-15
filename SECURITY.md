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

If you set `SURFACE_BIND` to a non-loopback address (LAN IP, `0.0.0.0`, Tailscale interface, etc.), Surface refuses to start unless `SURFACE_TOKEN` is set to a non-empty value.

Clients reaching Surface from a non-loopback address must present the token via either:

- `Authorization: Bearer <token>` header, or
- `?token=<token>` query string.

The recommended posture is to keep `SURFACE_BIND=127.0.0.1` and front Surface with a reverse proxy that handles TLS and authentication (Caddy, Nginx, Tailscale Funnel, Cloudflare Tunnel). Surface's own token check is a defense-in-depth measure, not a full auth system.

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
