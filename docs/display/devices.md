# Devices: Presence & Targeting

**Status:** Shipped (2026-06)
**Code:** `server/presence.ts`, `server/routes/display.ts` (`/display/presence`, `/display/status`, device targeting), `server/routes/auth.ts` (`/api/auth/devices`), presence reporting in `client/app.js`

Displays are first-class [paired devices](../auth/device-pairing.md), so Surface knows *which* screens are alive and can *send content to a specific one*: open the build dashboard on the desk monitor, push a question to the phone, park the [board](../templates/board.md) on the wall display.

## Device registry

A device is a labeled session (named at pair time). The host machine's own browser on loopback counts as the implicit device `local`.

```bash
$ surface devices
LABEL          LAST SEEN   VIEWING                 IP
phone          live        surface: build-status   192.168.1.34
desk-monitor   live        grid                    192.168.1.61
old-tablet     3d ago      —                       192.168.1.80
```

`surface devices revoke <label>` kills a session immediately ([device-pairing.md](../auth/device-pairing.md)).

## Presence (per-device)

The presence report (current view, surface id, viewport) is **session-keyed**: each connected PWA reports presence tagged with its device session (the host machine's own browser is the implicit target `local`), and each SSE connection is tagged likewise (`server/sse.ts`). `GET /display/status` returns the per-device list (stale after 60s). This is what makes `surface devices` show live state and the currently-viewed surface.

## Targeting

System-plane display-control verbs take `--on <device>`:

```bash
surface open build-status --on desk-monitor   # navigate one display
surface notify "tests passed" --on phone      # toast one display
surface ask "Approve?" --options y,n --on phone   # navigate the phone to the question
surface open board --on desk-monitor          # ambient fleet view
```

- **Matching:** case-insensitive exact label (or id) first, then unambiguous label prefix; ambiguous or unknown names error with the device list (`resolveDeviceTarget`, `server/routes/display.ts`).
- **Default:** without `--on`, navigate/notify broadcast to all displays.
- **Implementation:** directed SSE — `display_navigate` / `display_notify` deliveries are filtered by the connection's target session id (`broadcastGlobal`'s `onlyTarget`). No new event types.

## Security note

Targeting is display control and is available only to the `system` plane. Paired devices report presence, view surfaces, and click inside surfaces, but they cannot navigate other displays, push notifications, or change theme. Revocation and pairing also stay system-only.

## Related

- [../auth/device-pairing.md](../auth/device-pairing.md) — how devices come to exist
- [../templates/ask.md](../templates/ask.md) — `--on` for questions
- [../templates/board.md](../templates/board.md) — ambient mode
