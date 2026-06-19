# Trust Model: System and Device Planes

**Status:** Shipped (2026-06)
**Code:** `server/index.ts` (auth middleware), `server/auth.ts`, `server/routes/helpers.ts` (`requireSystem`)

Surface is a private, single-user product. Its trust model splits into two planes with different physics, and every auth decision follows from taking that split seriously: the **agent plane** (local processes) and the **display plane** (remote browsers).

## The two planes

### Agent plane — local, attributed, not authenticated

All agents (Claude Code, Codex, OpenClaw, shell scripts) run as the same OS user on the same machine as the Surface service. They cannot be cryptographically distinguished from each other: any token issued to one agent is readable by every other agent (same uid, same filesystem, same env). Per-agent credentials would be friction without isolation.

Therefore:

- **Auth mechanism:** loopback trust. A request from 127.0.0.1/::1 is the user's own machine and gets the `system` role. The OS user account is the security boundary; Surface inherits it honestly.
- **Identity mechanism:** self-reported attribution, not authentication. Agents pass `--agent <label>` when creating surfaces (see [project-ownership.md](project-ownership.md)). It is a name tag, not a passport — a lying name tag on your own machine harms nobody but you.

### Display plane — remote, paired, restricted

Phones, extra monitors, and tablets cross the network boundary. This is where real authentication lives: one-time pairing tokens exchanged for long-lived, labeled, individually revocable **device sessions** (see [device-pairing.md](device-pairing.md)).

## Roles and capability matrix

The roles are `system` and `device` (the earlier `owner`/`client` names are gone):

| Capability | `system` (loopback or system bearer) | `device` (paired session) |
|---|---|---|
| View surfaces, files, thumbnails, SSE | ✓ | ✓ |
| Post actions (clicks), report presence | ✓ | ✓ |
| Create / update / delete its own (device-authored) workspace artifacts | ✓ | ✓ |
| Modify **system-authored** artifacts (update, rollback) | ✓ | ✗ (could inject JS into a trusted surface) |
| Assign display slots (`metadata.display_role` = renderer/home/overlay) | ✓ | ✗ (display control) |
| Link disk paths, present files (`surface link/present`) | ✓ | ✗ (filesystem access) |
| Write surface state (`surface set/patch`) | ✓ | ✗ |
| Inject JS (`surface exec`) | ✓ | ✗ |
| Register / edit bindings | ✓ | ✗ (command execution) |
| Mint pairing tokens, revoke sessions | ✓ | ✗ |
| Display control (navigate, notify, theme, reset) | ✓ | ✗ (agents drive the display) |
| Third-party proxies (LLM chat, Nexlayer deploy, PDF proxy) | ✓ | ✗ (spends credentials / outbound network) |

The line is drawn at anything that touches the host filesystem, executes code, mints credentials, spends server-side credentials, or dictates what every screen shows. A phone left in a cab can still browse and click the user's dashboard, but it can never register a binding that runs a shell command, pair additional devices, pull files off the disk, or force-navigate/restyle the host display. Devices can only *fire* pre-registered bindings by clicking — never create them. Display control (forcing navigation, pushing notifications, theming, reset) is an agent-plane push: a device renders what it's shown but cannot drive what other screens show.

### Why device artifact CRUD is scoped to device-authored content

Devices can author their own workspace artifacts (a phone jotting a note onto the dashboard), but cannot *modify* artifacts the agent plane created, and cannot mark any artifact as a display slot. Both rules exist because artifact HTML is executed JavaScript: the host display renders slot artifacts directly, and the thumbnailer renders every artifact in headless Chrome over a loopback connection that the server trusts as `system`. If a device could inject script into a system-authored or slot artifact, that script would run with system privileges. Two mechanisms enforce this: every artifact records its authoring plane in server-authoritative `metadata.author_plane` (`server/artifacts.ts` `sealArtifactMetadata`), and the thumbnailer disables JavaScript when rendering device-authored content (`server/thumbs.ts`). The remaining vector — the host's own browser rendering device content same-origin — is closed by the content plane below.

## The content plane — untrusted origin for device-authored surfaces

The host PWA runs on the app origin (`127.0.0.1:3000`), which is `system`. Surfaces render in iframes, so without isolation a device-authored surface's JavaScript would execute on the trusted origin and could `fetch()` system-only endpoints with system authority just by being displayed — a device→system escalation.

Surface serves the **same app from a second listener on `SURFACE_CONTENT_PORT` (default 3100)** — the content plane. The auth middleware (`server/index.ts`) grants **`device`, never `system`, to every request arriving on the content port**, even over loopback. The PWA embeds **device-authored** surfaces from this origin (chosen by `metadata.author_plane`), while system-authored surfaces stay on the app origin (they are as trusted as the agent that wrote them). Consequences:

- Device JS runs on `:3100`; its same-origin `fetch()`es hit the content plane (`device`) and get 403 on anything system-only.
- The browser's same-origin policy blocks it from reaching the `:3000` API at all.
- The surface runtime still works there: `GET state`, `GET stream`, `POST actions` are device-plane endpoints. `surface.js` posts actions directly to its own (content) origin rather than relaying through the trusted parent (`client/surface.js`); the PWA's postMessage bridge ignores cross-origin messages (`client/app.js`).

The content listener is **mandatory**: if it can't bind (`SURFACE_CONTENT_PORT`, default 3100, already in use), the server refuses to start rather than run with device surfaces unisolated. Behind a reverse proxy or HTTPS terminator where `host:3100` isn't directly reachable, set `SURFACE_CONTENT_ORIGIN` to the externally reachable content origin; the PWA embeds device surfaces from it and **fails closed to a placeholder** when no content origin is available (`client/app.js` `surfaceFrameSrc`), never falling back to the trusted app origin.

Verified end-to-end in `test/contentOrigin.ts` (the port pivot, the boot guards) and `test/appRouting.ts` (the client embedding decision). Out of scope for now (defense-in-depth): rendering the thumbnailer and display slots via the content origin, and per-remote-host content origins for paired devices (a paired device is already `device`, so it has no system to escalate to).

## `SURFACE_TOKEN` removal

The static `SURFACE_TOKEN` env credential (unhashed, no expiry, no revocation) is gone:

- Local agents never needed it — they have loopback.
- Displays never use it — they pair.
- The one legitimate remaining case, an agent on a *remote* machine (SSH dev box, container), mints a system bearer explicitly from loopback — `surface auth session issue --role system --label devbox` — and carries it as `SURFACE_SESSION`.

Removal was immediate, with no deprecation cycle (decided 2026-06): the static-token code path and the legacy `surface_token` cookie were deleted outright. A still-set `SURFACE_TOKEN` is ignored; the server logs a warning at boot pointing at the session-bearer path (`server/index.ts`). The fresh-start schema reset (see [roadmap](../roadmap.md)) already broke old configs, so there was nothing to keep compatible.

## Loopback trust caveats (unchanged)

- `SURFACE_TRUST_LOOPBACK=0` remains mandatory when fronting Surface with a local reverse proxy (Tailscale Serve, Caddy), otherwise every proxied request appears to come from 127.0.0.1. See `SECURITY.md`. (Surface does not currently detect or warn about the `SURFACE_PUBLIC_URL` + loopback-trust combination — the operator owns this configuration.)

## Implementation notes

- `auth_sessions.role` / `auth_pairing_tokens.role` hold `system`/`device` natively in the fresh-start schema; pairing tokens default to `device` (`server/migrations.ts`, `server/auth.ts`).
- `req.auth.role ∈ {system, device}`; the `requireSystem` check (`server/routes/helpers.ts`) gates the restricted route set in the capability matrix, including `POST /artifacts/:id/exec`.
- `GET /api/auth/session` returns the resolved role so the PWA can hide system-only UI on devices.

## Related

- [device-pairing.md](device-pairing.md) — how device sessions are created and managed
- [project-ownership.md](project-ownership.md) — attribution: projects and agent labels
- [../interaction/bindings.md](../interaction/bindings.md) — why binding registration is system-only
- [../operations/security.md](../operations/security.md) — shipped security posture
