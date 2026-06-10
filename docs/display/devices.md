# Devices: Presence & Targeting

**Status:** Approved — not yet built (Phase 1). Builds on shipped global presence reporting.
**Code (current):** `POST /display/presence`, `GET /display/status` (`server/routes.ts`), presence reporting in `client/app.js`

Once displays are first-class [paired devices](../auth/device-pairing.md), Surface can know *which* screens are alive and *send content to a specific one*: open the build dashboard on the desk monitor, push a question to the phone, park the [board](../templates/board.md) on the wall display.

## Device registry

A device is a labeled session (named at pair time). The host machine's own browser on loopback counts as the implicit device `local`.

```bash
$ surface devices
LABEL          ROLE     LAST SEEN   VIEWING            
phone          device   live        surface: build-status
desk-monitor   device   live        grid
old-tablet     device   3d ago      —
```

`surface devices revoke <label>` kills a session immediately ([device-pairing.md](../auth/device-pairing.md)).

## Presence (per-device)

The shipped presence report (current view, surface id, viewport) becomes **session-keyed**: each connected PWA reports presence tagged with its device session, and each SSE connection is tagged likewise. `GET /display/status` returns the per-device list. This is what makes `surface devices` show live state, and what the grid header's "station" indicator generalizes into.

## Targeting

Display-control verbs gain `--on <device>`:

```bash
surface open build-status --on desk-monitor   # navigate one display
surface notify "tests passed" --on phone      # toast one display
surface ask "Approve?" --options y,n --on phone   # navigate the phone to the question
surface open board --on desk-monitor          # ambient fleet view
```

- **Matching:** case-insensitive prefix on the device label; ambiguous or unknown names error with the device list.
- **Default unchanged:** without `--on`, navigate/notify broadcast to all displays (today's behavior).
- **Implementation:** directed SSE — `display_navigate` / `display_notify` events carry an optional target session id; the server delivers only to that session's connections. No new event types.

## Security note

Targeting is display control, available to the `system` plane and to devices (a device may navigate another device — they're all the same user's screens; see the [capability matrix](../auth/trust-model.md#roles-and-capability-matrix)). Revocation and pairing stay system-only.

## Related

- [../auth/device-pairing.md](../auth/device-pairing.md) — how devices come to exist
- [../templates/ask.md](../templates/ask.md) — `--on` for questions
- [../templates/board.md](../templates/board.md) — ambient mode
