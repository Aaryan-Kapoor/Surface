import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { getDataDir } from "./paths.js";
import { readCodexBridgeConfig, type CodexBridgeConfig } from "../shared/codexBridgeConfig.js";

export interface CodexManagedHostStatus {
  configured: boolean;
  endpoint: string | null;
  managed: boolean;
  running: boolean;
  reachable: boolean;
  pid: number | null;
  restarts: number;
  last_error: string | null;
}

let child: ChildProcess | null = null;
let restartTimer: NodeJS.Timeout | null = null;
let stopping = false;
let restarts = 0;
let lastError: string | null = null;
let reachable = false;

export function configuredCodexEndpoint(): string | null {
  return process.env.SURFACE_CODEX_ENDPOINT
    || readCodexBridgeConfig(getDataDir())?.endpoint
    || null;
}

function config(): CodexBridgeConfig | null {
  return readCodexBridgeConfig(getDataDir());
}

function endpointReachable(endpoint: string, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(endpoint, { perMessageDeflate: false, handshakeTimeout: timeoutMs });
    const timer = setTimeout(() => finish(false), timeoutMs + 100);
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve(ok);
    };
    ws.once("open", () => finish(true));
    ws.once("error", () => finish(false));
    ws.once("close", () => finish(false));
  });
}

function scheduleRestart(): void {
  if (stopping || restartTimer) return;
  const delay = Math.min(30_000, 1_000 * 2 ** Math.min(restarts, 5));
  restartTimer = setTimeout(() => {
    restartTimer = null;
    void ensureCodexManagedHost();
  }, delay);
  restartTimer.unref();
}

export async function ensureCodexManagedHost(): Promise<boolean> {
  const cfg = config();
  if (!cfg?.managed || process.env.SURFACE_CODEX_DISABLE === "1") return false;
  let endpointUrl: URL;
  try { endpointUrl = new URL(cfg.endpoint); } catch {
    lastError = "managed codex endpoint is not a valid URL";
    return false;
  }
  if (!(["127.0.0.1", "localhost", "::1"].includes(endpointUrl.hostname))) {
    lastError = "managed codex endpoint must be loopback-only";
    return false;
  }
  if (child && child.exitCode === null && !child.killed && reachable) return true;
  if (await endpointReachable(cfg.endpoint)) {
    reachable = true;
    lastError = null;
    return true;
  }
  reachable = false;

  stopping = false;
  fs.mkdirSync(path.join(getDataDir(), "logs"), { recursive: true });
  const log = fs.openSync(path.join(getDataDir(), "logs", "codex-app-server.log"), "a");
  try {
    const env = { ...process.env };
    delete env.CODEX_APP_SERVER_WS_URL;
    child = spawn(cfg.codex_bin, ["app-server", "--listen", cfg.endpoint, "--analytics-default-enabled"], {
      windowsHide: true,
      stdio: ["ignore", log, log],
      env,
      // Surface may be restarted while Codex Desktop is attached. A detached
      // Windows host survives that restart; the new service adopts it by
      // probing the persisted loopback endpoint.
      detached: process.platform === "win32",
    });
  } catch (err: any) {
    fs.closeSync(log);
    lastError = err?.message || String(err);
    restarts++;
    scheduleRestart();
    return false;
  }
  fs.closeSync(log);
  const spawned = child;
  if (process.platform === "win32") spawned.unref();
  spawned.once("error", (err) => { lastError = err.message; });
  spawned.once("exit", (code, signal) => {
    if (child === spawned) child = null;
    reachable = false;
    if (!stopping) {
      lastError = `codex app-server exited (${signal || code})`;
      restarts++;
      scheduleRestart();
    }
  });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await endpointReachable(cfg.endpoint, 500)) {
      reachable = true;
      lastError = null;
      return true;
    }
    if (!child || child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  lastError ||= "codex app-server did not become ready within 10 seconds";
  return false;
}

export function codexManagedHostStatus(): CodexManagedHostStatus {
  const cfg = config();
  return {
    configured: !!cfg,
    endpoint: cfg?.endpoint || null,
    managed: cfg?.managed || false,
    running: reachable || (!!child && child.exitCode === null && !child.killed),
    reachable,
    pid: child?.pid || null,
    restarts,
    last_error: lastError,
  };
}

export function closeCodexManagedHost(): void {
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = null;
  const closing = child;
  // A normal Surface shutdown/restart must not disconnect Codex Desktop. On
  // Windows the host is deliberately detached and adopted by the next Surface
  // process. Other platforms retain the old child-owned lifecycle.
  if (process.platform !== "win32") {
    try { closing?.kill(); } catch {}
    reachable = false;
  }
  child = null;
}

function windowsListenerPid(endpoint: string): number | null {
  if (process.platform !== "win32") return null;
  let url: URL;
  try { url = new URL(endpoint); } catch { return null; }
  const port = url.port;
  if (!port) return null;
  try {
    const output = execFileSync("netstat.exe", ["-ano", "-p", "TCP"], {
      timeout: 2_000,
      windowsHide: true,
      encoding: "utf8",
    });
    for (const line of output.split(/\r?\n/)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 5 || fields[0].toUpperCase() !== "TCP" || fields[3].toUpperCase() !== "LISTENING") continue;
      if ((fields[1].endsWith(`:${port}`)) && /^\d+$/.test(fields[4])) return Number(fields[4]);
    }
  } catch {}
  return null;
}

export function stopCodexManagedHost(): boolean {
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = null;
  const cfg = config();
  const pid = child?.pid || (cfg ? windowsListenerPid(cfg.endpoint) : null);
  child = null;
  if (!pid) {
    reachable = false;
    return false;
  }
  try {
    if (process.platform === "win32") {
      // Validate the endpoint owner before terminating it. The configured
      // listener must still be a Codex process, protecting against PID reuse.
      const row = execFileSync("tasklist.exe", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
        timeout: 2_000,
        windowsHide: true,
        encoding: "utf8",
      });
      if (!/^"codex\.exe"\s*,/i.test(row.trim())) return false;
    }
    process.kill(pid);
    reachable = false;
    return true;
  } catch {
    return false;
  }
}
