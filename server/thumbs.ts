import fs from "fs";
import path from "path";
import { spawn, spawnSync, ChildProcess } from "child_process";
import { getDataDir } from "./paths.js";
import { broadcastGlobal } from "./sse.js";

const THUMB_WIDTH = 600;
const THUMB_HEIGHT = 600;
const POST_NAVIGATE_DELAY_MS = 6_500;
const OVERALL_TIMEOUT_MS = 45_000;

let chromeBinCache: string | null | undefined;
let serverPort = 0;

export function setThumbServerPort(port: number) {
  serverPort = port;
}

function thumbsDir(): string {
  const dir = path.join(getDataDir(), "thumbs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getThumbPath(id: string): string {
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
  running = true;
  try {
    while (queue.length) {
      const job = queue.shift()!;
      try {
        await capture(job);
        broadcastGlobal("thumb_ready", { id: job.id });
      } catch (err: any) {
        console.error(`[thumbs] capture failed for ${job.id}:`, err?.message || err);
      }
    }
  } finally {
    running = false;
  }
}

async function capture(job: Job): Promise<void> {
  const bin = findChromeBin();
  if (!bin) throw new Error("chrome binary unavailable");

  const dest = getThumbPath(job.id);
  const tmpDir = fs.mkdtempSync(path.join(getDataDir(), ".chrome-"));
  const url = `http://127.0.0.1:${serverPort}/artifacts/${encodeURIComponent(job.id)}/view?preview=1`;

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

  let child: ChildProcess | null = null;
  let settled = false;
  const cleanup = () => {
    try { if (child && !child.killed) child.kill("SIGKILL"); } catch {}
    fs.rm(tmpDir, { recursive: true, force: true }, () => {});
  };

  return new Promise<void>((resolve, reject) => {
    const overall = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("capture timeout"));
    }, OVERALL_TIMEOUT_MS);

    child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });

    let stderrBuf = "";
    let cdpStarted = false;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(overall);
      cleanup();
      if (err) reject(err);
      else resolve();
    };

    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", async (chunk: string) => {
      stderrBuf += chunk;
      if (cdpStarted) return;
      const m = stderrBuf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (!m) return;
      cdpStarted = true;
      try {
        await runCdpCapture(m[1], url, dest);
        finish();
      } catch (err: any) {
        finish(err);
      }
    });

    child.on("error", (err) => finish(err));
    child.on("exit", (code) => {
      if (!cdpStarted) {
        finish(new Error(`chrome exited before DevTools ready (code=${code})`));
      }
    });
  });
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: { message: string };
  sessionId?: string;
}

function runCdpCapture(browserWsUrl: string, navigateUrl: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // @ts-ignore — WebSocket is globally available in Node 22+
    const ws = new WebSocket(browserWsUrl);
    let nextId = 1;
    const pending = new Map<number, (msg: CdpMessage) => void>();
    let sessionId: string | undefined;
    let settledLocal = false;

    const fail = (err: Error) => {
      if (settledLocal) return;
      settledLocal = true;
      try { ws.close(); } catch {}
      reject(err);
    };

    const done = () => {
      if (settledLocal) return;
      settledLocal = true;
      try { ws.close(); } catch {}
      resolve();
    };

    const sendBrowser = (method: string, params?: any) => {
      return new Promise<any>((res, rej) => {
        const id = nextId++;
        pending.set(id, (msg) => {
          if (msg.error) rej(new Error(method + ": " + msg.error.message));
          else res(msg.result);
        });
        ws.send(JSON.stringify({ id, method, params }));
      });
    };

    const sendSession = (method: string, params?: any) => {
      return new Promise<any>((res, rej) => {
        const id = nextId++;
        pending.set(id, (msg) => {
          if (msg.error) rej(new Error(method + ": " + msg.error.message));
          else res(msg.result);
        });
        ws.send(JSON.stringify({ sessionId, id, method, params }));
      });
    };

    ws.addEventListener("message", (ev: any) => {
      let msg: CdpMessage;
      try { msg = JSON.parse(ev.data.toString()); } catch { return; }
      if (msg.id !== undefined) {
        const cb = pending.get(msg.id);
        if (cb) { pending.delete(msg.id); cb(msg); }
      }
    });

    ws.addEventListener("error", () => fail(new Error("cdp ws error")));
    ws.addEventListener("close", () => {
      if (!settledLocal) fail(new Error("cdp ws closed unexpectedly"));
    });

    ws.addEventListener("open", async () => {
      try {
        const list = await sendBrowser("Target.getTargets");
        const pageTarget = (list.targetInfos || []).find((t: any) => t.type === "page");
        if (!pageTarget) throw new Error("no page target found");
        const attached = await sendBrowser("Target.attachToTarget", {
          targetId: pageTarget.targetId,
          flatten: true,
        });
        sessionId = attached.sessionId;
        await sendSession("Emulation.setDeviceMetricsOverride", {
          width: THUMB_WIDTH,
          height: THUMB_HEIGHT,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await sendSession("Page.navigate", { url: navigateUrl });
        await new Promise((r) => setTimeout(r, POST_NAVIGATE_DELAY_MS));
        const result = await sendSession("Page.captureScreenshot", {
          format: "png",
          clip: { x: 0, y: 0, width: THUMB_WIDTH, height: THUMB_HEIGHT, scale: 1 },
          captureBeyondViewport: false,
        });
        const buf = Buffer.from(result.data, "base64");
        fs.writeFileSync(destPath, buf);
        done();
      } catch (err: any) {
        fail(err);
      }
    });
  });
}
