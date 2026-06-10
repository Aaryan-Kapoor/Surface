# HTTP API Reference

**Status:** Shipped
**Code:** `server/routes.ts`, `server/index.ts`

Surface is an Express app. A single global auth middleware in `server/index.ts` resolves `req.auth` for every request before the router runs; all routes below assume that resolution has happened. The server binds `127.0.0.1:3000` by default (`SURFACE_BIND`, `PORT`). Request bodies are JSON, `10mb` limit (`server/index.ts:44`).

## Auth resolution order

The middleware at `server/index.ts:99-132` tries, in order, and sets `req.auth = { role, via }`:

1. **Trusted loopback** — remote address in `{127.0.0.1, ::1, ::ffff:127.0.0.1, localhost}` and `SURFACE_TRUST_LOOPBACK != 0` → `owner` (`via: loopback`). Operators behind a loopback reverse proxy MUST set `SURFACE_TRUST_LOOPBACK=0`.
2. **Session cookie** — `surface_session` cookie verified via `verifySession` → session role (`via: cookie`).
3. **Session bearer** — `Authorization: Bearer <session-token>` verified → session role (`via: bearer`).
4. **Static token** — `SURFACE_TOKEN` matched (constant-time) via bearer header, `?token=` query, or legacy `surface_token` cookie → `owner` (`via: static-token`); a valid `?token=` also sets the cookie (`staticTokenMatch`, `server/index.ts:77-94`).
5. **Public bootstrap paths** — pass without auth (see below).
6. Otherwise → **401** `{error, bootstrapMethods:["one-time-token"]}`.

Owner-only management routes re-check `req.auth.role === "owner"` via `requireOwner`, returning **403** otherwise (`server/routes.ts:119-123`).

**Public (no auth) requests** (`isPublicRequest`, `server/index.ts:59-64`): `GET` of `/`, `/index.html`, `/app.js`, `/style.css`, `/manifest.json`, `/pair`, `/pair.html`, `/favicon.ico`; `GET /api/auth/session`; `POST /api/auth/bootstrap`. Static assets serve from `client/` and `examples/demos/` (`server/index.ts:138-140`).

## Auth

| Method | Path | Body / Query | Response | Caller |
| --- | --- | --- | --- | --- |
| GET | `/api/auth/session` | — | `{authenticated, role, ...}` or `{authenticated:false}` | public |
| POST | `/api/auth/bootstrap` | `{credential, label?}` | session payload + `Set-Cookie` | public; consumes a one-time pairing token |
| POST | `/api/auth/pairing-token` | `{label?, ttlSeconds?, baseUrl?}` | `{id, credential, pairingUrl, expiresAt, role}` | owner |
| GET | `/api/auth/pairing-tokens` | — | token summaries | owner |
| POST | `/api/auth/pairing-tokens/revoke` | `{id}` | `{revoked}` | owner |
| POST | `/api/auth/sessions` | `{label?, ttlSeconds?}` | `{id, token, role, expiresAt}` | owner |
| GET | `/api/auth/clients` | — | session list | owner |
| POST | `/api/auth/clients/revoke` | `{id}` | `{revoked}` | owner |
| POST | `/api/auth/logout` | cookie/bearer | `{revoked}` + clears cookie | any |

See [../auth/device-pairing.md](../auth/device-pairing.md) and [../auth/trust-model.md](../auth/trust-model.md).

## Artifacts CRUD

| Method | Path | Body / Query | Response | Notes |
| --- | --- | --- | --- | --- |
| GET | `/artifacts` | — | raw artifact rows | |
| POST | `/artifacts` | `{title, files[]\|content, mime?, kind?, source_type?, metadata?, id?}` | `{artifact,version,files}` (201) | rejects `source_type:"linked"` (400) |
| GET | `/artifacts/:id` | — | `{artifact,version,files}` | 404 if missing/deleted |
| PUT | `/artifacts/:id` | same as POST + `reason?` | `{artifact,version,files}` | new version if `files`/`content`; **409** if linked + files |
| DELETE | `/artifacts/:id` | — | `{deleted:true}` | soft delete; removes thumb |
| GET | `/artifacts/:id/versions` | — | version rows | |
| POST | `/artifacts/:id/rollback` | `{version}` (int or version-id) | `{artifact,version,files}` | **409** if linked |
| GET | `/artifacts/:id/manifest` | — | version `manifest_json` | |
| POST | `/artifacts/present-file` | `{path, title?, metadata?, copy?, open?}` | artifact (201) | copies a file into the workspace |

Legacy surface-compat routes proxy to the same artifact layer: `GET/POST /surfaces`, `GET /surfaces/:id`, `GET /surfaces/:id/html`, `PUT /surfaces/:id`, `DELETE /surfaces/:id` (`server/routes.ts:308-441`). `GET /surfaces` returns denormalized cards (`?include_hidden=1` to include `metadata.hidden` rows). See [artifacts.md](artifacts.md).

## Linking

| Method | Path | Body | Response | Notes |
| --- | --- | --- | --- | --- |
| POST | `/artifacts/link` | `{path, entry?, title, metadata?, open?}` | artifact (201) | directory link requires `entry`; see [linked-artifacts.md](linked-artifacts.md) |
| POST | `/artifacts/:id/touch` | — | `{touched:true}` | broadcasts `surface_updated` reload; 404 if missing |

## Files / view / thumb

| Method | Path | Query | Response | Notes |
| --- | --- | --- | --- | --- |
| GET | `/artifacts/:id/view` | `preview=1` | HTML | redirects to the file for `text/html`, else a renderer shell for img/video/audio/pdf/md/text (`server/routes.ts:653-681`) |
| GET | `/artifacts/:id/files/*` | — | file bytes | served from `artifact_files`; linked artifacts fall back to disk under `workspace_path` with path-escape/symlink **403** guards (`server/routes.ts:734-793`) |
| GET | `/artifacts/:id/thumb` | `regenerate=1`, `v=` | PNG or SVG placeholder | cached PNG if present, image passthrough for image mimes, else SVG placeholder + enqueue capture. See [thumbnails.md](thumbnails.md). |

## Display control

| Method | Path | Body | Response | Effect |
| --- | --- | --- | --- | --- |
| GET | `/display/config` | — | theme config | |
| PUT | `/display/config` | theme JSON (merged) | merged config | broadcasts `display_theme` |
| POST | `/display/reset` | — | `{reset:true}` | clears theme, broadcasts `display_theme` `{}` |
| GET | `/display/status` | — | presence + `stale` flag | in-memory; stale after 60s |
| POST | `/display/presence` | `{current_view, current_surface_id, viewport_*}` | `{ok:true}` | PWA reports presence |
| POST | `/display/navigate` | `{surface_id?}` | `{navigated:true}` | broadcasts `display_navigate` |
| POST | `/display/notify` | `{text, duration?, style?}` | `{sent:true}` | broadcasts `display_notify` |
| GET | `/display/renderer/html` \| `/home/html` \| `/overlay/html` | — | HTML or 404 | custom display HTML from theme config |

See [../display/theming.md](../display/theming.md).

## Actions / reply / exec

| Method | Path | Body | Response | Notes |
| --- | --- | --- | --- | --- |
| POST | `/surfaces/:id/actions` | `{action, data?}` | action row (201) | user→agent; broadcasts `surface_action`, fans out webhook |
| GET | `/actions` | — | pending actions (all) | agent polls |
| GET | `/surfaces/:id/actions` | — | pending actions (one surface) | |
| POST | `/actions/:id/ack` | — | `{acknowledged:true}` | marks handled |
| POST | `/surfaces/:id/reply` | `{text}` | `{sent:true}` | broadcasts `agent_reply` (toast) |
| POST | `/surfaces/:id/exec` | `{js}` | `{executed:true}` | broadcasts `surface_exec` |

Optional webhook fan-out on `surface_action` posts to `SURFACE_WEBHOOK_URL + SURFACE_WEBHOOK_PATH` with `SURFACE_WEBHOOK_TOKEN` (legacy `OPENCLAW_*` aliases), throttling failure toasts to one/minute (`server/routes.ts:11-57`). See [../interaction/delivery-ladder.md](../interaction/delivery-ladder.md).

## SSE streams

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/stream` | global event stream (all surfaces) |
| GET | `/surfaces/:id/stream` | per-surface stream (404 if neither artifact nor legacy surface exists) |

Full event catalog: [events.md](events.md).

## Proxies

| Method | Path | Body / Query | Notes |
| --- | --- | --- | --- |
| POST | `/api/chat` | `{messages, model?, stream?}` | OpenRouter proxy; needs `OPENROUTER_API_KEY`; rate-limited `SURFACE_CHAT_RATE_LIMIT`/min (default 30, **429** on excess); SSE passthrough when `stream` (`server/routes.ts:1066-1141`). |
| POST | `/api/nexlayer/deploy` | `{yaml, sessionToken?}` | proxies `startUserDeployment` |
| POST | `/api/nexlayer/extend` | `{applicationName, sessionToken}` | proxies `extendDeployment` |
| GET | `/api/nexlayer/status` | `?sessionToken=` | proxies `getReservations` |
| GET | `/proxy/pdf` | `?url=` | streams a remote PDF stripping X-Frame-Options; refuses private/loopback/link-local/metadata hosts (SSRF guard) and refuses to follow redirects (`server/routes.ts:1143-1228`). |

## Related
- [events.md](events.md) — SSE event payloads
- [artifacts.md](artifacts.md) — data model behind the CRUD routes
- [linked-artifacts.md](linked-artifacts.md) — link/touch/file-serving details
- [thumbnails.md](thumbnails.md) — the thumb route
- [../auth/trust-model.md](../auth/trust-model.md) — auth resolution and loopback trust
- [../operations/security.md](../operations/security.md) — SSRF guards, env vars
