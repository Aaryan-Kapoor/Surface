# Device Pairing

**Status:** Shipped (2026-06)
**Code:** `server/auth.ts`, `server/startupAccess.ts`, `server/qrCode.ts`, `client/pair.html`, `server/routes/auth.ts`

A *device* is any browser the user views Surface from beyond the host machine: a phone, a tablet, an extra monitor driven by another box. Devices authenticate once via a one-time pairing token and hold a long-lived, labeled, revocable session. This is the display plane of the [trust model](trust-model.md) — and the *only* place real authentication happens in Surface.

## The pieces

- **Pairing tokens** — single-use, short-TTL (5 min default), minted at startup when binding beyond loopback (or with `SURFACE_PAIR_ON_START=1`), or on demand via `surface pair` / `POST /api/auth/pairing-token`. Printed as a connection string + token + pairing URL + terminal QR code (`server/qrCode.ts`).
- **Bootstrap exchange** — the `/pair` page posts the token to `POST /api/auth/bootstrap`, which consumes it atomically and sets a session cookie. Bearer use of the same session token is supported for non-browser clients.
- **Storage** — only SHA-256 hashes of tokens are stored, keyed with a local secret (`~/.surface/auth-secret`, mode 0600). Sessions track `client_ip`, `user_agent`, `last_seen_at`.
- **Management endpoints** — list/revoke pairing tokens and sessions (`/api/auth/pairing-tokens`, `/api/auth/clients`, `/api/auth/clients/revoke`), plus the device-shaped views `GET /api/auth/devices` and `POST /api/auth/devices/revoke`; CLI `surface auth …` / `surface devices`.

### Device naming

Pairing has a name step: the `/pair` page asks "Name this device" (suggested from the user agent: *iPhone*, *Mac*; the user can override), and `surface pair --name <l>` pre-labels the token. The name becomes the session label — and labels are how devices are addressed everywhere else: revocation lists, presence, and `--on <device>` targeting.

### Device role

Pairing tokens default to `role: device` (see the [capability matrix](trust-model.md#roles-and-capability-matrix)). Minting a *system*-role credential is an explicit act from the system plane (`surface auth session issue --role system`).

### Device management

- `surface devices` — list paired devices: label, last seen (or `live` when an SSE connection is open), currently-viewed surface (presence), IP. Backed by `GET /api/auth/devices`, which annotates each session with `connected` and `viewing`.
- `surface devices revoke <label|id>` — kill a device session immediately (lost phone case). Matching accepts the exact id, exact label, or an unambiguous case-insensitive label prefix; ambiguity errors out with the candidate list rather than guessing.

### Rolling expiry

Session expiry is rolling: every successful use pushes `expires_at` out by the session's own `ttl_seconds` (default 30 days; `verifySession`, `server/auth.ts`), so an active wall-mounted display never re-pairs and an abandoned session ages out quietly.

## Pairing flow (end-to-end)

```
host machine                              phone
─────────────                             ─────
surface pair
  → prints URL + QR  ───── scan ───────→  opens /pair?token=…
                                          names the device ("iPhone")
                                          POST /api/auth/bootstrap
  token consumed (single-use) ←──────────  receives session cookie
                                          redirected to / (dashboard)
```

## Security notes

- A pairing token is a 5-minute, single-use credential; interception requires same-network access within that window. For untrusted networks, pair over Tailscale/VPN.
- Device sessions never grant filesystem, exec, binding, or credential powers — see [trust-model.md](trust-model.md).
- Revocation is immediate (sessions are verified per-request against the DB).

## Related

- [trust-model.md](trust-model.md) — what a device session may do
- [../display/devices.md](../display/devices.md) — presence and per-device targeting
- [../operations/install.md](../operations/install.md) — startup pairing output, env vars
