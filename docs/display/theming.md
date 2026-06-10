# Display Theming

**Status:** Shipped
**Code:** `client/app.js` (`applyTheme`, `renderOverlay`), `server/routes.ts` (`/display/config`, `/display/reset`, `/display/renderer/html`, `/display/home/html`, `/display/overlay/html`), `server/db.ts` (`getDisplayConfig`/`setDisplayConfig`/`resetDisplayConfig`), `bin/surface.ts` (`theme` subcommand)

Agents own the look of the display. A single JSON config object holds every customization — colors, fonts, background, raw CSS, card radius, starfield toggle, title, and three raw-HTML extension blobs (home widget, full renderer, persistent overlay). The config is set with `PUT /display/config`, persisted in the `display_config` table, broadcast to every connected browser over SSE, and applied client-side by `applyTheme`.

## The config object

`PUT /display/config` merges its JSON body into the stored config (`setDisplayConfig` does `{ ...existing, ...body }`, `server/db.ts:106`) and broadcasts a `display_theme` event with the merged result (`server/routes.ts:877`). Recognized keys (consumed by `applyTheme`, `client/app.js:500`):

| Key | Effect |
| --- | --- |
| `title` | Grid header title (default `"Surface"`). |
| `background` | `document.body.style.background` (any CSS background value). |
| `colors` | Object mapped to CSS custom properties: `void → --void`, `glass → --glass`, `glassBorder → --glass-border`, `glassGlow → --glass-glow`, `textPrimary → --text-primary`, `textSecondary → --text-secondary`, `textGhost → --text-ghost`, `accent → --accent` (`client/app.js:524`). `colors.void` also sets the `<meta name="theme-color">`. |
| `font` | `document.body.style.fontFamily`. |
| `cardRadius` | `--card-radius`. |
| `css` | Raw CSS injected into a `<style id="theme-css">` in `<head>` (`client/app.js:577`). |
| `starfield` | `false` hides the entire cosmic substrate (starfield, nebulae, aurora, grain, comets) via `display:none` (`client/app.js:561`). On by default. |
| `nebula` / `nebulaColors` | Optional nebula recolor (back-compat; `nebulaColors` is a ≥2-element array of CSS colors). |
| `order` | Array of surface ids controlling grid sort order (`client/app.js:1068`). |
| `home` | Raw HTML for the home widget iframe (see below). |
| `renderer` | Raw HTML that replaces the entire grid view (see below). |
| `overlay` | Raw HTML for a persistent overlay iframe across all views. |

Stringified fields (`colors`, `nebulaColors`, `order`, boolean `starfield`/`nebula`) are normalized through `jsonParse` on the client, so values stored as JSON strings still apply (`client/app.js:495,517`).

## Renderer / home / overlay

These three keys hold **raw HTML blobs stored directly in the config**, served from dedicated routes:

- **`GET /display/renderer/html`** (`server/routes.ts:952`) returns a 404 if no renderer is set; otherwise it prepends an injected `<script>` exposing a renderer API to the iframe — `window.__surfaces` (the card list), `navigate(id)` / `navigateHome()` (via `surface_navigate` postMessage), `getSurface(id)`, `parseMeta`, `previewUrl(id)`, and `onSurfaceChange(handlers)` (an `/stream` wrapper) — then the agent's raw `renderer` HTML. When `displayConfig.renderer` is set, the grid view becomes a single full-bleed iframe pointed at this route (`renderGrid`, `client/app.js:1013`).
- **`GET /display/home/html`** (`server/routes.ts:1002`) returns the raw `home` HTML. The PWA mounts it as an auto-sizing iframe above the card grid (`client/app.js:1052`).
- **`GET /display/overlay/html`** (`server/routes.ts:1009`) returns the raw `overlay` HTML. The PWA mounts it as a persistent overlay iframe (`renderOverlay`, `client/app.js:609`).

All three are cache-busted with `?<timestamp>` on theme changes. Note honestly that the renderer/home/overlay are **raw HTML strings inside the display config, not first-class artifacts** — they cannot be versioned, linked from disk, thumbnailed, or rolled back like normal surfaces. **Decided (2026-06): in Phase 4 each slot becomes a first-class artifact** (an artifact whose metadata marks its display role), gaining versioning, linking, and rollback; the raw config blobs are removed. See [../roadmap.md](../roadmap.md).

## CSS layering and substrate toggle

Injected `css` is placed in `<style id="theme-css">` (shell styles use `@layer theme` so the framework's own rules can still win). The cosmic substrate (see [pwa.md](pwa.md)) is on by default; `starfield: false` is the single switch a theme uses to take over the background entirely — `applyTheme` hides `#starfield` and every `.nebula`/`.aurora`/`.grain` element (`client/app.js:561`).

## CLI usage

`surface theme` (`bin/surface.ts:471`):

```bash
surface theme                                   # GET current config (no args)
surface theme '{"colors":{"accent":"#ff0080"}}' # PUT — merged into config
surface theme -                                 # PUT — read JSON from stdin
surface theme reset                             # POST /display/reset
```

The argument must be valid JSON or the CLI exits with a usage error. Because `setDisplayConfig` merges, partial updates are additive — send only the keys you want to change.

## Reset

`POST /display/reset` (`server/routes.ts:884`) deletes the `theme` row (`resetDisplayConfig`, `server/db.ts:102`) and broadcasts `display_theme` with `{}`. On the client, `applyTheme({})` strips all inline styles, removes the injected `theme-css`, overlay, and home-widget elements, and clears `displayConfig` (`client/app.js:501`).

## Persistence and live propagation

The config is a single row in the `display_config` table keyed `theme`, holding the JSON blob (`server/db.ts:96`). `getDisplayConfig` reads and parses it. Every mutating route (`PUT /display/config`, `POST /display/reset`) broadcasts a global `display_theme` SSE event so all open browsers re-apply the theme immediately without a reload — `connectGlobalSSE` listens for it and calls `applyTheme`, re-rendering when the renderer key changed (`client/app.js:1589`).

## Related
- [pwa.md](pwa.md) — the dashboard that consumes the theme
- [../roadmap.md](../roadmap.md) — renderer/home/overlay-as-artifacts is a known wart
- [../core/events.md](../core/events.md) — the `display_theme` SSE event
- [../core/cli.md](../core/cli.md) — `surface theme` and other commands
