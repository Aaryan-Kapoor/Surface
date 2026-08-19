# Dashboard PWA

**Status:** Shipped
**Code:** `client/app.js`, `client/index.html`, `client/manifest.json`, `client/style.css`, `client/pair.html`

The Surface dashboard is a single-page, vanilla-JavaScript progressive web app served from `client/`. It is the human-facing view of the display: a grid of surface cards whose previews are real screenshots of the surfaces, and a full-screen iframe detail view fed by live SSE under a 40px bar. There is no build step — `client/index.html` loads `app.js` and `style.css` directly with a `?v=N` cache-busting query. All state lives in module-level globals at the top of `app.js` (`surfaces`, `globalSSE`, `currentSurfaceId`, `displayConfig`).

## Design tokens and colour schemes

`client/style.css` derives everything from **two** tokens, `--bg` and `--fg`. Muted/faint/ghost ink, panel fills and hairlines are `color-mix(in oklab, …)` of that pair, each with a plain rgba fallback declared immediately before it for engines without `color-mix`.

The default scheme is dark; a `@media (prefers-color-scheme: light)` block on `:root` swaps `--bg`/`--fg` plus the panel and shadow values, and `color-scheme` is set so form controls and scrollbars follow. `client/index.html` ships one `theme-color` meta per scheme.

An agent theme overrides the same two tokens: `applyTheme` maps `colors.void → --bg` and `colors.textPrimary → --fg` (plus `glass → --panel-solid`, `glassBorder → --line`, `textSecondary`/`textGhost`), and keeps writing the legacy `--void` / `--text-*` names so older theme CSS still resolves. See [theming](theming.md).

## Routing

Hash-based, two routes (`getRoute`, `client/app.js`):

- `#/` (or empty) → grid view.
- `#/surface/:id` → surface detail view (regex `^\/surface\/(.+)$`).

`navigate(path)` sets `window.location.hash`; a `hashchange` listener re-runs `render()`. `render()` fetches `GET /artifacts` — full card payloads in **one request** (the list route is denormalized precisely so the grid needs no per-card fan-out) — stores them in `surfaces`, and calls `renderGrid()` or `renderSurface()`. It also calls `reportPresence()` on every render and on window resize.

## Grid view

`renderGrid()` (`client/app.js`) builds the header, optional home widget, toolbar, and card grid inside the cosmic container.

- **Header** (`client/app.js`) is sticky, 60px, and holds the display title (`displayConfig.title || "Surface"`), the subtitle, the search field, the surface count, and a live indicator that gets an `online` class when the global SSE connection opens (`setOnline`, `client/app.js`). It grows a hairline rule only once content scrolls under it (`.is-scrolled`, toggled inside `requestAnimationFrame` so the scroll listener never forces a synchronous layout).
- **Release notice** (`paintUpdateNotice` / `updateNoticeModel`, `client/app.js`): a bordered pill in the same meta row, hidden unless there is something to say. It reads `Surface 0.2.4 available` with an **Update** button on the system plane of a global install, and the same text with a `title` explaining where to update instead on a repo clone, a project-local install, or a paired device. During a run it shows the phase (`Installing 0.2.4…` → `Restarting Surface…`); afterwards `Updated to 0.2.4` (auto-dismissed after 10s) or `Update failed — <reason>` (dismissed by hand). Dismissal is remembered per run in `localStorage["surface:update-seen"]`. State comes from `GET /api/update/status` at boot, the `update_status` SSE event, and — only while a run is in flight — a 1.5s poll that survives the service restart, giving up honestly after two minutes. When the run finishes on a new version the page reloads once so the client bundle matches the server. See [../operations/install.md](../operations/install.md#update-notification-and-one-click-update).
- **Cards** (`createCard`): a 16:10 preview with a two-line caption underneath. The preview is the cached capture, `object-fit: cover` cropped from the **top** — surfaces lead with a headline, so a top crop is the one that keeps it. The caption is the title plus a subline carrying kind, agent/project attribution and time-ago (`cardSubtitle`; attribution is dropped under 760px, where a ~170px card cannot hold three facts). Delivery-ladder state rides the preview: a **live** pill when `updated_at` is under 60s old, a pending-action count badge (`pending_actions`), and a "listening" / "handling…" pill (`updateCardBadges`, `setCardHandling`).
- **Covers** (`buildFallbackCover`): when the card list says `has_thumb: false`, the card paints its own cover instead of fetching a placeholder it would replace seconds later — a tinted field whose hue is FNV-1a of the surface id, the kind, and the title set large. On `thumb_ready` the real PNG is decoded off-thread and only swapped in once it is paintable, so the card never flashes empty. This mirrors the server's SVG placeholder (see [thumbnails](../core/thumbnails.md)).
- **Card actions** (`client/app.js`): copy-link (writes `origin + /surface/:id` to clipboard, toasts "Link copied"), rename (`startRename` does inline editing then `PUT /artifacts/:id`), and delete (`confirm()` then `DELETE /artifacts/:id`). The tray is revealed on hover/focus; on hover-less pointers a `⋯` button in the **caption** toggles it, so the preview is never covered by chrome. Actions stop click propagation so they don't trigger card navigation.
- **Toolbar** (`createGridToolbar`, `client/app.js`): MIME filter chips (`FILTER_GROUPS`) and a sort `<select>` (Newest / Oldest / A–Z / Z–A); search lives in the header. Only groups with members are offered (`activeFilterGroups`), and the row is dropped entirely when that leaves nothing but "All". State lives in `gridQuery`, `gridSort`, `gridFilter`; `applyGridFilters` + `paintGrid` re-render without a full reload.
- **Responsive**: column width is `--card-min` per breakpoint (280px ≥1200, 250px default, 215px ≤1100) rather than one auto-fill floor, plus a fixed 2-up ≤760px and 1-up ≤380px. A single floor that suits a wide desktop strands an 820px tablet on two enormous columns.

### Grid performance

- Thumbnails carry `loading="lazy"` + `decoding="async"`, and their URL is held in `data-src` until an `IntersectionObserver` (400px `rootMargin`) brings the card near the viewport — a hundred-surface grid issues no requests for what you cannot see.
- `.card-preview` sets an explicit `aspect-ratio`, so a row never reflows as images land.
- `.surface-card` uses `contain: layout paint style` plus `content-visibility: auto` with a `contain-intrinsic-size`, so off-screen cards skip layout and paint while the scrollbar stays honest.
- `paintGrid` builds every card into one `DocumentFragment` and inserts once.
- Card enter animations are staggered only for the first 12 cards; beyond that the delay just makes a fast grid feel slow.
- The thumb route hard-caches a versioned capture (`?v=<updated_at>` → `max-age=31536000, immutable`); covers and unversioned requests stay on a short revalidating window. See [thumbnails](../core/thumbnails.md).
- **Agent-defined order**: if `displayConfig.order` is set, surfaces are sorted by that list first, then by `updated_at` (`client/app.js`).

### Cmd+K finder

A global `keydown` listener opens `openSurfaceFinder()` on Cmd/Ctrl+K (`client/app.js`). It is a modal palette with a title-substring filter (top 50 when empty), arrow-key navigation, Enter to open, and Escape/backdrop to close (`client/app.js`).

### Empty state

When there are no surfaces and no home widget (`client/app.js`), the grid shows the empty state: a "Surface is listening" eyebrow, a "What should I make?" prompt, a typewriter cycle of suggestions (`cycleEmptySuggestions` / `EMPTY_SUGGESTIONS`, `client/app.js`), a "Start the tutorial" button that opens a modal handing the user a copy-paste prompt for `docs/TUTORIAL.md` (`showTutorialModal`, `client/app.js`), and the **demo idea portal** — a revolving vertical carousel of product-native demo surfaces served from `/demos/` (`SURFACE_IDEAS` / `mountGallery`, `client/app.js`). Each portal card embeds the demo in a 16:10 frame and has a copy-prompt button. The iframe renders at 150% and is scaled to 0.667, so the frame shows the *whole* surface the way a screenshot would rather than a zoomed crop of its top-left corner.

## Surface detail view

`renderSurface(id)` fetches `/artifacts/:id`, renders the bar, and mounts a full-screen iframe (`surface-frame`). The iframe `src` is the artifact's `view_url` (falling back to `/artifacts/:id/view`).

**The bar** (`.surface-nav`) is a single 40px row — leave, identify, state — over a translucent blurred `--bg` with a hairline underneath, plus `env(safe-area-inset-top)`. It carries a chevron back button (Escape does the same, unless a modal/finder is open or focus is in a field), the surface title, a meta run of kind · time-ago · `live`, and two icon actions: copy link, and open the raw surface in a new tab. Under 760px the meta collapses to the live indicator alone so the title keeps the width.

**Detail-view events are multiplexed over the global stream.** The PWA opens **exactly one** `EventSource`, on `/stream` (see [Global SSE](#global-sse)) — enforced by `test/appRouting.ts` — and the detail view filters that stream for the surface it is showing. It does *not* open `/artifacts/:id/stream`; that route still exists for non-PWA consumers (`server/routes/artifacts.ts`), but the app never uses it, because a second connection per open surface bought nothing and cost a socket. The events the detail view acts on are:

- **`surface_updated`**: on `reload`/`version_id`, reloads the iframe with a fresh `?v=<now>` and adds a `refreshing` blur-fade class; on `title`/`updated_at`, patches the nav text in place.
- **`agent_reply`**: shows the reply text as a toast.
- **`surface_exec`**: best-effort JS injection into the open iframe. It works for same-origin frames the PWA can access; device/browser isolation can make it a no-op, and errors are caught and logged.

`state_patch` and `stream_append` are not acted on by the shell itself: it relays them to same-origin surface iframes through `window.__surfaceHostSubscribe`, so the injected `surface.js` runtime gets its events off the one connection instead of opening a third. Cross-origin device content cannot reach that function and keeps its own content-plane stream, which is the point — the trust boundary stays, the socket count does not.

## iframe actions and postMessage bridge

Modern artifacts use the injected `surface.js` runtime: `Surface.action(name, data)` posts directly to the artifact's origin so actions are attributed to the artifact that emitted them. A top-level `message` listener remains for older surface/renderer iframes and accepts two message types:

- **`surface_navigate`** — navigate to a surface id or home (used by custom renderers/overlays).
- **`surface_action`** — `POST /artifacts/:id/actions` with `{ action, data }`, preferring an explicit `surface_id` in the message and falling back to the currently viewed surface.

## Global SSE

`connectGlobalSSE()` opens `/stream` and drives the grid live: `surface_created` (prepends a card, removes the empty state), `surface_updated` (patches card, handles `metadata.hidden` removal and un-hide re-fetch — used by `clear-demos`), `surface_deleted` (animated removal), `surface_action`/`actions_acked` (pending-badge counts), `waiter_status` ("listening" pill), `thumb_ready` (swaps in the freshly captured PNG, replacing the card's own cover once the image has decoded), plus agent display commands: `display_navigate`, `display_notify` (toast), and `display_theme` (re-applies theme, re-renders if a custom renderer was added/removed).

## Toasts

`showToast(text, duration, style)` (`client/app.js`) appends a transient `.toast` element with `info`/`success`/`error` styling. Triggered by copy actions, `agent_reply`, and `display_notify`.

## Presence reporting

`reportPresence()` (`client/app.js`) `POST`s `/display/presence` with `{ current_view, current_surface_id, viewport_width, viewport_height }` on every render and on resize. The server tracks this in memory and exposes it at `GET /display/status` (stale after 60s).

## Auth gate

Before starting, the app calls `GET /api/auth/session` (`client/app.js`). Only an explicit `authenticated: false` redirects the browser to `/pair`; transient/network errors fall through to `startApp()` so a momentarily-down server never bounces between `/` and `/pair`. `startApp()` fetches `/display/config`, applies the theme, and renders (`client/app.js`). The pairing page (`client/pair.html`) reads a one-time token from the URL fragment, strips it from history, and exchanges it at `POST /api/auth/bootstrap`. See [device pairing](../auth/device-pairing.md).

## PWA manifest

`client/manifest.json` declares `display: standalone`, an inline SVG icon, and `start_url: "/"`. `client/index.html` adds the mobile-web-app meta tags and **two** `theme-color` metas, one per colour scheme; `applyTheme` overwrites both (and strips their `media` attribute) when a theme sets `colors.void` or a solid `background`.

## Background

A single radial wash from the top edge at 5% `--fg`, drawn on the view container. Themes that paint their own body background cover it.

The starfield / nebula / aurora / comet substrate is **retired**. It was already hidden by the shell CSS, but building it cost ~180 DOM nodes on every grid render plus a `mousemove` parallax listener. `createStarfield`, `createNebulae`, `createGrain`, `pulseSpace` and `startCometShower` survive as no-op stubs so the SSE handlers and older themes that call them keep working, and the `.starfield` / `.nebula` / `.aurora` / `.grain` / `.comet` selectors remain `display: none` for themes that inject their own markup. A theme's `starfield: false` is now a no-op.

## Accessibility

Focus is visible everywhere via a single `:focus-visible` rule (2px `--fg` outline, offset). Cards are keyboard-reachable (`tabIndex`, `role="link"`, Enter/Space) and the hover action tray is also revealed by `:focus-within`. Thumbnails carry real alt text ("Preview of &lt;title&gt;"); decorative SVG icons are `aria-hidden`. Filter chips expose `aria-pressed`, the live indicator is a `role="status"`, and the search and sort controls are labelled. `prefers-reduced-motion: reduce` collapses every animation and transition and disables the card hover lift.

## Related
- [theming](theming.md) — how agents customize the display
- [devices](devices.md) — multi-device / presence
- [events](../core/events.md) — SSE event reference
- [device pairing](../auth/device-pairing.md) — the `/pair` auth gate
- [thumbnails](../core/thumbnails.md) — `/artifacts/:id/thumb`
