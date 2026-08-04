import crypto from "crypto";
import fs from "fs";
import path from "path";
import { spawn, spawnSync, ChildProcess } from "child_process";
import { getDataDir } from "./paths.js";
import { broadcastGlobal } from "./sse.js";
import { getDb } from "./db.js";
import { artifactAuthorPlane, assertSafeArtifactId, getArtifact, imageThumbPassthrough } from "./artifacts.js";

const THUMB_WIDTH = 600;
const THUMB_HEIGHT = 600;

// How long to let a page settle after its load event before the shot. The old
// pipeline waited a flat 6.5s with no readiness signal at all; we now wait for
// load + fonts + two frames first, so this is only the animation/data tail.
const SETTLE_MS = envInt("SURFACE_THUMB_SETTLE_MS", 2000);
// Captures that run at once. Each gets its own browser context, so they stay
// isolated from one another the way separate Chrome processes used to be.
const CONCURRENCY = Math.max(1, Math.min(6, envInt("SURFACE_THUMB_CONCURRENCY", 3)));
const JOB_TIMEOUT_MS = envInt("SURFACE_THUMB_TIMEOUT_MS", 30_000);
const LAUNCH_TIMEOUT_MS = 60_000;
// Chrome is expensive to start (25s+ with the software GL stack on a cold
// machine) and cheap to keep. Hold it open across a burst of captures, then let
// it go when the queue has been quiet.
const IDLE_SHUTDOWN_MS = envInt("SURFACE_THUMB_IDLE_MS", 20_000);
// A launch that fails backs off rather than retrying on every card the grid
// renders — but the queued work is kept and re-drained when the backoff expires.
const LAUNCH_BACKOFF_MS = envInt("SURFACE_THUMB_LAUNCH_BACKOFF_MS", 60_000);
// Chrome died mid-burst. Give it a breath before relaunching, and give up for a
// full backoff if it keeps dying without producing a single capture.
const CRASH_RETRY_MS = envInt("SURFACE_THUMB_CRASH_RETRY_MS", 1_000);
const MAX_CONSECUTIVE_CRASHES = 3;
// Tearing a target/context down must not depend on a healthy socket, so cleanup
// carries its own (short) deadline instead of inheriting the job's.
const CLEANUP_TIMEOUT_MS = envInt("SURFACE_THUMB_CLEANUP_MS", 5_000);
// Upper bound on shutdownThumbnails(): the graceful-shutdown sequence in
// server/index.ts awaits it, so it must always finish.
const SHUTDOWN_TIMEOUT_MS = envInt("SURFACE_THUMB_SHUTDOWN_MS", 5_000);

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

let chromeBinCache: string | null | undefined;
let serverPort = 0;

export function setThumbServerPort(port: number) {
  serverPort = port;
  sweepStaleChromeDirs();
}

// Headless-Chrome scratch dirs (`.chrome-*` user-data-dirs) can leak when a
// capture is killed before cleanup finishes — a SIGKILL on timeout, or a hard
// process/host crash. At boot no capture is in flight, so every leftover
// `.chrome-*` under the data dir is stale and safe to delete. This makes the
// leak self-healing across restarts rather than letting dirs accumulate.
function sweepStaleChromeDirs() {
  let entries: string[];
  try { entries = fs.readdirSync(getDataDir()); } catch { return; }
  let removed = 0;
  for (const name of entries) {
    if (!name.startsWith(".chrome-")) continue;
    try {
      fs.rmSync(path.join(getDataDir(), name), { recursive: true, force: true, maxRetries: 3 });
      removed++;
    } catch {}
  }
  if (removed) console.log(`[thumbs] swept ${removed} stale chrome scratch dir(s)`);
}

function thumbsDir(): string {
  const dir = path.join(getDataDir(), "thumbs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Generations ──
//
// A cached capture is a picture of one *revision* of a surface. Keying the file
// on the id alone made `<id>.png` a mutable location behind an immutable URL:
// a request carrying the new `?v=` right after an update found the previous
// revision's bytes still on disk and pinned them under the new key for a year.
// It also let two concurrent captures of different revisions race for the same
// destination, so an older shot could land last and win.
//
// The generation is that revision's identity: the current version row, the
// artifact's `updated_at` (which also moves for a touch or a metadata edit,
// both of which change the picture) and `content_rev`. It is carried by the
// job, baked into the filename, and re-checked immediately before the bytes
// are written.
//
// `content_rev` is what makes the identity actually unique. `updated_at` is
// SQLite's one-second clock and a *linked* artifact's touch moves nothing else
// — `surface link` + `surface touch` is the documented hot-reload loop, so two
// touches inside one second is ordinary. With only the version row and the
// second, both touches hashed the same: an in-flight capture of the first edit
// passed the "is my generation still current?" check taken after the second and
// was written as the current thumbnail, and the second enqueue was deduplicated
// against it. Nothing ever corrected the picture. The counter is bumped by
// every write that declares the content changed, and never reset.

const GENERATION_RE = /^[0-9a-f]{16}$/;

export function thumbGenerationFor(
  artifact:
    | { current_version_id?: string | null; updated_at?: string | null; content_rev?: number | null }
    | null
    | undefined,
): string | null {
  if (!artifact) return null;
  return crypto
    .createHash("sha1")
    .update(`${artifact.current_version_id || ""}\0${artifact.updated_at || ""}\0${artifact.content_rev ?? ""}`)
    .digest("hex")
    .slice(0, 16);
}

export function currentThumbGeneration(id: string): string | null {
  try {
    return thumbGenerationFor(getArtifact(getDb(), id));
  } catch {
    return null;
  }
}

export function getThumbPath(id: string, generation: string): string {
  // Defensive last line: ids are validated at creation (assertSafeArtifactId),
  // but never trust an id flowing into a filesystem path. Reject anything that
  // could escape thumbsDir(). Generations are ours, but they land in the same
  // path, so they are validated on the same terms.
  assertSafeArtifactId(id);
  if (typeof generation !== "string" || !GENERATION_RE.test(generation)) {
    throw new Error(`Invalid thumbnail generation: ${generation}`);
  }
  return path.join(thumbsDir(), `${id}.${generation}.png`);
}

// True when the capture for exactly this revision is already on disk. Anything
// else — an older generation, or a pre-generation `<id>.png` left by an earlier
// release — is a picture of a surface that has since changed.
export function hasThumb(id: string, generation: string | null): boolean {
  if (!generation) return false;
  try { return fs.existsSync(getThumbPath(id, generation)); } catch { return false; }
}

// Every cached capture for a surface, newest first. `<id>.png` (no generation)
// is what releases before this wrote; it is served as a best-effort stale
// picture and pruned once a real generation lands.
function thumbFilesFor(id: string): string[] {
  assertSafeArtifactId(id);
  const dir = thumbsDir();
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  // Artifact ids are `[A-Za-z0-9_-]+` (no dots), so `<id>.` cannot be the
  // prefix of another surface's file.
  const prefix = `${id}.`;
  const matched = names.filter((n) => n.endsWith(".png") && (n === `${id}.png` || n.startsWith(prefix)));
  return matched
    .map((name) => {
      const full = path.join(dir, name);
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch { return null; }
      return { full, mtime };
    })
    .filter((v): v is { full: string; mtime: number } => v !== null)
    .sort((a, b) => b.mtime - a.mtime)
    .map((v) => v.full);
}

// What `/artifacts/:id/thumb` should send. `exact` says the bytes are the
// requested revision — the only case where an immutable response is honest.
export function resolveThumbFile(
  id: string,
  generation: string | null,
): { path: string; exact: boolean } | null {
  if (generation) {
    try {
      const exact = getThumbPath(id, generation);
      if (fs.existsSync(exact)) return { path: exact, exact: true };
    } catch { return null; }
  }
  try {
    const stale = thumbFilesFor(id)[0];
    return stale ? { path: stale, exact: false } : null;
  } catch { return null; }
}

// Does the route have *a* real picture to serve (any revision)? The grid uses
// this to decide between fetching the route and painting its own cover.
// The generation is optional but worth passing: the card list asks this once
// per surface, and in the steady state every card hits its exact generation
// with a single stat instead of listing the whole thumbs directory.
export function hasAnyThumb(id: string, generation?: string | null): boolean {
  if (generation && hasThumb(id, generation)) return true;
  try { return thumbFilesFor(id).length > 0; } catch { return false; }
}

// A capture for the current revision is missing — used by the boot backfill.
export function needsThumbCapture(id: string): boolean {
  const generation = currentThumbGeneration(id);
  if (!generation) return false;
  return !hasThumb(id, generation);
}

export function removeThumbs(id: string): void {
  let files: string[] = [];
  try { files = thumbFilesFor(id); } catch { return; }
  for (const file of files) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
}

function pruneSupersededThumbs(id: string, keep: string): void {
  const keepPath = getThumbPath(id, keep);
  let files: string[] = [];
  try { files = thumbFilesFor(id); } catch { return; }
  for (const file of files) {
    if (file === keepPath) continue;
    try { fs.rmSync(file, { force: true }); } catch {}
  }
}

export function findChromeBin(): string | null {
  if (chromeBinCache !== undefined) return chromeBinCache;
  const explicit = process.env.SURFACE_CHROME;
  if (explicit) {
    chromeBinCache = explicit;
    return chromeBinCache;
  }
  const candidates = [
    "google-chrome-stable",
    "google-chrome",
    "chromium",
    "chromium-browser",
    "chrome",
  ];
  for (const name of candidates) {
    try {
      const out = spawnSync(name, ["--version"], { stdio: "ignore" });
      if (out.status === 0) {
        chromeBinCache = name;
        return chromeBinCache;
      }
    } catch {}
  }
  chromeBinCache = null;
  return null;
}

// ── Queue ──

interface Job {
  id: string;
  generation: string;
}

// One drain's worker pool. `aborted` is how a dead browser stops three workers
// that would otherwise keep handing jobs to a closed socket and burning them.
interface Pool {
  aborted: boolean;
}

const queue: Job[] = [];
const inFlight = new Set<string>();
const jobKey = (job: Job) => `${job.id}\0${job.generation}`;

let running = false;
let stopped = false;
let activePool: Pool | null = null;
let launchBlockedUntil = 0;
let retryTimer: NodeJS.Timeout | null = null;
let consecutiveCrashes = 0;
// Observable for tests: how many times a drain has tried to get a browser.
let launchAttempts = 0;

// Observable queue state. Exported so the pipeline's recovery behaviour (work
// survives a failed launch, a revision supersedes its predecessor) can be
// asserted without a browser.
export function thumbQueueStats(): {
  queued: number;
  inFlight: number;
  launchAttempts: number;
  running: boolean;
  jobs: Array<{ id: string; generation: string }>;
} {
  return {
    queued: queue.length,
    inFlight: inFlight.size,
    launchAttempts,
    running,
    jobs: queue.map((job) => ({ ...job })),
  };
}

export function enqueueThumb(id: string) {
  if (!serverPort || stopped) return;
  // An image surface serves itself as its own thumbnail (the thumb route
  // prefers the bytes over a capture), so screenshotting it is wasted browser
  // time — and a worse picture besides.
  try {
    if (imageThumbPassthrough(getDb(), id)) return;
  } catch {}
  const generation = currentThumbGeneration(id);
  if (!generation) return; // artifact is gone: nothing to photograph
  const job: Job = { id, generation };
  const key = jobKey(job);
  // Dedupe against both the queue and the captures already in flight, so a
  // burst of updates cannot put three workers on one surface.
  if (inFlight.has(key)) return;
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].id !== id) continue;
    if (queue[i].generation === generation) return;
    // Same surface, older revision: superseded. Its capture would be discarded
    // as stale anyway, so don't spend a worker on it.
    queue.splice(i, 1);
  }
  queue.push(job);
  scheduleDrain();
}

function scheduleDrain(delayMs = 0): void {
  if (stopped) return;
  if (delayMs <= 0) {
    setImmediate(() => { void drain(); });
    return;
  }
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void drain();
  }, delayMs);
  retryTimer.unref?.();
}

function cancelRetry(): void {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
}

async function drain() {
  if (running || stopped) return;
  if (!queue.length) return;
  if (!findChromeBin()) {
    console.warn(
      "[thumbs] no chrome binary found; falling back to SVG placeholders. Set SURFACE_CHROME to override.",
    );
    queue.length = 0;
    return;
  }
  const backoffLeft = launchBlockedUntil - Date.now();
  if (backoffLeft > 0) {
    // Do NOT drop the work. Redesigned cards with `has_thumb: false` paint their
    // own cover and deliberately never request the thumb route, so a discarded
    // backfill job is never naturally re-enqueued — the surface would wear its
    // cover until something else happened to update it. Hold the queue and come
    // back when the backoff expires.
    scheduleDrain(backoffLeft + 50);
    return;
  }
  running = true;
  cancelIdleShutdown();
  const pool: Pool = { aborted: false };
  activePool = pool;
  let captured = 0;
  try {
    let browser: Browser;
    launchAttempts++;
    try {
      browser = await acquireBrowser();
      launchBlockedUntil = 0;
    } catch (err: any) {
      // A misconfigured SURFACE_CHROME would otherwise retry on every card the
      // dashboard renders. Back off and let the covers do their job — then try
      // again, because nothing else will re-enqueue this work.
      launchBlockedUntil = Date.now() + LAUNCH_BACKOFF_MS;
      console.error(
        `[thumbs] could not start chrome (${err?.message || err}); using covers for the next ${Math.round(LAUNCH_BACKOFF_MS / 1000)}s`,
      );
      scheduleDrain(LAUNCH_BACKOFF_MS + 50);
      return;
    }
    // A fixed pool drains the queue; new work pushed mid-drain is picked up by
    // whichever worker frees up next, so a burst never serializes.
    const workers: Promise<void>[] = [];
    for (let i = 0; i < CONCURRENCY; i++) {
      workers.push((async () => {
        while (queue.length && !pool.aborted && !stopped) {
          const job = queue.shift()!;
          const key = jobKey(job);
          inFlight.add(key);
          const started = Date.now();
          try {
            const wrote = await capture(browser, job);
            if (wrote) {
              captured++;
              console.log(`[thumbs] captured ${job.id} in ${Date.now() - started}ms`);
              broadcastGlobal("thumb_ready", { id: job.id });
            }
          } catch (err: any) {
            console.error(`[thumbs] capture failed for ${job.id}:`, err?.message || err);
            // The browser went away underneath this job — it never got its
            // chance. Put it back rather than leaving the surface on its cover.
            if (pool.aborted || browser.cdp.unhealthy) queue.push(job);
          } finally {
            inFlight.delete(key);
          }
          // A browser that stopped answering browser-level commands is not
          // going to answer the next job either. Recycle it; the pool stops and
          // the surviving queue is re-drained against a fresh Chrome.
          if (browser.cdp.unhealthy && !pool.aborted) {
            pool.aborted = true;
            console.error("[thumbs] chrome stopped answering; recycling the browser");
            void shutdownBrowser();
          }
        }
      })());
    }
    await Promise.all(workers);
    if (captured) consecutiveCrashes = 0;
  } finally {
    if (activePool === pool) activePool = null;
    running = false;
    scheduleIdleShutdown();
    if (stopped) {
      queue.length = 0; // shutdownThumbnails owns the teardown from here
    } else if (pool.aborted) {
      if (!captured) consecutiveCrashes++;
      if (consecutiveCrashes >= MAX_CONSECUTIVE_CRASHES) {
        consecutiveCrashes = 0;
        launchBlockedUntil = Date.now() + LAUNCH_BACKOFF_MS;
        console.error(
          `[thumbs] chrome died ${MAX_CONSECUTIVE_CRASHES}x without a capture; pausing for ${Math.round(LAUNCH_BACKOFF_MS / 1000)}s`,
        );
        if (queue.length) scheduleDrain(LAUNCH_BACKOFF_MS + 50);
      } else if (queue.length) {
        scheduleDrain(CRASH_RETRY_MS);
      }
    } else if (queue.length) {
      // Work that arrived while we were tearing down the pool.
      scheduleDrain();
    }
  }
}

// ── Persistent browser ──

interface ChromeProcess {
  child: ChildProcess;
  tmpDir: string;
  disposed: boolean;
}

interface Browser {
  proc: ChromeProcess;
  cdp: CdpConnection;
}

let browserPromise: Promise<Browser> | null = null;
let idleTimer: NodeJS.Timeout | null = null;
// Tracked separately from the promise so the exit backstop can kill Chrome
// synchronously — an orphaned headless browser outliving the server is exactly
// the leak `scripts/check-leaks.sh` exists to catch.
let liveChrome: ChromeProcess | null = null;
let exitBackstopInstalled = false;

function removeProfileDir(proc: ChromeProcess): boolean {
  try {
    fs.rmSync(proc.tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    return !fs.existsSync(proc.tmpDir);
  } catch { return false; }
}

// The single teardown path for a Chrome child: kill it, wait for it to actually
// go, then remove its profile dir. Idempotent — concurrent callers share one
// promise — and it ALWAYS removes the dir. The error and early-exit paths used
// to skip that, leaking a `.chrome-*` scratch dir per failed launch, and the
// removal used to be a callback the process did not live long enough to run, so
// an ordinary restart left one behind for the next boot's sweep to find.
const disposals = new WeakMap<ChromeProcess, Promise<void>>();
function disposeChrome(proc: ChromeProcess): Promise<void> {
  const existing = disposals.get(proc);
  if (existing) return existing;
  const done = (async () => {
    proc.disposed = true;
    if (liveChrome === proc) liveChrome = null;
    const neverStarted = !proc.child.pid;
    const alreadyGone = proc.child.exitCode !== null || proc.child.signalCode !== null;
    if (!neverStarted && !alreadyGone) {
      await new Promise<void>((resolve) => {
        let timer: NodeJS.Timeout | undefined;
        const finish = () => { if (timer) clearTimeout(timer); resolve(); };
        proc.child.once("exit", finish);
        timer = setTimeout(finish, 3000);
        try { proc.child.kill("SIGKILL"); } catch { finish(); }
      });
    }
    // Chrome is a tree: its renderer/zygote children go on touching lock files
    // for a moment after the parent dies, so the first rm can lose the race.
    for (let attempt = 0; attempt < 8; attempt++) {
      if (removeProfileDir(proc)) return;
      await sleep(100);
    }
    removeProfileDir(proc);
  })();
  disposals.set(proc, done);
  return done;
}

// Installed the first time Chrome launches. `process.exit()` unwinds without
// running async work, so this synchronous kill is the last line against an
// orphaned browser.
//
// Signals are deliberately NOT handled here. server/index.ts owns SIGINT and
// SIGTERM and calls shutdownThumbnails() inside its bounded graceful sequence;
// a second listener here used to fire in parallel and `process.exit(130/143)`
// before the HTTP close callback and closeDb() had finished, turning every
// ordinary restart into an abrupt, failure-coded shutdown with a possibly
// unclean database close.
export function installChromeExitBackstop(): void {
  if (exitBackstopInstalled) return;
  exitBackstopInstalled = true;
  process.once("exit", () => {
    const proc = liveChrome;
    if (!proc) return;
    try { proc.child.kill("SIGKILL"); } catch {}
    removeProfileDir(proc); // sync: nothing async survives process exit
  });
}

function cancelIdleShutdown() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}

function scheduleIdleShutdown() {
  cancelIdleShutdown();
  if (!browserPromise || stopped) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    // A drain that started between the timer being armed and it firing owns the
    // browser. Re-arm rather than pulling it out from under three workers — and
    // if work is queued but nothing is draining, kick the drain instead of
    // killing the Chrome it is about to ask for.
    if (running || queue.length) {
      if (!running && queue.length) scheduleDrain();
      scheduleIdleShutdown();
      return;
    }
    void shutdownBrowser();
  }, IDLE_SHUTDOWN_MS);
  idleTimer.unref?.();
}

async function acquireBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = launchBrowser().catch((err) => {
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

// Tear down the browser (idle expiry, recycle, or shutdown). Bounded: it never
// waits on the CDP socket, which may be exactly what is wedged.
export async function shutdownBrowser(): Promise<void> {
  cancelIdleShutdown();
  const pending = browserPromise;
  browserPromise = null;
  if (!pending) return;
  let browser: Browser;
  try { browser = await pending; } catch { return; }
  try { browser.cdp.close(); } catch {}
  await disposeChrome(browser.proc);
}

// Stop the thumbnail pipeline for good: no new work, no live Chrome. Idempotent
// and always resolves — server/index.ts awaits it during graceful shutdown, so
// a hung teardown here would hold the whole process open.
export async function shutdownThumbnails(): Promise<void> {
  stopped = true;
  cancelRetry();
  cancelIdleShutdown();
  if (activePool) activePool.aborted = true;
  queue.length = 0;
  let guard: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      shutdownBrowser().catch(() => {}),
      new Promise<void>((resolve) => { guard = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS); guard.unref?.(); }),
    ]);
  } finally {
    if (guard) clearTimeout(guard);
  }
  // Whatever happened above, the child must not outlive us.
  if (liveChrome) await disposeChrome(liveChrome);
}

function launchBrowser(): Promise<Browser> {
  const bin = findChromeBin();
  if (!bin) return Promise.reject(new Error("chrome binary unavailable"));
  const tmpDir = fs.mkdtempSync(path.join(getDataDir(), ".chrome-"));
  const args = [
    "--headless=new",
    "--hide-scrollbars",
    "--mute-audio",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-translate",
    "--disable-extensions",
    "--disable-default-apps",
    "--disable-component-update",
    "--no-pings",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--disable-features=Translate,OptimizationHints",
    `--user-data-dir=${tmpDir}`,
    `--window-size=${THUMB_WIDTH},${THUMB_HEIGHT}`,
    "--remote-debugging-port=0",
    "about:blank",
  ];

  return new Promise<Browser>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    const proc: ChromeProcess = { child, tmpDir, disposed: false };
    let stderrBuf = "";
    let settled = false;
    const started = Date.now();

    // Every failure path routes through here, so the profile dir is removed
    // exactly once no matter how the launch died.
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void disposeChrome(proc);
      reject(err);
    };

    const timer = setTimeout(() => fail(new Error("chrome launch timeout")), LAUNCH_TIMEOUT_MS);

    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", async (chunk: string) => {
      if (settled) return;
      stderrBuf += chunk;
      const m = stderrBuf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (!m) return;
      settled = true;
      clearTimeout(timer);
      try {
        const cdp = await connectCdp(m[1]);
        console.log(`[thumbs] chrome ready in ${Date.now() - started}ms`);
        liveChrome = proc;
        installChromeExitBackstop();
        // Chrome dying underneath us must invalidate the cached handle, or every
        // later capture talks to a closed socket forever — and it must stop the
        // worker pool, which would otherwise fail and discard every job left.
        child.once("exit", () => {
          browserPromise = null;
          if (activePool) activePool.aborted = true;
          void disposeChrome(proc);
        });
        resolve({ proc, cdp });
      } catch (err: any) {
        settled = false; // let fail() run its teardown
        fail(err instanceof Error ? err : new Error(String(err)));
      }
    });

    child.on("error", (err) => fail(err));
    child.on("exit", (code) => fail(new Error(`chrome exited before DevTools ready (code=${code})`)));
  });
}

// ── Capture ──

// Returns true when a PNG was written, false when the capture was discarded
// because the surface moved on while we were photographing it.
async function capture(browser: Browser, job: Job): Promise<boolean> {
  const dest = getThumbPath(job.id, job.generation);
  const url = `http://127.0.0.1:${serverPort}/artifacts/${encodeURIComponent(job.id)}/view?preview=1`;

  // The thumbnailer loads the artifact over loopback, which the server trusts as
  // `system`. Device-authored HTML must therefore render with JavaScript OFF —
  // otherwise its inline script could call system-only endpoints (mint tokens,
  // read files) from inside this privileged context. Agent (system) content is
  // trusted and keeps JS so dynamic surfaces thumbnail correctly.
  const allowScripts = artifactAuthorPlane(getArtifact(getDb(), job.id)) === "system";

  const cdp = browser.cdp;
  // Every CDP round-trip is bounded by what is left of the job's budget, so no
  // single command — and no `Promise.race` that "times out" while the underlying
  // request keeps waiting — can hold a worker past the deadline.
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  const left = () => Math.max(1, deadline - Date.now());

  let browserContextId: string | undefined;
  let targetId: string | undefined;
  let wrote = false;

  try {
    await withTimeout(JOB_TIMEOUT_MS + 1_000, `capture timeout for ${job.id}`, async () => {
      // One throwaway browser context per capture: separate cookies, storage and
      // cache, so concurrent captures cannot observe each other and untrusted
      // content leaves nothing behind. This is what the per-capture
      // user-data-dir used to buy, at a fraction of the cost. It runs INSIDE the
      // deadline — it used to run before it, unbounded.
      const context = await cdp.send("Target.createBrowserContext", { disposeOnDetach: true }, undefined, left());
      browserContextId = context.browserContextId;

      const created = await cdp.send("Target.createTarget", {
        url: "about:blank",
        browserContextId,
        width: THUMB_WIDTH,
        height: THUMB_HEIGHT,
      }, undefined, left());
      targetId = created.targetId;
      const attached = await cdp.send("Target.attachToTarget", { targetId, flatten: true }, undefined, left());
      const sessionId: string = attached.sessionId;
      const session = (method: string, params?: any) => cdp.send(method, params, sessionId, left());

      await session("Page.enable");
      await session("Emulation.setDeviceMetricsOverride", {
        width: THUMB_WIDTH,
        height: THUMB_HEIGHT,
        deviceScaleFactor: 1,
        mobile: false,
      });
      if (!allowScripts) {
        // Untrusted (device-authored) content: render statically, never run its JS.
        await session("Emulation.setScriptExecutionDisabled", { value: true });
      }

      const loaded = cdp.once("Page.loadEventFired", sessionId, left());
      await session("Page.navigate", { url });
      await loaded;

      // Fonts and two painted frames — the difference between a shot of the
      // finished surface and a shot of it mid-layout.
      if (allowScripts) {
        await session("Runtime.evaluate", {
          expression:
            "new Promise(r => { const go = () => requestAnimationFrame(() => requestAnimationFrame(r));" +
            " (document.fonts ? document.fonts.ready.then(go, go) : go()); })",
          awaitPromise: true,
        }).catch(() => {});
      }
      if (SETTLE_MS > 0) await sleep(Math.min(SETTLE_MS, left()));

      const result = await session("Page.captureScreenshot", {
        format: "png",
        clip: { x: 0, y: 0, width: THUMB_WIDTH, height: THUMB_HEIGHT, scale: 1 },
        captureBeyondViewport: false,
      });

      // The surface may have been republished while this shot was developing.
      // Writing now would pin a picture of the old revision under the new
      // revision's filename — exactly the mislabelling the generation exists to
      // prevent. The newer job is already queued, so drop this one.
      if (currentThumbGeneration(job.id) !== job.generation) return;

      // Write through a temp file: a reader that catches a half-written PNG gets
      // a broken image, and the grid caches broken images hard. The temp name is
      // unique per capture — a shared `<dest>.<pid>.tmp` let two concurrent
      // captures write the same file, and let one job's rename fail because the
      // other had already consumed it.
      const tmpPath = `${dest}.${process.pid}.${nextTmpSeq()}.tmp`;
      try {
        fs.writeFileSync(tmpPath, Buffer.from(result.data, "base64"));
        fs.renameSync(tmpPath, dest);
      } catch (err) {
        try { fs.rmSync(tmpPath, { force: true }); } catch {}
        throw err;
      }
      wrote = true;
      pruneSupersededThumbs(job.id, job.generation);
    });
  } finally {
    // Cleanup carries its own short deadline. It used to `await` the same
    // `cdp.send()` the job had just timed out on, so a wedged socket held the
    // worker forever after the timeout had supposedly fired.
    if (targetId) {
      await cdp.send("Target.closeTarget", { targetId }, undefined, CLEANUP_TIMEOUT_MS).catch(() => {});
    }
    if (browserContextId) {
      await cdp.send("Target.disposeBrowserContext", { browserContextId }, undefined, CLEANUP_TIMEOUT_MS).catch(() => {});
    }
  }
  return wrote;
}

let tmpSeq = 0;
const nextTmpSeq = () => `${Date.now().toString(36)}${(tmpSeq++).toString(36)}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withTimeout<T>(ms: number, message: string, fn: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── CDP connection ──

interface CdpMessage {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: { message: string };
  sessionId?: string;
}

// Minimal shape of the WebSocket we drive, so the protocol layer can be tested
// against a stub socket without a browser.
export interface CdpSocket {
  addEventListener(type: string, listener: (ev: any) => void): void;
  send(data: string): void;
  close(): void;
}

export interface CdpConnection {
  send(method: string, params?: any, sessionId?: string, timeoutMs?: number): Promise<any>;
  once(method: string, sessionId: string, timeoutMs: number): Promise<any>;
  close(): void;
  // Set when a *browser-level* command missed its deadline. A page can wedge
  // (that is the page's problem, and closing its target fixes it); the browser
  // failing to answer means this Chrome is finished.
  readonly unhealthy: boolean;
}

const DEFAULT_CDP_TIMEOUT_MS = envInt("SURFACE_THUMB_CDP_TIMEOUT_MS", 30_000);

export function attachCdp(ws: CdpSocket): CdpConnection {
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  // Event waiters keyed by "<sessionId>:<method>" — several captures share
  // this socket, so a load event must only wake its own tab.
  const waiters = new Map<string, Array<{ resolve: (p: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>>();
  let closed = false;
  let unhealthy = false;

  const failAll = (err: Error) => {
    closed = true;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(err); }
    pending.clear();
    for (const list of waiters.values()) {
      for (const w of list) { clearTimeout(w.timer); w.reject(err); }
    }
    waiters.clear();
  };

  ws.addEventListener("message", (ev: any) => {
    let msg: CdpMessage;
    try { msg = JSON.parse(ev.data.toString()); } catch { return; }
    if (msg.id !== undefined) {
      const cb = pending.get(msg.id);
      if (!cb) return;
      pending.delete(msg.id);
      clearTimeout(cb.timer);
      if (msg.error) cb.reject(new Error(msg.error.message));
      else cb.resolve(msg.result);
      return;
    }
    if (!msg.method) return;
    const key = `${msg.sessionId || ""}:${msg.method}`;
    const list = waiters.get(key);
    if (!list || !list.length) return;
    waiters.delete(key);
    for (const w of list) { clearTimeout(w.timer); w.resolve(msg.params); }
  });

  ws.addEventListener("error", () => {
    if (!closed) failAll(new Error("cdp ws error"));
  });
  ws.addEventListener("close", () => {
    if (!closed) failAll(new Error("cdp ws closed"));
  });

  return {
    get unhealthy() { return unhealthy; },
    send(method, params, sessionId, timeoutMs) {
      if (closed) return Promise.reject(new Error("cdp connection closed"));
      const budget = Math.max(1, timeoutMs ?? DEFAULT_CDP_TIMEOUT_MS);
      return new Promise((res, rej) => {
        const id = nextId++;
        // Every request carries a deadline AND a cancellation path: on expiry it
        // rejects *and* drops itself from `pending`, so a late reply is ignored
        // and nothing is left waiting on a socket that may never answer again.
        const timer = setTimeout(() => {
          pending.delete(id);
          if (!sessionId) unhealthy = true;
          rej(new Error(`cdp timeout after ${budget}ms: ${method}`));
        }, budget);
        pending.set(id, { resolve: res, reject: rej, timer });
        try {
          ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
        } catch (err: any) {
          pending.delete(id);
          clearTimeout(timer);
          rej(err);
        }
      });
    },
    once(method, sessionId, timeoutMs) {
      if (closed) return Promise.reject(new Error("cdp connection closed"));
      const budget = Math.max(1, timeoutMs);
      return new Promise((res, rej) => {
        const key = `${sessionId}:${method}`;
        const timer = setTimeout(() => {
          const current = waiters.get(key);
          if (current) {
            const rest = current.filter((w) => w !== entry);
            if (rest.length) waiters.set(key, rest);
            else waiters.delete(key);
          }
          rej(new Error(`cdp event timeout after ${budget}ms: ${method}`));
        }, budget);
        const entry = { resolve: res, reject: rej, timer };
        const list = waiters.get(key) || [];
        list.push(entry);
        waiters.set(key, list);
      });
    },
    close() {
      if (!closed) failAll(new Error("cdp connection closed"));
      try { ws.close(); } catch {}
    },
  };
}

function connectCdp(browserWsUrl: string): Promise<CdpConnection> {
  return new Promise((resolve, reject) => {
    // @ts-ignore — WebSocket is globally available in Node 22+
    const ws: any = new WebSocket(browserWsUrl);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Close the socket we opened; a rejected connect used to leave it dangling.
      try { ws.close(); } catch {}
      reject(new Error("cdp connect timeout"));
    }, 15_000);
    ws.addEventListener("open", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(attachCdp(ws as CdpSocket));
    });
    ws.addEventListener("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      reject(new Error("cdp ws error"));
    });
  });
}
