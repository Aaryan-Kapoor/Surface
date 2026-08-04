import fs from "fs";
import path from "path";
import { spawn, spawnSync, ChildProcess } from "child_process";
import { getDataDir } from "./paths.js";
import { broadcastGlobal } from "./sse.js";
import { getDb } from "./db.js";
import { artifactAuthorPlane, assertSafeArtifactId, getArtifact } from "./artifacts.js";

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

export function getThumbPath(id: string): string {
  // Defensive last line: ids are validated at creation (assertSafeArtifactId),
  // but never trust an id flowing into a filesystem path. Reject anything that
  // could escape thumbsDir().
  assertSafeArtifactId(id);
  return path.join(thumbsDir(), `${id}.png`);
}

export function hasThumb(id: string): boolean {
  return fs.existsSync(getThumbPath(id));
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

interface Job {
  id: string;
}

const queue: Job[] = [];
let running = false;
const LAUNCH_BACKOFF_MS = 60_000;
let launchBlockedUntil = 0;

export function enqueueThumb(id: string) {
  if (!serverPort) return;
  if (queue.some((j) => j.id === id)) return;
  queue.push({ id });
  setImmediate(drain);
}

async function drain() {
  if (running) return;
  if (!findChromeBin()) {
    if (queue.length) {
      console.warn(
        "[thumbs] no chrome binary found; falling back to SVG placeholders. Set SURFACE_CHROME to override.",
      );
      queue.length = 0;
    }
    return;
  }
  if (Date.now() < launchBlockedUntil) {
    queue.length = 0;
    return;
  }
  running = true;
  cancelIdleShutdown();
  try {
    let browser: Browser;
    try {
      browser = await acquireBrowser();
      launchBlockedUntil = 0;
    } catch (err: any) {
      // A misconfigured SURFACE_CHROME would otherwise retry on every card the
      // dashboard renders. Back off and let the covers do their job.
      launchBlockedUntil = Date.now() + LAUNCH_BACKOFF_MS;
      console.error(
        `[thumbs] could not start chrome (${err?.message || err}); using covers for the next ${Math.round(LAUNCH_BACKOFF_MS / 1000)}s`,
      );
      queue.length = 0;
      return;
    }
    // A fixed pool drains the queue; new work pushed mid-drain is picked up by
    // whichever worker frees up next, so a burst never serializes.
    const workers: Promise<void>[] = [];
    for (let i = 0; i < CONCURRENCY; i++) {
      workers.push((async () => {
        while (queue.length) {
          const job = queue.shift()!;
          const started = Date.now();
          try {
            await capture(browser, job);
            console.log(`[thumbs] captured ${job.id} in ${Date.now() - started}ms`);
            broadcastGlobal("thumb_ready", { id: job.id });
          } catch (err: any) {
            console.error(`[thumbs] capture failed for ${job.id}:`, err?.message || err);
          }
        }
      })());
    }
    await Promise.all(workers);
  } finally {
    running = false;
    scheduleIdleShutdown();
    // Work that arrived while we were tearing down the pool.
    if (queue.length) setImmediate(drain);
  }
}

// ── Persistent browser ──

interface Browser {
  child: ChildProcess;
  tmpDir: string;
  cdp: CdpConnection;
}

let browserPromise: Promise<Browser> | null = null;
let idleTimer: NodeJS.Timeout | null = null;
// Tracked separately from the promise so the exit hook can kill Chrome
// synchronously — an orphaned headless browser outliving the server is exactly
// the leak `scripts/check-leaks.sh` exists to catch.
let liveChild: ChildProcess | null = null;
let exitHookInstalled = false;

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  const kill = () => { try { liveChild?.kill("SIGKILL"); } catch {} };
  process.once("exit", kill);
  process.once("SIGINT", () => { kill(); process.exit(130); });
  process.once("SIGTERM", () => { kill(); process.exit(143); });
}

function cancelIdleShutdown() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}

function scheduleIdleShutdown() {
  cancelIdleShutdown();
  if (!browserPromise) return;
  idleTimer = setTimeout(() => { void shutdownBrowser(); }, IDLE_SHUTDOWN_MS);
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

export async function shutdownBrowser(): Promise<void> {
  cancelIdleShutdown();
  const pending = browserPromise;
  browserPromise = null;
  if (!pending) return;
  let browser: Browser;
  try { browser = await pending; } catch { return; }
  try { browser.cdp.close(); } catch {}
  const removeDir = () => fs.rm(browser.tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }, () => {});
  try {
    if (browser.child.exitCode === null) {
      browser.child.once("exit", removeDir);
      setTimeout(removeDir, 3000).unref();
      browser.child.kill("SIGKILL");
    } else {
      removeDir();
    }
  } catch {
    removeDir();
  }
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
    let stderrBuf = "";
    let settled = false;
    const started = Date.now();

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch {}
      fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 3 }, () => {});
      reject(new Error("chrome launch timeout"));
    }, LAUNCH_TIMEOUT_MS);

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
        liveChild = child;
        installExitHook();
        // Chrome dying underneath us must invalidate the cached handle, or every
        // later capture talks to a closed socket forever.
        child.once("exit", () => {
          browserPromise = null;
          if (liveChild === child) liveChild = null;
        });
        resolve({ child, tmpDir, cdp });
      } catch (err: any) {
        try { child.kill("SIGKILL"); } catch {}
        fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 3 }, () => {});
        reject(err);
      }
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`chrome exited before DevTools ready (code=${code})`));
    });
  });
}

// ── Capture ──

async function capture(browser: Browser, job: Job): Promise<void> {
  const dest = getThumbPath(job.id);
  const url = `http://127.0.0.1:${serverPort}/artifacts/${encodeURIComponent(job.id)}/view?preview=1`;

  // The thumbnailer loads the artifact over loopback, which the server trusts as
  // `system`. Device-authored HTML must therefore render with JavaScript OFF —
  // otherwise its inline script could call system-only endpoints (mint tokens,
  // read files) from inside this privileged context. Agent (system) content is
  // trusted and keeps JS so dynamic surfaces thumbnail correctly.
  const allowScripts = artifactAuthorPlane(getArtifact(getDb(), job.id)) === "system";

  const cdp = browser.cdp;
  // One throwaway browser context per capture: separate cookies, storage and
  // cache, so concurrent captures cannot observe each other and untrusted
  // content leaves nothing behind. This is what the per-capture user-data-dir
  // used to buy, at a fraction of the cost.
  const { browserContextId } = await cdp.send("Target.createBrowserContext", { disposeOnDetach: true });
  let targetId: string | undefined;
  let sessionId: string | undefined;

  const cleanup = async () => {
    try { if (targetId) await cdp.send("Target.closeTarget", { targetId }); } catch {}
    try { await cdp.send("Target.disposeBrowserContext", { browserContextId }); } catch {}
  };

  try {
    await withTimeout(JOB_TIMEOUT_MS, `capture timeout for ${job.id}`, async () => {
      const created = await cdp.send("Target.createTarget", {
        url: "about:blank",
        browserContextId,
        width: THUMB_WIDTH,
        height: THUMB_HEIGHT,
      });
      targetId = created.targetId;
      const attached = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
      sessionId = attached.sessionId;
      const session = (method: string, params?: any) => cdp.send(method, params, sessionId);

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

      const loaded = cdp.once("Page.loadEventFired", sessionId!);
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
      if (SETTLE_MS > 0) await sleep(SETTLE_MS);

      const result = await session("Page.captureScreenshot", {
        format: "png",
        clip: { x: 0, y: 0, width: THUMB_WIDTH, height: THUMB_HEIGHT, scale: 1 },
        captureBeyondViewport: false,
      });
      // Write through a temp file: a reader that catches a half-written PNG gets
      // a broken image, and the grid caches broken images hard.
      const tmpPath = `${dest}.${process.pid}.tmp`;
      fs.writeFileSync(tmpPath, Buffer.from(result.data, "base64"));
      fs.renameSync(tmpPath, dest);
    });
  } finally {
    await cleanup();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withTimeout<T>(ms: number, message: string, fn: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
        timer.unref?.();
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

interface CdpConnection {
  send(method: string, params?: any, sessionId?: string): Promise<any>;
  once(method: string, sessionId: string): Promise<any>;
  close(): void;
}

function connectCdp(browserWsUrl: string): Promise<CdpConnection> {
  return new Promise((resolve, reject) => {
    // @ts-ignore — WebSocket is globally available in Node 22+
    const ws: any = new WebSocket(browserWsUrl);
    let nextId = 1;
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    // Event waiters keyed by "<sessionId>:<method>" — several captures share
    // this socket, so a load event must only wake its own tab.
    const waiters = new Map<string, Array<(params: any) => void>>();
    let closed = false;

    const failAll = (err: Error) => {
      closed = true;
      for (const p of pending.values()) p.reject(err);
      pending.clear();
      waiters.clear();
    };

    ws.addEventListener("message", (ev: any) => {
      let msg: CdpMessage;
      try { msg = JSON.parse(ev.data.toString()); } catch { return; }
      if (msg.id !== undefined) {
        const cb = pending.get(msg.id);
        if (!cb) return;
        pending.delete(msg.id);
        if (msg.error) cb.reject(new Error(msg.error.message));
        else cb.resolve(msg.result);
        return;
      }
      if (!msg.method) return;
      const key = `${msg.sessionId || ""}:${msg.method}`;
      const list = waiters.get(key);
      if (!list || !list.length) return;
      waiters.delete(key);
      for (const fn of list) fn(msg.params);
    });

    ws.addEventListener("error", () => {
      if (!closed) failAll(new Error("cdp ws error"));
    });
    ws.addEventListener("close", () => {
      if (!closed) failAll(new Error("cdp ws closed"));
    });

    ws.addEventListener("open", () => {
      resolve({
        send(method, params, sessionId) {
          if (closed) return Promise.reject(new Error("cdp connection closed"));
          return new Promise((res, rej) => {
            const id = nextId++;
            pending.set(id, { resolve: res, reject: rej });
            try {
              ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
            } catch (err: any) {
              pending.delete(id);
              rej(err);
            }
          });
        },
        once(method, sessionId) {
          return new Promise((res) => {
            const key = `${sessionId}:${method}`;
            const list = waiters.get(key) || [];
            list.push(res);
            waiters.set(key, list);
          });
        },
        close() {
          closed = true;
          try { ws.close(); } catch {}
        },
      });
    });

    setTimeout(() => reject(new Error("cdp connect timeout")), 15_000).unref?.();
  });
}
