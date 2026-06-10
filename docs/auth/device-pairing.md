# Device Pairing

**Status:** Partially shipped — pairing tokens, sessions, and the /pair page exist; device semantics (naming, role, management UX) are approved for Phase 1.
**Code (current):** `server/auth.ts`, `server/startupAccess.ts`, `server/qrCode.ts`, `client/pair.html`, auth routes in `server/routes.ts`

A *device* is any browser the user views Surface from beyond the host machine: a phone, a tablet, an extra monitor driven by another box. Devices authenticate once via a one-time pairing token and hold a long-lived, labeled, revocable session. This is the display plane of the [trust model](trust-model.md) — and the *only* place real authentication happens in Surface.

## Shipped today

- **Pairing tokens** — single-use, short-TTL (5 min default), minted at startup when binding beyond loopback (or with `SURFACE_PAIR_ON_START=1`), or on demand via `surface pair` / `POST /api/auth/pairing-token`. Printed as a connection string + token + pairing URL + terminal QR code (`server/qrCode.ts`).
- **Bootstrap exchange** — the `/pair` page posts the token to `POST /api/auth/bootstrap`, which consumes it and sets a session cookie (30-day TTL). Bearer use of the same session token is supported for non-browser clients.
- **Storage** — only SHA-256 hashes of tokens are stored, keyed with a local secret (`~/.surface/auth-secret`, mode 0600). Sessions track `client_ip`, `user_agent`, `last_seen_at`.
- **Management endpoints** — list/revoke pairing tokens and sessions (`/api/auth/pairing-tokens`, `/api/auth/clients`, `/api/auth/clients/revoke`), CLI `surface auth …`.

## Approved additions (Phase 1)

### Device naming

Pairing acquires a name step: the `/pair` page asks "Name this device" (suggested from user agent: *iPhone*, *Desk monitor*) and stores it as the session label. Names are how devices are addressed everywhere else — revocation lists, presence, and `--on <device>` targeting.

### Device role

Pairing tokens default to `role: device` (see the [capability matrix](trust-model.md#roles-and-capability-matrix)). Minting a *system*-role credential is an explicit, loopback-only act.

### Device management

- `surface devices` — list paired devices: label, last seen, IP, currently-open view (live presence).
- `surface devices revoke <label|id>` — kill a device session immediately (lost phone case).
- The PWA gains the same list in a small settings panel (visible to `system` plane and on the device itself for self-logout).

### Rolling expiry

Sessions currently hard-expire after 30 days, which would force monthly re-pairing of a wall-mounted display. Approved: refresh `expires_at` on use (rolling 30-day window), so an active device never re-pairs and an abandoned one dies quietly.

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
