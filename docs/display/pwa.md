# Dashboard PWA

**Status:** Shipped
**Code:** `client/app.js`, `client/index.html`, `client/manifest.json`, `client/style.css`, `client/pair.html`

The Surface dashboard is a single-page, vanilla-JavaScript progressive web app served from `client/`. It is the human-facing view of the display: a grid of surface cards backed by cached thumbnails, a full-screen iframe detail view fed by live SSE, and a cosmic background. There is no build step — `client/index.html` loads `app.js` and `style.css` directly with a `?v=N` cache-busting query. All state lives in module-level globals at the top of `app.js` (`surfaces`, `globalSSE`, `surfaceSSE`, `currentSurfaceId`, `displayConfig`).

## Routing

Hash-based, two routes (`getRoute`, `client/app.js`):

- `#/` (or empty) → grid view.
- `#/surface/:id` → surface detail view (regex `^\/surface\/(.+)$`).

`navigate(path)` sets `window.location.hash`; a `hashchange` listener re-runs `render()`. `render()` fetches `GET /artifacts` — full card payloads in **one request** (the list route is denormalized precisely so the grid needs no per-card fan-out) — stores them in `surfaces`, and calls `renderGrid()` or `renderSurface()`. It also calls `reportPresence()` on every render and on window resize.

## Grid view

`renderGrid()` (`client/app.js`) builds the header, optional home widget, toolbar, and card grid inside the cosmic container.

- **Header** (`client/app.js`) shows the display title (`displayConfig.title || "Surface"`), the subtitle "a universal display for your agents", a zero-padded **count badge** (`02 surfaces`), and a `station` indicator that gets an `online` class when the global SSE connection opens (`setOnline`, `client/app.js`).
- **Cards** (`createCard`): each card shows a cached thumbnail `<img src="/artifacts/:id/thumb?v=<updated_at>">` with an icon fallback on `onerror` (`iconForMime`), a **live** badge when `updated_at` is under 60s old, a title, and a subline carrying MIME/template, project or agent attribution, and time-ago. Delivery-ladder state rides the card too: a pending-action count badge (`pending_actions`) and a "● listening" pill while a waiter is connected (`updateCardBadges`). Cards have a pointer tilt effect (`bindCardTilt`) and a per-card animation delay.
- **Card actions** (`client/app.js`): copy-link (writes `origin + /surface/:id` to clipboard, toasts "Link copied"), rename (`startRename` does inline editing then `PUT /artifacts/:id`), and delete (`confirm()` then `DELETE /artifacts/:id`). Actions stop click propagation so they don't trigger card navigation.
- **Toolbar** (`createGridToolbar`, `client/app.js`): a search box (title substring filter), MIME filter chips (All / HTML / Video / Audio / Image / Other, `FILTER_GROUPS` at `client/app.js`), and a sort `<select>` (Newest / Oldest / A–Z / Z–A). State lives in `gridQuery`, `gridSort`, `gridFilter`; `applyGridFilters` + `paintGrid` re-render without a full reload.
- **Agent-defined order**: if `displayConfig.order` is set, surfaces are sorted by that list first, then by `updated_at` (`client/app.js`).

### Cmd+K finder

A global `keydown` listener opens `openSurfaceFinder()` on Cmd/Ctrl+K (`client/app.js`). It is a modal palette with a title-substring filter (top 50 when empty), arrow-key navigation, Enter to open, and Escape/backdrop to close (`client/app.js`).

### Empty state

When there are no surfaces and no home widget (`client/app.js`), the grid shows the empty state: a "What should I make?" prompt, a typewriter cycle of suggestions (`cycleEmptySuggestions` / `EMPTY_SUGGESTIONS`, `client/app.js`), a "Start Tutorial" button that opens a modal handing the user a copy-paste prompt for `docs/TUTORIAL.md` (`showTutorialModal`, `client/app.js`), and the **demo idea portal** — a revolving vertical carousel of product-native demo surfaces served from `/demos/` (`SURFACE_IDEAS` / `mountGallery`, `client/app.js`). Each portal card embeds the demo in an iframe and has a copy-prompt button; clicking opens `showIdeaModal` with the user-voice prompt (`client/app.js`).

## Surface detail view

`renderSurface(id)` fetches `/artifacts/:id`, renders a back button, title, MIME/time/`live` meta, and a full-screen iframe (`surface-frame`). The iframe `src` is the artifact's `view_url` (falling back to `/artifacts/:id/view`). It opens a per-surface `EventSource` at `/artifacts/:id/stream` and handles:

- **`surface_updated`**: on `reload`/`version_id`, reloads the iframe with a fresh `?v=<now>` and adds a `refreshing` blur-fade class; on `title`/`updated_at`, patches the nav text in place.
- **`agent_reply`**: shows the reply text as a toast.
- **`surface_exec`**: best-effort JS injection into the open iframe. It works for same-origin frames the PWA can access; device/browser isolation can make it a no-op, and errors are caught and logged.

(`state_patch` and `stream_append` are consumed by the injected `surface.js` runtime inside the iframe itself, not by the PWA shell.)

## iframe actions and postMessage bridge

Modern artifacts use the injected `surface.js` runtime: `Surface.action(name, data)` posts directly to the artifact's origin so actions are attributed to the artifact that emitted them. A top-level `message` listener remains for older surface/renderer iframes and accepts two message types:

- **`surface_navigate`** — navigate to a surface id or home (used by custom renderers/overlays).
- **`surface_action`** — `POST /artifacts/:id/actions` with `{ action, data }`, preferring an explicit `surface_id` in the message and falling back to the currently viewed surface.

## Global SSE

`connectGlobalSSE()` opens `/stream` and drives the grid live: `surface_created` (prepends a card, removes the empty state), `surface_updated` (patches card, handles `metadata.hidden` removal and un-hide re-fetch — used by `clear-demos`/`seed-demos`), `surface_deleted` (animated removal), `surface_action`/`actions_acked` (pending-badge counts), `waiter_status` ("● listening" pill), `thumb_ready` (cache-busts the card thumbnail), plus agent display commands: `display_navigate`, `display_notify` (toast), and `display_theme` (re-applies theme, re-renders if a custom renderer was added/removed). SSE activity also triggers the cosmic `pulseSpace()` aurora burst.

## Toasts

`showToast(text, duration, style)` (`client/app.js`) appends a transient `.toast` element with `info`/`success`/`error` styling. Triggered by copy actions, `agent_reply`, and `display_notify`.

## Presence reporting

`reportPresence()` (`client/app.js`) `POST`s `/display/presence` with `{ current_view, current_surface_id, viewport_width, viewport_height }` on every render and on resize. The server tracks this in memory and exposes it at `GET /display/status` (stale after 60s).

## Auth gate

Before starting, the app calls `GET /api/auth/session` (`client/app.js`). Only an explicit `authenticated: false` redirects the browser to `/pair`; transient/network errors fall through to `startApp()` so a momentarily-down server never bounces between `/` and `/pair`. `startApp()` fetches `/display/config`, applies the theme, and renders (`client/app.js`). The pairing page (`client/pair.html`) reads a one-time token from the URL fragment, strips it from history, and exchanges it at `POST /api/auth/bootstrap`. See [device pairing](../auth/device-pairing.md).

## PWA manifest

`client/manifest.json` declares `display: standalone`, black background/theme colors, an inline SVG icon, and `start_url: "/"`. `client/index.html` adds the Apple mobile-web-app meta tags and a `theme-color` meta that `applyTheme` updates from `config.colors.void`.

## Cosmic background

A starfield/nebula/comet substrate is inserted on the grid view and is on by default; themes opt out wholesale with `starfield: false`.

- **Starfield** (`createStarfield`, `client/app.js`): three parallax star layers (110 far / 55 mid / 18 near) plus an aurora ribbon. Parallax follows pointer movement and `deviceorientation` gyro (`initParallax`, `client/app.js`).
- **Nebulae** (`createNebulae`, `client/app.js`): three radial-gradient blobs, optionally recolored via `nebulaColors`.
- **Comets**: a background shower fires a streak every 22–52s when the tab is visible (`startCometShower`, `client/app.js`); SSE events trigger an aurora burst and occasional comet via `pulseSpace` (`client/app.js`).

The whole stack is toggled by the theme's `starfield` flag inside `applyTheme` (`client/app.js`). See [theming](theming.md) for how the agent controls it.

## Related
- [theming](theming.md) — how agents customize the display
- [devices](devices.md) — multi-device / presence
- [events](../core/events.md) — SSE event reference
- [device pairing](../auth/device-pairing.md) — the `/pair` auth gate
- [thumbnails](../core/thumbnails.md) — `/artifacts/:id/thumb`
