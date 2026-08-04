# SSE Event Catalog

**Status:** Shipped (2026-06)
**Code:** `server/sse.ts`, `server/routes/artifacts.ts`, `server/routes/actions.ts`, `server/routes/display.ts`, `server/bindings.ts`, `server/thumbs.ts`, `client/app.js`, `bin/surface.ts`

Surface pushes real-time updates over Server-Sent Events. There are two streams and a small set of named event types. Events are emitted from route handlers (and the binding dispatcher) via `broadcastGlobal` / `broadcastToSurface` (`server/sse.ts`) and consumed by the PWA (`client/app.js`) and by `surface stream` / `surface wait` (`bin/surface.ts`).

## Streams

| Endpoint | Scope | Code |
| --- | --- | --- |
| `GET /stream` | global — all surface lifecycle and display events | `addGlobalClient`, `server/sse.ts`; route in `server/routes/display.ts` |
| `GET /artifacts/:id/stream` | one surface — its updates, state patches, chunks, replies, and exec | `addSurfaceClient`, `server/sse.ts`; route in `server/routes/artifacts.ts` (404 if the artifact doesn't exist) |

Both write SSE headers (`text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`) and a single `:\n\n` comment line on connect. Clients are tracked in memory and removed on `close`. Wire format per event: `event: <type>\ndata: <json>\n\n` (`sendEvent`, `server/sse.ts`).

Two properties of global connections matter for delivery:

- **Device targets** — every connection is tagged with a delivery target: `local` for the agent plane, or the device session id for paired displays. Directed events (`surface open … --on phone`) are delivered only to that target's connections (`broadcastGlobal`'s `onlyTarget`); untargeted broadcasts reach everyone. See [../display/devices.md](../display/devices.md).
- **Waiters** — `GET /stream?wait_for_surface=<id>` / `?wait_for_project=<root>` / `?wait_for_all=1` (system plane only, exactly one) registers the connection as a layer-1 waiter and replies on that connection with a private `waiter_registered` event carrying its `client_id`. `?wait_action=<name>` narrows eligibility. While it lives the card shows "● listening" and it gets a five-second first refusal on eligible actions. Connect/disconnect emit `waiter_status`. Observers omit `wait_for_*` entirely. See [../interaction/delivery-ladder.md](../interaction/delivery-ladder.md).

## Event types

### Global stream

| Event | Payload | Fires when |
| --- | --- | --- |
| `surface_created` | a surface **card** (`cardPayload`, includes hidden rows), or `{id}` | artifact created — `POST /artifacts`, `/artifacts/present-file`, `/artifacts/link`, board first-write |
| `surface_updated` | a surface card (`cardPayload`) | artifact updated, touched, rolled back, or PUT |
| `surface_deleted` | `{id}` | artifact deleted |
| `surface_action` | `{id, surface_id, surface_title, project_root, action, data, status, created_at}` | a surface posts a user action — `POST /artifacts/:id/actions`. Broadcast to everyone; only one listener may *claim* it (see [../interaction/delivery-ladder.md](../interaction/delivery-ladder.md)) |
| `actions_acked` | `{surface_id, pending_actions}` | an action is claimed, acked, or released — lets cards update their badge live. `pending_actions` counts pending **plus** claimed-but-unfinished |
| `actions_available` | `{surface_id, action_id}` | a claim was released (waiter disconnect, expired handoff, failed binding) and the action is takeable again |
| `state_patch` | `{id, patch, state_version}` | `PATCH /artifacts/:id/state`, or the server-side `ask` answered flip |
| `stream_append` | `{id, seq, chunk:{kind, content, created_at}}` | `POST /artifacts/:id/append` (one event per chunk) |
| `binding_status` | `{surface_id, binding_id, status, error}` | a binding run starts/finishes (`running` → `ok`/`failed`; `server/bindings.ts`) |
| `waiter_status` | `{surface_id, listening}` | a `wait_for_*` waiter connects or disconnects (one event per surface its scope covers) |
| `waiter_registered` | `{client_id, scope:{kind, value}, action}` | sent **only** to the connection that just registered as a waiter; the `client_id` is quoted on every claim |
| `agent_reply` | `{surface_id, text}` | agent replies — `POST /artifacts/:id/reply` |
| `display_navigate` | `{surface_id}` (null = grid/home) | `POST /display/navigate`, or auto on present/link when `open !== false`; optionally directed at one device |
| `display_notify` | `{text, duration, style}` | `POST /display/notify` (optionally directed), or a throttled webhook-failure warning |
| `display_theme` | merged theme config (or `{}` on reset) | `PUT /display/config`, `POST /display/reset` |
| `thumb_ready` | `{id}` | a thumbnail capture finishes (`server/thumbs.ts`) |
| `update_status` | `{current, latest, update_available, checked_at, check_error, context, advice, run}` | a cached release check completes, or a one-click update changes phase (`server/updates.ts`). Carries no per-plane fields — the PWA keeps `can_apply` from its own `GET /api/update/status`. |

### Per-surface stream (`/artifacts/:id/stream`)

| Event | Payload | Fires when |
| --- | --- | --- |
| `surface_updated` | `{id, title, metadata, updated_at, version_id?, reload:true}` | the artifact behind this surface changes (PUT/touch/rollback/template re-render) |
| `state_patch` | `{id, patch, state_version}` | this surface's state changes |
| `stream_append` | `{id, seq, chunk}` | a chunk is appended to this surface |
| `binding_status` | `{surface_id, binding_id, status, error}` | one of this surface's bindings runs |
| `agent_reply` | `{text}` | `POST /artifacts/:id/reply` |
| `surface_exec` | `{js}` | `POST /artifacts/:id/exec` |

Note the per-surface `surface_updated` payload differs from the global one (it carries `reload`/`version_id` instead of a full card). `surface_action` is **only** on the global stream — this is why `surface wait` always listens globally.

## Consumption

### PWA (`client/app.js`)
- Grid view opens the **global** stream (`connectGlobalSSE`). `surface_created`/`updated`/`deleted` mutate the card grid in place; a `surface_updated` carrying `metadata.hidden===true` removes the card without deleting the row; `surface_action`/`actions_acked` and `waiter_status` keep the pending badge and "● listening" pill live; `thumb_ready` cache-busts the card image with `?v=Date.now()`. `display_navigate`/`display_notify`/`display_theme` drive routing, toasts, and theme; `update_status` repaints the release notice in the grid header. Note that `update_status` is the one event whose delivery cannot be relied on end-to-end: an update restarts the process pushing it, so the PWA also polls `GET /api/update/status` while (and only while) a run is in flight.
- Surface view opens the **per-surface** stream. `surface_updated` with `reload`/`version_id` reloads the iframe via a cache-busting `?v=`; `agent_reply` shows a toast; `surface_exec` attempts a best-effort eval inside accessible iframes. The injected `surface.js` runtime consumes `state_patch` and `stream_append` to update bound elements without a reload.

### CLI
- `surface stream [--id]` connects to the chosen stream and prints one `{event, data}` JSON line per event, ignoring `:` heartbeat comments, reconnecting with exponential backoff on drops.
- `surface wait` listens on the **global** stream for `surface_action` (default `--event`) and filters by `--id`/`--action`. A claiming waiter registers via `?wait_for_surface` / `?wait_for_project` / `?wait_for_all`, waits for its `waiter_registered` identity, then *claims* each match before printing it and completes the claim once the line is out — so the same broadcast reaching several waiters still produces exactly one handler. It drains `/actions` on registration (oldest pending), on `actions_available`, and after each reconnect. `--no-ack` (and `--event <non-action>`) is an observer: it omits `wait_for_*`, claims nothing, and suppresses nothing.

## Keepalive heartbeat

Every connection receives a `:hb` comment line **every 20 seconds** (`HEARTBEAT_MS`, `server/sse.ts`) so idle connections survive proxies/NAT timeouts and dead ones are detected by the TCP stack. The PWA reconnects automatically (native `EventSource`); `surface stream` and `surface wait` reconnect with backoff.

## Related
- [http-api.md](http-api.md) — the routes that emit each event
- [cli.md](cli.md) — `surface stream` / `surface wait`
- [thumbnails.md](thumbnails.md) — `thumb_ready`
- [../interaction/delivery-ladder.md](../interaction/delivery-ladder.md) — actions, waiters, bindings
- [../display/pwa.md](../display/pwa.md) — PWA SSE handling
- [../display/devices.md](../display/devices.md) — directed events
