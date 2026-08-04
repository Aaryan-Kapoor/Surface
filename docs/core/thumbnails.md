# Thumbnail Pipeline

**Status:** Shipped
**Code:** `server/thumbs.ts`, `server/routes/artifacts.ts` (the `/artifacts/:id/thumb` route), `server/render.ts` (`renderThumbPlaceholder`), `server/index.ts` (boot backfill)

Surface renders a 600×600 PNG screenshot of each surface for the dashboard grid. Captures run through **one long-lived headless Chrome** over the Chrome DevTools Protocol (CDP), drained by a small worker pool. When no Chrome is available, the surface wears a generated cover instead, so the dashboard still renders.

> **Why one browser.** Until this changed, every capture spawned its own Chrome against a throwaway `--user-data-dir`, so each one paid a full cold start — the SwiftShader/ANGLE shader cache was rebuilt from nothing, every time. Measured steady state was **~30s per capture**, meaning a fresh Surface with ten surfaces sat on placeholders for five minutes. Holding one browser across a burst and dropping the flat post-navigate sleep brings a cold backfill of ten from **~300s to ~9.6s** (~1.5s per capture after a sub-second browser start).

## Chrome discovery

`findChromeBin` (`server/thumbs.ts`) returns `SURFACE_CHROME` if set, otherwise probes `google-chrome-stable`, `google-chrome`, `chromium`, `chromium-browser`, `chrome` (first that answers `--version` with exit 0). The result is cached for the process. If none is found, boot logs a warning and the system degrades to SVG placeholders (`server/index.ts`, `server/thumbs.ts`).

## The browser (`launchBrowser` / `acquireBrowser`, `server/thumbs.ts`)

Started once, on the first capture of a burst:

1. Spawn Chrome headless with `--remote-debugging-port=0` against `about:blank` and a `--user-data-dir` that lives for the browser's lifetime (so the shader cache survives between captures). Flags include `--headless=new`, `--no-sandbox`, `--disable-dev-shm-usage`, and a long list of network/feature disables.
2. **WebGL via SwiftShader:** `--use-gl=angle`, `--use-angle=swiftshader`, `--enable-unsafe-swiftshader` so canvas/WebGL demos render without a GPU.
3. Parse `DevTools listening on (ws://…)` from Chrome's stderr, then open that WebSocket. One `CdpConnection` multiplexes every capture: replies are matched by request id, and events by `"<sessionId>:<method>"` so a load event only wakes its own tab.

Chrome shuts down after **20s idle** (`SURFACE_THUMB_IDLE_MS`) and on `exit`/`SIGINT`/`SIGTERM`, so a headless browser never outlives the server. If it dies underneath us the cached handle is invalidated, and a launch failure backs off for 60s rather than retrying on every card the dashboard renders.

## Capture flow (`capture`, `server/thumbs.ts`)

1. `Target.createBrowserContext` — a throwaway context per capture. This is the isolation the per-capture profile dir used to buy: separate cookies, storage and cache, so concurrent captures cannot observe each other and untrusted content leaves nothing behind.
2. `Target.createTarget` (600×600) in that context → `Target.attachToTarget` (`flatten:true`) for a session.
3. `Emulation.setDeviceMetricsOverride` to 600×600, `deviceScaleFactor:1`, `mobile:false`.
4. For device-authored artifacts, `Emulation.setScriptExecutionDisabled` **before** navigating (see the trust note below).
5. `Page.navigate` to `http://127.0.0.1:<port>/artifacts/<id>/view?preview=1` — the chromeless preview shell.
6. Wait for the real signals: `Page.loadEventFired`, then `document.fonts.ready` plus two `requestAnimationFrame`s, then a short settle (`SURFACE_THUMB_SETTLE_MS`, default 2000ms) for animation and streaming tails.
7. `Page.captureScreenshot` (`png`, clip 0,0,600,600) → decode base64 → write to `<id>.png.<pid>.tmp` → `rename`. Writing through a temp file means a reader can never catch a half-written PNG, which the grid would cache as a broken image.
8. Close the target and dispose the browser context.

A per-job **30s timeout** (`SURFACE_THUMB_TIMEOUT_MS`) guards each capture; the target and context are always torn down.

## Queue and worker pool (`server/thumbs.ts`)

`enqueueThumb(id)` is a no-op until the server port is set (`setThumbServerPort`, called on listen). It dedupes by id, then `drain()` acquires the browser and runs **3 workers** (`SURFACE_THUMB_CONCURRENCY`) that pull from the shared queue until it is empty — work pushed mid-drain is picked up by whichever worker frees up next, so a burst never serializes. Each route that changes an artifact's content calls `enqueueThumb` (create/update/touch/rollback/present/link). On each success the queue broadcasts a `thumb_ready` event (see [events.md](events.md)) and logs the capture duration.

### Tuning

| Env | Default | What it does |
|---|---|---|
| `SURFACE_THUMB_SETTLE_MS` | `2000` | Pause after load/fonts/frames before the shot. Raise it for surfaces that animate or stream for a while. |
| `SURFACE_THUMB_CONCURRENCY` | `3` | Captures in flight (clamped 1–6). |
| `SURFACE_THUMB_TIMEOUT_MS` | `30000` | Per-capture deadline. |
| `SURFACE_THUMB_IDLE_MS` | `20000` | How long Chrome stays warm after the queue empties. |

## Cache & serving (`/artifacts/:id/thumb`, `server/routes/artifacts.ts`)

- PNGs are cached at `~/.surface/thumbs/<id>.png` (`getThumbPath`, `server/thumbs.ts`).
- The route serves, in order: the cached PNG if it exists; for image-mime artifacts, the image bytes themselves (passthrough); otherwise the SVG cover, while enqueueing a real capture.
- **The cover** (`renderThumbPlaceholder`, `server/render.ts`) is what a surface wears until a capture exists, so it is a designed object rather than a file-extension chip: a tinted field whose hue is FNV-1a of the surface id, the kind as a quiet mono caption, and the title wrapped to at most three lines at 45px. It is **top-anchored**, because the grid crops the 600×600 image to 16:10 from the top edge and anything below ~375px is simply not on the card. Gradient ids are namespaced per surface so two covers inlined into one document don't share the first one's colour.
- **`has_thumb`** on `GET /artifacts` (`hasRealThumb`, `server/routes/artifacts.ts`) says whether this route would answer with a real picture — a cached capture, or an image it can pass through. The dashboard uses it to paint its own equivalent cover client-side rather than fetching an SVG it would discard seconds later (see [pwa.md](../display/pwa.md)).
- `?regenerate=1` deletes the cached PNG, enqueues a fresh capture, and returns the cover immediately with `Cache-Control: no-store`.
- **Cache busting:** the PWA requests `/artifacts/<id>/thumb?v=<updated_at>` so a new version refetches; on a `thumb_ready` event it swaps in `?v=Date.now()` (`client/app.js`). The `v` param is a cache key the route does not otherwise read.
- **Caching:** a cached capture requested *with* a `v` is immutable for that version — `public, max-age=31536000, immutable`. Everything else (covers, image passthrough, unversioned requests) gets `public, max-age=30, stale-while-revalidate=300`, because a cover is replaced the moment a capture lands.

## Preview shell

The capture loads `/artifacts/:id/view?preview=1`, whose shell (`renderArtifactShell`, `server/render.ts`) is tuned for the thumbnail: images fill the square (`object-fit: cover`) instead of letterboxing into a black box, and plain-text surfaces are set at 20px because body copy at card scale is a grey smudge. The shell loads **no web font** — a surface has to render identically offline and inside the thumbnailer, which has no network.

## Boot backfill (`server/index.ts`)

After the server starts, if Chrome is available, it scans all surface cards (including hidden) and enqueues a capture for every one that lacks a cached PNG, logging the queued count. With no Chrome, it skips and warns.

## Deletion lifecycle

When an artifact is deleted, the route removes `~/.surface/thumbs/<id>.png` (`fs.rmSync(getThumbPath(id), {force:true})`, `server/routes/artifacts.ts`).

## Related
- [events.md](events.md) — the `thumb_ready` event
- [http-api.md](http-api.md) — the `/artifacts/:id/thumb` and `/artifacts/:id/view` routes
- [artifacts.md](artifacts.md) — the `thumbs/` cache dir under `~/.surface/`
- [../display/pwa.md](../display/pwa.md) — how the grid consumes thumbnails
- [../operations/install.md](../operations/install.md) — installing Chrome / `SURFACE_CHROME`
