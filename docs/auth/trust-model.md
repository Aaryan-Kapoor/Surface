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
| Create / update / delete / rename workspace artifacts | ✓ | ✓ |
| Link disk paths, present files (`surface link/present`) | ✓ | ✗ (filesystem access) |
| Write surface state (`surface set/patch`) | ✓ | ✗ |
| Inject JS (`surface exec`) | ✓ | ✗ |
| Register / edit bindings | ✓ | ✗ (command execution) |
| Mint pairing tokens, revoke sessions | ✓ | ✗ |
| Display control (navigate, notify, theme) | ✓ | ✓ |

The line is drawn at anything that touches the host filesystem, executes code, or mints credentials. A phone left in a cab can still browse and click the user's dashboard, but it can never register a binding that runs a shell command, pair additional devices, or pull files off the disk. Devices can only *fire* pre-registered bindings by clicking — never create them.

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
