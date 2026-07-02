# Display Theming

**Status:** Shipped (2026-06)
**Code:** `client/app.js` (`applyTheme`, `renderOverlay`), `server/routes/display.ts` (`/display/config`, `/display/reset`, `/display/slots`, `/display/renderer/html`, `/display/home/html`, `/display/overlay/html`), `server/displayConfig.ts` (`getDisplayConfig`/`setDisplayConfig`/`resetDisplayConfig`), `bin/surface.ts` (`theme`, `slot`)

Agents own the look of the display. A single JSON config object holds the cosmetic customization — colors, fonts, background, raw CSS, card radius, starfield toggle, title — while the three display extension points (home widget, full renderer, persistent overlay) are **slot artifacts** (see below). The config is set with `PUT /display/config`, persisted in the `display_config` table, broadcast to every connected browser over SSE, and applied client-side by `applyTheme`.

## The config object

`PUT /display/config` merges its JSON body into the stored config (`setDisplayConfig` does `{ ...existing, ...body }`, `server/displayConfig.ts`) and broadcasts a `display_theme` event with the merged result (`server/routes/display.ts`). Recognized keys (consumed by `applyTheme`, `client/app.js`):

| Key | Effect |
| --- | --- |
| `title` | Grid header title (default `"Surface"`). |
| `background` | `document.body.style.background` (any CSS background value). |
| `colors` | Object mapped to CSS custom properties: `void → --void`, `glass → --glass`, `glassBorder → --glass-border`, `glassGlow → --glass-glow`, `textPrimary → --text-primary`, `textSecondary → --text-secondary`, `textGhost → --text-ghost`, `accent → --accent`. `colors.void` also sets the `<meta name="theme-color">`. |
| `font` | `document.body.style.fontFamily`. |
| `cardRadius` | `--card-radius`. |
| `css` | Raw CSS injected into a `<style id="theme-css">` in `<head>`. |
| `starfield` | `false` hides the entire cosmic substrate (starfield, nebulae, aurora, grain, comets) via `display:none`. On by default. |
| `nebula` / `nebulaColors` | Optional nebula recolor (back-compat; `nebulaColors` is a ≥2-element array of CSS colors). |
| `order` | Array of surface ids controlling grid sort order. |

Stringified fields (`colors`, `nebulaColors`, `order`, boolean `starfield`/`nebula`) are normalized through `jsonParse` on the client, so values stored as JSON strings still apply. The old raw-HTML keys `renderer`/`home`/`overlay` are **rejected** by `PUT /display/config` (stripped from the body, with a `_hint` in the response) — slots are artifacts now.

## Renderer / home / overlay: slots are artifacts

The three display extension points are ordinary **artifacts** whose metadata carries `display_role: "renderer" | "home" | "overlay"` — versioned, linkable from disk, thumbnailed, and rollback-able like everything else (decided 2026-06; the raw config blobs are gone). The newest non-hidden artifact with a role wins (`slotArtifact`, `server/routes/display.ts`).

```bash
surface slot                          # show current assignments → GET /display/slots
surface slot renderer <artifact-id>   # make that artifact the renderer (sets metadata.display_role)
surface slot home --clear             # vacate a slot
```

The PWA consumes slots through dedicated routes:

- **`GET /display/renderer/html`** returns a 404 if no renderer slot is filled; otherwise it prepends an injected `<script>` exposing a renderer API to the iframe — `window.__surfaces` (the card list), `navigate(id)` / `navigateHome()` (via `surface_navigate` postMessage), `getSurface(id)`, `parseMeta`, `previewUrl(id)`, and `onSurfaceChange(handlers)` (an `/stream` wrapper) — then the slot artifact's HTML. When a renderer is set, the grid view becomes a single full-bleed iframe pointed at this route.
- **`GET /display/home/html`** returns the home slot's HTML. The PWA mounts it as an auto-sizing iframe above the card grid.
- **`GET /display/overlay/html`** returns the overlay slot's HTML. The PWA mounts it as a persistent overlay iframe (`renderOverlay`).

All three are cache-busted with `?<timestamp>` on theme changes.

## CSS layering and substrate toggle

Injected `css` is placed in `<style id="theme-css">` (shell styles use `@layer theme` so the framework's own rules can still win). The cosmic substrate (see [pwa.md](pwa.md)) is on by default; `starfield: false` is the single switch a theme uses to take over the background entirely — `applyTheme` hides `#starfield` and every `.nebula`/`.aurora`/`.grain` element.

## CLI usage

`surface theme` (`bin/surface.ts`):

```bash
surface theme                                   # GET current config (no args)
surface theme '{"colors":{"accent":"#ff0080"}}' # PUT — merged into config
surface theme -                                 # PUT — read JSON from stdin
surface theme reset                             # POST /display/reset
```

The argument must be valid JSON or the CLI exits with a usage error. Because `setDisplayConfig` merges, partial updates are additive — send only the keys you want to change.

## Reset

`POST /display/reset` deletes the `theme` row (`resetDisplayConfig`, `server/displayConfig.ts`) and broadcasts `display_theme` with `{}`. On the client, `applyTheme({})` strips all inline styles, removes the injected `theme-css`, overlay, and home-widget elements, and clears `displayConfig`.

## Persistence and live propagation

The config is a single row in the `display_config` table keyed `theme`, holding the JSON blob (`server/displayConfig.ts`). `getDisplayConfig` reads and parses it. Every mutating route (`PUT /display/config`, `POST /display/reset`) broadcasts a global `display_theme` SSE event so all open browsers re-apply the theme immediately without a reload — `connectGlobalSSE` listens for it and calls `applyTheme`, re-rendering when the renderer slot changed.

## Related
- [pwa.md](pwa.md) — the dashboard that consumes the theme
- [../roadmap.md](../roadmap.md) — the slots-as-artifacts decision record
- [../core/events.md](../core/events.md) — the `display_theme` SSE event
- [../core/cli.md](../core/cli.md) — `surface theme` / `surface slot`
