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

Chrome shuts down after **20s idle** (`SURFACE_THUMB_IDLE_MS`), when it stops answering, and during the server's graceful shutdown — so a headless browser never outlives the server.

### Shutdown ownership

`server/index.ts` owns `SIGINT`/`SIGTERM` and nothing else may. Its `shutdown()` calls `shutdownThumbnails()` (idempotent, self-bounding at `SURFACE_THUMB_SHUTDOWN_MS`) alongside the HTTP close, and only then closes the database. `server/thumbs.ts` installs **no** signal handler and never calls `process.exit()`; it keeps a single synchronous `process.on("exit")` backstop that SIGKILLs a live Chrome, because `process.exit()` unwinds without running async work.

> Why this matters: the thumbnailer used to install its own `SIGINT`/`SIGTERM` handlers the moment Chrome launched. Both listeners fired on an ordinary restart, and the thumbs one called `process.exit(130/143)` before the async HTTP close callback and `closeDb()` had finished — an abrupt, failure-coded shutdown with a possibly unclean database close, every time Chrome happened to be warm.

### Failure recovery

- **Launch failure** backs off for 60s (`SURFACE_THUMB_LAUNCH_BACKOFF_MS`) rather than retrying on every card the dashboard renders — but the queue is **kept**, and a `drain()` is scheduled at backoff expiry. Discarding it was not survivable: a card with `has_thumb: false` paints its own cover and deliberately never requests the thumb route, so a dropped boot-backfill job is never naturally re-enqueued.
- **Chrome dying mid-burst** invalidates the cached handle, aborts the worker pool (three workers otherwise keep handing jobs to a closed socket and burning them), requeues the interrupted job, and re-drains after `SURFACE_THUMB_CRASH_RETRY_MS`. Three crashes without a single capture pauses for a full backoff.
- **A capture that throws** goes back in the queue with a bounded budget: `SURFACE_THUMB_MAX_ATTEMPTS` (3) tries per revision, then the job is dropped with one log line (`requeueFailedCapture`). A page-specific failure — a load-event timeout, a page that wedged — deliberately does *not* mark the CDP connection unhealthy, so requeueing only on `pool.aborted || cdp.unhealthy` discarded exactly the failures most likely to be transient, and the same "nothing re-enqueues it" argument above applied. A job the browser never got to run (`browserGone`) does not spend an attempt; that path is bounded by the crash counter and the launch backoff instead.
- **All child teardown** routes through one idempotent finalizer, which always removes the `--user-data-dir`; the error and early-exit paths used to skip it and leak a profile dir per failed launch.

## Capture flow (`capture`, `server/thumbs.ts`)

Everything below runs inside a per-job **30s deadline** (`SURFACE_THUMB_TIMEOUT_MS`), and every CDP round-trip is bounded by what is left of it.

1. `Target.createBrowserContext` — a throwaway context per capture. This is the isolation the per-capture profile dir used to buy: separate cookies, storage and cache, so concurrent captures cannot observe each other and untrusted content leaves nothing behind.
2. `Target.createTarget` (600×600) in that context → `Target.attachToTarget` (`flatten:true`) for a session.
3. `Emulation.setDeviceMetricsOverride` to 600×600, `deviceScaleFactor:1`, `mobile:false`.
4. For device-authored artifacts, `Emulation.setScriptExecutionDisabled` **before** navigating (see the trust note below).
5. `Page.navigate` to `http://127.0.0.1:<port>/artifacts/<id>/view?preview=1` — the chromeless preview shell.
6. Wait for the real signals: `Page.loadEventFired`, then `document.fonts.ready` plus two `requestAnimationFrame`s, then a short settle (`SURFACE_THUMB_SETTLE_MS`, default 2000ms) for animation and streaming tails.
7. `Page.captureScreenshot` (`png`, clip 0,0,600,600) → decode base64 → **re-check the generation** → write to a temp path unique to this capture → `rename` → prune the superseded generations. Writing through a temp file means a reader can never catch a half-written PNG, which the grid would cache as a broken image.
8. Close the target and dispose the browser context, on a short deadline of their own (`SURFACE_THUMB_CLEANUP_MS`) so a wedged socket cannot hold the worker after the job has already failed.

### Deadlines and cancellation

Every `send` and every event waiter on the CDP connection carries a deadline **and** a cancellation path: on expiry it rejects and drops itself from the pending map, so a late reply is ignored rather than resolving a promise nobody holds. A timeout on a **session-level** command means a wedged page — closing its target is enough. A timeout on a **browser-level** command means this Chrome is finished: the connection is marked unhealthy, the pool stops, the browser is recycled, and the surviving queue is re-drained against a fresh one.

> Why: `withTimeout` alone bounded nothing. `Target.createBrowserContext` ran before it, `Promise.race` rejected without cancelling the underlying CDP request, and the `finally` cleanup then awaited that same `cdp.send()`. A live-but-wedged connection held a worker forever, `Promise.all(workers)` never resolved, `running` stayed true, idle shutdown never fired, and the queue was dead until restart.

## Queue and worker pool (`server/thumbs.ts`)

`enqueueThumb(id)` is a no-op until the server port is set (`setThumbServerPort`, called on listen). It stamps the job with the surface's current **generation** (see below), dedupes against both the queue and the captures already **in flight**, and drops a queued job for an older generation of the same surface — its capture would be discarded as stale anyway. `drain()` then acquires the browser and runs **3 workers** (`SURFACE_THUMB_CONCURRENCY`) that pull from the shared queue until it is empty — work pushed mid-drain is picked up by whichever worker frees up next, so a burst never serializes. Each route that changes an artifact's content calls `enqueueThumb` (create/update/touch/rollback/present/link). On each success the queue broadcasts a `thumb_ready` event (see [events.md](events.md)) and logs the capture duration. An **image surface is not queued at all** — the route passes its bytes through — but `enqueueThumb` still broadcasts `thumb_ready` for it, because a card painting its own cover has `has_thumb: false` and never calls the thumb route again: without the event, a surface that *became* a passthrough image kept its cover until a full reload.

### Tuning

| Env | Default | What it does |
|---|---|---|
| `SURFACE_THUMB_SETTLE_MS` | `2000` | Pause after load/fonts/frames before the shot. Raise it for surfaces that animate or stream for a while. |
| `SURFACE_THUMB_CONCURRENCY` | `3` | Captures in flight (clamped 1–6). |
| `SURFACE_THUMB_TIMEOUT_MS` | `30000` | Per-capture deadline. Every CDP round-trip is bounded by what is left of it. |
| `SURFACE_THUMB_CDP_TIMEOUT_MS` | `30000` | Fallback deadline for a CDP command with no explicit budget. |
| `SURFACE_THUMB_CLEANUP_MS` | `5000` | Deadline for closing a target / disposing a context after a job. |
| `SURFACE_THUMB_IDLE_MS` | `20000` | How long Chrome stays warm after the queue empties. |
| `SURFACE_THUMB_LAUNCH_BACKOFF_MS` | `60000` | Pause after a failed launch. The queue is kept and re-drained at expiry. |
| `SURFACE_THUMB_CRASH_RETRY_MS` | `1000` | Pause before relaunching after Chrome dies mid-burst. |
| `SURFACE_THUMB_MAX_ATTEMPTS` | `3` | Failed captures of one revision before the job is dropped. |
| `SURFACE_THUMB_SHUTDOWN_MS` | `5000` | Upper bound on `shutdownThumbnails()`. |

## Cache & serving (`/artifacts/:id/thumb`, `server/routes/artifacts.ts`)

### Generations: one file per revision

A capture is a picture of one **revision** of a surface, and the filename says which: `~/.surface/thumbs/<id>.<generation>.png` (`getThumbPath`, `server/thumbs.ts`). The generation is `sha1(current_version_id + updated_at + content_rev)` truncated to 16 hex chars — `updated_at` is included because a touch or a metadata edit moves it without publishing a version, and both change the picture, and `content_rev` because neither of the other two is enough on its own. A **linked** artifact's touch leaves `current_version_id` alone and moves only `updated_at`, which SQLite writes at one-second resolution: two touches inside one second hashed identically, so an in-flight capture of the first edit passed the re-check taken after the second and was written as the current thumbnail — and the second enqueue was deduplicated against it, so nothing ever corrected it. `content_rev` (`artifacts.content_rev`, migration v15) is bumped by every write that declares the content changed — `touchArtifact`, `updateArtifact`, `setCurrentArtifactVersion` — and never reset. The generation is stamped on the job, baked into the destination, and **re-checked immediately before the bytes are written**, so a capture whose surface was republished while it was developing is discarded rather than filed under the newer revision's name. A successful write prunes the superseded generations for that surface.

> Why: `<id>.png` was a mutable location behind an immutable URL. Right after an update the previous revision's PNG was still the only one on disk, so a request carrying the **new** `?v=` was answered with the **old** image — and told to cache it for a year. The single destination also let two concurrent captures race, and the shared `<dest>.<pid>.tmp` let one job's `rename` fail because the other had already consumed the temp file. Temp paths are now unique per capture.

A pre-generation `<id>.png` left by an earlier release is still shown as a stand-in (so an upgrade doesn't blank the grid) but can never satisfy a versioned request; the capture it triggers replaces it.

- The route serves, in order: **an image artifact's own bytes** (`imageThumbPassthrough`, `server/artifacts.ts`, up to 4 MB); else the cached PNG; else the SVG cover, while enqueueing a real capture. Passthrough comes first because a capture centre-crops the picture into a 600×600 square that the card then crops again to 16:10 — two crops deep, a chart arrives as a zoomed fragment. `enqueueThumb` skips those artifacts entirely, so no browser time is spent on them.
- **The cover** (`renderThumbPlaceholder`, `server/render.ts`) is what a surface wears until a capture exists, so it is a designed object rather than a file-extension chip: a tinted field whose hue is FNV-1a of the surface id, the kind as a quiet mono caption, and the title wrapped to at most three lines at 45px. It is **top-anchored**, because the grid crops the 600×600 image to 16:10 from the top edge and anything below ~375px is simply not on the card. Gradient ids are namespaced per surface so two covers inlined into one document don't share the first one's colour.
- **`has_thumb`** on `GET /artifacts` (`hasRealThumb`, `server/routes/artifacts.ts`) says whether this route would answer with a real picture — a cached capture of *any* generation, or an image it can pass through. The dashboard uses it to paint its own equivalent cover client-side rather than fetching an SVG it would discard seconds later (see [pwa.md](../display/pwa.md)). It deliberately counts an older generation: the card should show the last known picture and let the route enqueue the fresh one, because a `false` here means the card never calls the route at all.
- `?regenerate=1` deletes every cached generation for the surface, enqueues a fresh capture, and returns the cover immediately with `Cache-Control: no-store`.
- **Cache busting:** the PWA requests `/artifacts/<id>/thumb?v=<updated_at>` so a new version refetches; on a `thumb_ready` event it swaps in `?v=Date.now()` (`client/app.js`).
- **Caching.** `immutable` is a promise that a URL will always mean the same bytes for a year, so the route makes it only when all three hold:
  1. the request's `v` **is** the artifact's current `updated_at` (a `?v=<epoch>` buster is not a revision);
  2. the file on disk is that revision's generation — not merely "a file for this id exists";
  3. that key can no longer be reused. `updated_at` is second-resolution, so two updates inside one second share a key; the route waits for the second to close (`VERSION_KEY_SETTLE_MS`, 2s) before pinning it.

  Everything else — covers, image passthrough, unversioned requests, and an older capture standing in while the fresh one is taken — gets `public, max-age=30, stale-while-revalidate=300`.

## Preview shell

The capture loads `/artifacts/:id/view?preview=1`, whose shell (`renderArtifactShell`, `server/render.ts`) is tuned for the thumbnail: images fill the square (`object-fit: cover`) instead of letterboxing into a black box, and plain-text surfaces are set at 20px because body copy at card scale is a grey smudge. The shell loads **no web font** — a surface has to render identically offline and inside the thumbnailer, which has no network.

## Boot backfill (`server/index.ts`)

After the server starts, if Chrome is available, it scans all surface cards (including hidden) and enqueues a capture for every one whose **current generation** has no cached PNG (`needsThumbCapture`), logging the queued count. With no Chrome, it skips and warns.

## Deletion lifecycle

When an artifact is deleted, the route removes **every** cached generation for it (`removeThumbs(id)`, `server/routes/artifacts.ts`).

## Related
- [events.md](events.md) — the `thumb_ready` event
- [http-api.md](http-api.md) — the `/artifacts/:id/thumb` and `/artifacts/:id/view` routes
- [artifacts.md](artifacts.md) — the `thumbs/` cache dir under `~/.surface/`
- [../display/pwa.md](../display/pwa.md) — how the grid consumes thumbnails
- [../operations/install.md](../operations/install.md) — installing Chrome / `SURFACE_CHROME`
