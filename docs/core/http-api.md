# HTTP API Reference

**Status:** Shipped (2026-06)
**Code:** `server/routes/{auth,artifacts,actions,display,integrations}.ts` (mounted by `server/routes/index.ts`), `server/index.ts`

Surface is an Express app. A single global auth middleware in `server/index.ts` resolves `req.auth` for every request before the router runs; all routes below assume that resolution has happened. The server binds `127.0.0.1:3000` by default (`SURFACE_BIND`, `PORT`). Request bodies are JSON, `10mb` limit (`server/index.ts`).

## Auth resolution order

The middleware in `server/index.ts` tries, in order, and sets `req.auth = { role, via, sessionId?, label? }`:

1. **Trusted loopback** — remote address in `{127.0.0.1, ::1, ::ffff:127.0.0.1, localhost}` and `SURFACE_TRUST_LOOPBACK != 0` → `system` (`via: loopback`). Operators behind a loopback reverse proxy MUST set `SURFACE_TRUST_LOOPBACK=0`.
2. **Session cookie** — `surface_session` cookie verified via `verifySession` → session role (`via: cookie`).
3. **Session bearer** — `Authorization: Bearer <session-token>` verified → session role (`via: bearer`).
4. **Public bootstrap paths** — pass without auth (see below).
5. Otherwise → **401** `{error, bootstrapMethods:["one-time-token"]}`.

Roles are `system` and `device` ([../auth/trust-model.md](../auth/trust-model.md)). System-only routes re-check `req.auth.role === "system"` via `requireSystem`, returning **403** otherwise (`server/routes/helpers.ts`). The static `SURFACE_TOKEN` path no longer exists; a set env var only logs a startup warning.

**Public (no auth) requests** (`isPublicRequest`, `server/index.ts`): `GET` of `/`, `/index.html`, `/app.js`, `/style.css`, `/manifest.json`, `/pair`, `/pair.html`, `/favicon.ico`; `GET /api/auth/session`; `POST /api/auth/bootstrap`. Static assets serve from `client/` and `examples/demos/`.

## Auth & devices (`server/routes/auth.ts`)

| Method | Path | Body / Query | Response | Caller |
| --- | --- | --- | --- | --- |
| GET | `/api/auth/session` | — | `{authenticated, role, ...}` or `{authenticated:false}` | public |
| POST | `/api/auth/bootstrap` | `{credential, label?}` | session payload + `Set-Cookie` | public; consumes a one-time pairing token |
| POST | `/api/auth/pairing-token` | `{label?, ttlSeconds?, baseUrl?}` | `{id, credential, pairingUrl, expiresAt, role}` | system |
| GET | `/api/auth/pairing-tokens` | — | token summaries | system |
| POST | `/api/auth/pairing-tokens/revoke` | `{id}` | `{revoked}` | system |
| POST | `/api/auth/sessions` | `{label?, ttlSeconds?, role?}` | `{id, token, role, expiresAt}` | system; `role:"system"` mints a system bearer (the remote-agent path) |
| GET | `/api/auth/clients` | — | session list | system |
| POST | `/api/auth/clients/revoke` | `{id}` | `{revoked}` | system |
| POST | `/api/auth/logout` | cookie/bearer | `{revoked}` + clears cookie | any |
| GET | `/api/auth/devices` | — | device sessions + `connected` (live SSE) + `viewing` (presence) | system |
| POST | `/api/auth/devices/revoke` | `{device}` (id, label, or unambiguous label prefix) | `{revoked, device}`; 400 on ambiguity with candidates | system |

See [../auth/device-pairing.md](../auth/device-pairing.md) and [../auth/trust-model.md](../auth/trust-model.md).

## Artifacts CRUD (`server/routes/artifacts.ts`)

| Method | Path | Body / Query | Response | Notes |
| --- | --- | --- | --- | --- |
| GET | `/artifacts` | `?project=`, `?agent=`, `?include_hidden=1` | full card payloads (incl. `pending_actions`, `listening`, `preview_url`/`view_url`) | the one fetch the dashboard grid needs |
| POST | `/artifacts` | `{title, files[]\|content, mime?, kind?, source_type?, metadata?, id?, project_root?}` or `{template, params?, id?, title?, …}` | `{artifact,version,files}` (201) | rejects `source_type:"linked"` (400); with `template` it instantiates server-side (**system**; re-POST with the same id re-renders, idempotently when output is unchanged) |
| GET | `/artifacts/:id` | — | `{artifact,version,files, preview_url, view_url}` | 404 if missing/deleted |
| PUT | `/artifacts/:id` | same as POST + `reason?`; optional `If-Match: <version-id>` header | `{artifact,version,files}` | new version if `files`/`content`; **409** if linked + files; **412** on `If-Match` mismatch |
| DELETE | `/artifacts/:id` | — | `{deleted:true}` | soft delete; removes thumb |
| GET | `/artifacts/:id/versions` | — | version rows | |
| POST | `/artifacts/:id/rollback` | `{version}` (int or version-id) | `{artifact,version,files}` | **409** if linked |
| GET | `/artifacts/:id/manifest` | — | version `manifest_json` | |
| POST | `/artifacts/present-file` | `{path, title?, metadata?, copy?, open?, project_root?}` | artifact (201) | **system** (reads the host filesystem) |
| POST | `/artifacts/link` | `{path, entry?, title, metadata?, open?, project_root?, template?, params?}` | artifact (201) | **system**; directory link requires `entry`; see [linked-artifacts.md](linked-artifacts.md) |
| POST | `/artifacts/:id/touch` | — | `{touched:true}` | broadcasts `surface_updated` reload; 404 if missing |

## Templates (`server/routes/artifacts.ts`)

| Method | Path | Query | Response |
| --- | --- | --- | --- |
| GET | `/api/templates` | `?project=` | `[{name, source, description}]` (project → user → built-in) |
| GET | `/api/templates/:name` | `?project=` | `{name, source, dir, contract}` |

## State & stream chunks (`server/routes/artifacts.ts`)

| Method | Path | Body | Response | Notes |
| --- | --- | --- | --- | --- |
| GET | `/artifacts/:id/state` | — | `{state, state_version}` | open to devices |
| PATCH | `/artifacts/:id/state` | JSON patch (deep-merged; `null` deletes a key) | `{state, state_version}` | **system**; broadcasts `state_patch`; PATCHing the missing id `board` materializes the default board; board sections get server-stamped `updated_at` |
| GET | `/artifacts/:id/chunks` | — | `{chunks}` | current ring buffer |
| POST | `/artifacts/:id/append` | `{content, kind?}` or `{chunks:[{kind?,content}]}` | `{appended, last_seq}` (201) | **system**; broadcasts `stream_append`; cap from `metadata.stream_cap` (default 2000) |

## Files / view / thumb (`server/routes/artifacts.ts`)

| Method | Path | Query | Response | Notes |
| --- | --- | --- | --- | --- |
| GET | `/artifacts/:id/view` | `preview=1` | HTML | redirects to the file for `text/html`; renders the artifact's template on the fly for non-HTML entries of templated artifacts (e.g. `doc`); else a renderer shell for img/video/audio/pdf/md/text (`server/render.ts`) |
| GET | `/artifacts/:id/files/*` | — | file bytes | served from `artifact_files`; HTML gets the `surface.js` runtime injected; linked artifacts fall back to disk under `workspace_path` with path-escape/symlink **403** guards |
| GET | `/artifacts/:id/thumb` | `regenerate=1`, `v=` | PNG or SVG placeholder | cached PNG if present, image passthrough for image mimes, else SVG placeholder + enqueue capture. See [thumbnails.md](thumbnails.md). |

## Actions / bindings / reply / exec (`server/routes/actions.ts`)

| Method | Path | Body | Response | Notes |
| --- | --- | --- | --- | --- |
| POST | `/artifacts/:id/actions` | `{action, data?}` | action row (201) | user→agent; broadcasts `surface_action`, fans out webhook, runs the [delivery ladder](../interaction/delivery-ladder.md); `ask` answers flip state server-side |
| GET | `/actions` | — | pending actions (all) | **system** — the inbox belongs to the agent plane |
| GET | `/artifacts/:id/actions` | — | pending actions (one surface) | **system** |
| POST | `/actions/:id/ack` | — | `{acknowledged:true}` | **system**; broadcasts `actions_acked` with the new pending count |
| POST | `/artifacts/:id/bindings` | `{action_pattern?, run?\|webhook_url?, cwd?, timeout_seconds?}` | binding (201) | **system** |
| GET | `/artifacts/:id/bindings` | — | bindings for one surface | **system** |
| GET | `/bindings` | — | all bindings | **system** |
| DELETE | `/bindings/:id` | — | `{deleted:true}` | **system** |
| PATCH | `/bindings/:id` | `{enabled}` | `{updated:true}` | **system** |
| POST | `/artifacts/:id/reply` | `{text}` | `{sent:true}` | **system**; broadcasts `agent_reply` (toast) |
| POST | `/artifacts/:id/exec` | `{js}` | `{executed:true}` | **system**; broadcasts `surface_exec` |

Optional webhook fan-out on `surface_action` posts to `SURFACE_WEBHOOK_URL + SURFACE_WEBHOOK_PATH` with `SURFACE_WEBHOOK_TOKEN` (legacy `OPENCLAW_*` aliases), throttling failure toasts to one/minute (`server/routes/actions.ts`). See [../interaction/delivery-ladder.md](../interaction/delivery-ladder.md).

## Display control (`server/routes/display.ts`)

| Method | Path | Body | Response | Effect |
| --- | --- | --- | --- | --- |
| GET | `/display/config` | — | theme config | |
| PUT | `/display/config` | theme JSON (merged) | merged config | broadcasts `display_theme`; `renderer`/`home`/`overlay` keys are rejected (slots are artifacts now) |
| POST | `/display/reset` | — | `{reset:true}` | clears theme, broadcasts `display_theme` `{}` |
| GET | `/display/status` | — | `{devices:[…]}` per-device presence + `stale` flag | in-memory; stale after 60s |
| POST | `/display/presence` | `{current_view, current_surface_id, viewport_*}` | `{ok:true}` | keyed by the caller's session target |
| POST | `/display/navigate` | `{surface_id?, device?}` | `{navigated, device}` | broadcasts `display_navigate` (to one device when named) |
| POST | `/display/notify` | `{text, duration?, style?, device?}` | `{sent, device}` | broadcasts `display_notify` (to one device when named) |
| GET | `/display/slots` | — | `{renderer, home, overlay}` artifact ids (or null) | newest non-hidden artifact with `metadata.display_role` wins |
| GET | `/display/renderer/html` \| `/home/html` \| `/overlay/html` | — | HTML or 404 | served from the slot artifact's HTML entry; the renderer gets an injected API script |

See [../display/theming.md](../display/theming.md) and [../display/devices.md](../display/devices.md).

## SSE streams (`server/routes/display.ts`, `server/routes/artifacts.ts`)

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/stream` | global event stream; connections are tagged with their device target; `?wait_for=<surface-id\|*>` registers a layer-1 waiter (system only) |
| GET | `/artifacts/:id/stream` | per-surface stream (404 if the artifact doesn't exist) |

Full event catalog: [events.md](events.md).

## Proxies (`server/routes/integrations.ts`)

| Method | Path | Body / Query | Notes |
| --- | --- | --- | --- |
| POST | `/api/chat` | `{messages, model?, stream?}` | OpenRouter proxy; needs `OPENROUTER_API_KEY`; rate-limited `SURFACE_CHAT_RATE_LIMIT`/min (default 30, **429** on excess); SSE passthrough when `stream`. |
| POST | `/api/nexlayer/deploy` | `{yaml, sessionToken?}` | proxies `startUserDeployment` |
| POST | `/api/nexlayer/extend` | `{applicationName, sessionToken}` | proxies `extendDeployment` |
| GET | `/api/nexlayer/status` | `?sessionToken=` | proxies `getReservations` |
| GET | `/proxy/pdf` | `?url=` | streams a remote PDF stripping X-Frame-Options; refuses private/loopback/link-local/metadata hosts (SSRF guard) and refuses to follow redirects. |

## Related
- [events.md](events.md) — SSE event payloads
- [artifacts.md](artifacts.md) — data model behind the CRUD routes
- [linked-artifacts.md](linked-artifacts.md) — link/touch/file-serving details
- [thumbnails.md](thumbnails.md) — the thumb route
- [../auth/trust-model.md](../auth/trust-model.md) — auth resolution and loopback trust
- [../operations/security.md](../operations/security.md) — SSRF guards, env vars
