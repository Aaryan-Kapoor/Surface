# SSE Event Catalog

**Status:** Shipped
**Code:** `server/sse.ts`, `server/routes.ts`, `server/thumbs.ts`, `client/app.js`, `bin/surface.ts`

Surface pushes real-time updates over Server-Sent Events. There are two streams and a small set of named event types. Events are emitted from route handlers via `broadcastGlobal` / `broadcastToSurface` (`server/sse.ts:56-73`) and consumed by the PWA (`client/app.js`) and by `surface stream` / `surface wait` (`bin/surface.ts`).

## Streams

| Endpoint | Scope | Code |
| --- | --- | --- |
| `GET /stream` | global — all surface lifecycle and display events | `addGlobalClient`, `server/sse.ts:13-27`; route `server/routes.ts:292-294` |
| `GET /surfaces/:id/stream` | one surface — its updates, replies, and exec | `addSurfaceClient`, `server/sse.ts:29-50`; route `server/routes.ts:297-305` (404 if neither artifact nor legacy surface exists) |

Both write SSE headers (`text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`) and a single `:\n\n` comment line on connect. Clients are tracked in memory and removed on `close`. Wire format per event: `event: <type>\ndata: <json>\n\n` (`sendEvent`, `server/sse.ts:52-54`).

## Event types

### Global stream

| Event | Payload | Fires when |
| --- | --- | --- |
| `surface_created` | a surface **card** (`cardPayload`, includes hidden rows), or `{id}` | artifact/surface created — `POST /artifacts`, `/surfaces`, `/artifacts/present-file`, `/artifacts/link` (`server/routes.ts:373,457,478,533`) |
| `surface_updated` | a surface card (`cardPayload`) | artifact updated, touched, rolled back, or PUT (`server/routes.ts:414,494,574,616`) |
| `surface_deleted` | `{id}` | artifact or surface deleted (`server/routes.ts:439,639`) |
| `surface_action` | `{id, surface_id, surface_title, action, data, created_at}` | a surface posts a user action — `POST /surfaces/:id/actions` (`server/routes.ts:819-826`) |
| `agent_reply` | `{surface_id, text}` | agent replies — `POST /surfaces/:id/reply` (`server/routes.ts:865`) |
| `display_navigate` | `{surface_id}` (null = grid/home) | `POST /display/navigate`, or auto on present/link when `open !== false` (`server/routes.ts:458,479,918`) |
| `display_notify` | `{text, duration, style}` | `POST /display/notify`, or a throttled webhook-failure warning (`server/routes.ts:24,929`) |
| `display_theme` | merged theme config (or `{}` on reset) | `PUT /display/config`, `POST /display/reset` (`server/routes.ts:879,886`) |
| `thumb_ready` | `{id}` | a thumbnail capture finishes (`server/thumbs.ts:91`) |

### Per-surface stream (`/surfaces/:id/stream`)

| Event | Payload | Fires when |
| --- | --- | --- |
| `surface_updated` | `{id, title, metadata, updated_at, version_id?, reload:true}` | the artifact behind this surface changes (PUT/touch/rollback) (`server/routes.ts:415,495,575,617`) |
| `agent_reply` | `{text}` | `POST /surfaces/:id/reply` (`server/routes.ts:864`) |
| `surface_exec` | `{js}` | `POST /surfaces/:id/exec` (`server/routes.ts:946`) |

Note the per-surface `surface_updated` payload differs from the global one (it carries `reload`/`version_id` instead of a full card). `surface_action` is **only** on the global stream — this is why `surface wait` always listens globally.

## Consumption

### PWA (`client/app.js`)
- Grid view opens the **global** stream (`connectGlobalSSE`, `client/app.js:1432`). `surface_created`/`updated`/`deleted` mutate the card grid in place; a `surface_updated` carrying `metadata.hidden===true` removes the card without deleting the row; `thumb_ready` cache-busts the card image with `?v=Date.now()` (`client/app.js:1562-1570`). `display_navigate`/`display_notify`/`display_theme` drive routing, toasts, and theme.
- Surface view opens the **per-surface** stream (`renderSurface`, `client/app.js:1391`). `surface_updated` with `reload`/`version_id`/`html` reloads the iframe via a cache-busting `?v=`; `agent_reply` shows a toast; `surface_exec` `eval`s the JS inside the iframe (`client/app.js:1392-1427`).

### CLI
- `surface stream [--id]` connects to the chosen stream and prints one `{event, data}` JSON line per event, ignoring `:` heartbeat comments (`bin/surface.ts:647-689`).
- `surface wait` listens on the **global** stream for `surface_action` (default `--event`), filters by `--id`/`--action`, auto-acks the match, and exits `0`; it also polls `/actions` on connect and after each reconnect to catch events missed during gaps, with exponential backoff (`bin/surface.ts:496-629`).

## Known gap: no keepalive heartbeat

Only the initial `:\n\n` comment is sent; there is **no periodic heartbeat** afterward (`server/sse.ts:18,36`). Idle connections behind proxies/load-balancers can be dropped silently. The PWA reconnects automatically (native `EventSource`) and `surface wait` has its own reconnect+re-poll loop, but `surface stream` does not reconnect. A periodic keepalive is tracked in [../roadmap.md](../roadmap.md).

## Related
- [http-api.md](http-api.md) — the routes that emit each event
- [cli.md](cli.md) — `surface stream` / `surface wait`
- [thumbnails.md](thumbnails.md) — `thumb_ready`
- [../interaction/delivery-ladder.md](../interaction/delivery-ladder.md) — actions and waiting
- [../display/pwa.md](../display/pwa.md) — PWA SSE handling
- [../roadmap.md](../roadmap.md) — keepalive heartbeat
