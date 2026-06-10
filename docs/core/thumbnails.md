# Thumbnail Pipeline

**Status:** Shipped
**Code:** `server/thumbs.ts`, `server/routes.ts` (the `/artifacts/:id/thumb` route), `server/index.ts` (boot backfill)

Surface renders a 600×600 PNG screenshot of each surface for the dashboard grid. Captures run through a headless Chrome instance over the Chrome DevTools Protocol (CDP), serialized through a single in-process queue. When no Chrome is available, the thumb route falls back to a generated SVG placeholder, so the dashboard still renders.

## Chrome discovery

`findChromeBin` (`server/thumbs.ts:33-58`) returns `SURFACE_CHROME` if set, otherwise probes `google-chrome-stable`, `google-chrome`, `chromium`, `chromium-browser`, `chrome` (first that answers `--version` with exit 0). The result is cached for the process. If none is found, boot logs a warning and the system degrades to SVG placeholders (`server/index.ts:165-167`, `server/thumbs.ts:76-84`).

## Capture flow (`capture` / `runCdpCapture`, `server/thumbs.ts:101-286`)

1. Spawn Chrome headless with `--remote-debugging-port=0` against `about:blank` and a throwaway `--user-data-dir`. Flags include `--headless=new`, `--no-sandbox`, `--disable-dev-shm-usage`, and a long list of network/feature disables (`server/thumbs.ts:109-132`).
2. **WebGL via SwiftShader:** `--use-gl=angle`, `--use-angle=swiftshader`, `--enable-unsafe-swiftshader` so canvas/WebGL demos render without a GPU.
3. Parse `DevTools listening on (ws://…)` from Chrome's stderr, then open that WebSocket.
4. `Target.getTargets` → find the existing `page` target → `Target.attachToTarget` (`flatten:true`) to get a session (`server/thumbs.ts:255-264`). The capture attaches to the page Chrome already opened rather than creating a new one.
5. `Emulation.setDeviceMetricsOverride` to 600×600, `deviceScaleFactor:1`, `mobile:false`.
6. `Page.navigate` to `http://127.0.0.1:<port>/artifacts/<id>/view?preview=1` — the chromeless preview shell.
7. Wait a **fixed 6.5s** (`POST_NAVIGATE_DELAY_MS`, `server/thumbs.ts:9`) for animations/data to settle — there is no readiness signal; it is a constant delay.
8. `Page.captureScreenshot` (`png`, clip 0,0,600,600) → decode base64 → write to disk.

An overall **45s timeout** (`OVERALL_TIMEOUT_MS`) guards each capture; the temp profile dir and Chrome process are always cleaned up.

## Serial queue (`server/thumbs.ts:60-99`)

`enqueueThumb(id)` is a no-op until the server port is set (`setThumbServerPort`, called on listen). It dedupes by id, then `drain()` processes one job at a time (`running` guard). Each route that changes an artifact's content calls `enqueueThumb` (create/update/touch/rollback/present/link). On success, the queue broadcasts a `thumb_ready` event (see [events.md](events.md)).

## Cache & serving (`/artifacts/:id/thumb`, `server/routes.ts:683-732`)

- PNGs are cached at `~/.surface/thumbs/<id>.png` (`getThumbPath`, `server/thumbs.ts:25-27`).
- The route serves, in order: the cached PNG if it exists; for image-mime artifacts, the image bytes themselves (passthrough); otherwise an SVG placeholder, while enqueueing a real capture.
- **SVG placeholder** (`renderThumbPlaceholder`, `server/routes.ts:1541-1555`) is colored by mime via `paletteForMime` (HTML, VIDEO, AUDIO, PDF, MD, IMAGE, TEXT, FILE) with the wrapped title.
- `?regenerate=1` deletes the cached PNG, enqueues a fresh capture, and returns the placeholder immediately (`server/routes.ts:692-701`).
- **Cache busting:** the PWA requests `/artifacts/<id>/thumb?v=<updated_at>` (`client/app.js:1219-1220`) so a new version refetches; on a `thumb_ready` event it swaps in `?v=Date.now()` (`client/app.js:1562-1570`). The `v` param is only a cache key — the route does not read it.
- Response sets `Cache-Control: public, max-age=60, stale-while-revalidate=600`.

## Boot backfill (`server/index.ts:165-182`)

After the server starts, if Chrome is available, it scans all surface cards (including hidden) and enqueues a capture for every one that lacks a cached PNG, logging the queued count. With no Chrome, it skips and warns.

## Deletion lifecycle

When an artifact or surface is deleted, the route removes `~/.surface/thumbs/<id>.png` (`fs.rmSync(getThumbPath(id), {force:true})`, `server/routes.ts:438,638`).

## Related
- [events.md](events.md) — the `thumb_ready` event
- [http-api.md](http-api.md) — the `/artifacts/:id/thumb` and `/artifacts/:id/view` routes
- [artifacts.md](artifacts.md) — the `thumbs/` cache dir under `~/.surface/`
- [../display/pwa.md](../display/pwa.md) — how the grid consumes thumbnails
- [../operations/install.md](../operations/install.md) — installing Chrome / `SURFACE_CHROME`
