import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface TestResponse {
  status: number;
  headers: Headers;
  body: any;
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error("could not acquire port"));
      }
    });
  });
}

export async function isolatedPorts(): Promise<{ port: number; contentPort: number }> {
  while (true) {
    const port = await freePort();
    const contentPort = await freePort();
    if (port !== contentPort) return { port, contentPort };
  }
}

export function makeClient(base: string) {
  return async function req(
    method: string,
    pathname: string,
    opts: { token?: string; cookie?: string; body?: unknown; signal?: AbortSignal; headers?: Record<string, string> } = {},
  ): Promise<TestResponse> {
    const headers: Record<string, string> = { ...(opts.headers || {}) };
    if (opts.body !== undefined) headers["Content-Type"] = headers["Content-Type"] || "application/json";
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.cookie) headers.Cookie = opts.cookie;
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal ?? AbortSignal.timeout(10000),
      redirect: "manual",
    });
    const text = await res.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: res.status, headers: res.headers, body };
  };
}

export function spawnServer(
  port: number,
  dataDir: string,
  env: Record<string, string>,
  contentPort: number,
): ChildProcess {
  const tsxCli = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const child = spawn(process.execPath, [tsxCli, "server/index.ts"], {
    cwd: REPO_ROOT,
    detached: true,
    env: {
      ...process.env,
      SURFACE_DATA_DIR: dataDir,
      SURFACE_BIND: "127.0.0.1",
      SURFACE_PAIR_ON_START: "0",
      PORT: String(port),
      SURFACE_CONTENT_PORT: String(contentPort),
      NODE_ENV: "test",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => {
    if (process.env.SURFACE_TEST_VERBOSE) process.stdout.write(d);
  });
  child.stderr?.on("data", (d) => {
    if (process.env.SURFACE_TEST_VERBOSE) process.stderr.write(d);
  });
  return child;
}

// Boot budget. A `tsx` cold start plus migrations is comfortably under a second
// on an idle machine, but CI runners are not idle: two workflow runs of the same
// commit can execute concurrently on the same host, and 15s of wall clock has
// been observed to expire mid-boot on a healthy server (release 0.2.4, master
// run 32318938374 — same commit passed on every other platform and on the tag
// run's identical job). The budget is generous because the cost of it being too
// small is a red X on green code, while the cost of it being too large is only
// paid when something is genuinely broken — and the `exited` check below makes
// that case fail immediately rather than waiting this out.
const READY_TIMEOUT_MS = Number(process.env.SURFACE_TEST_READY_TIMEOUT_MS || 60000);

/**
 * Wait for a spawned server to answer.
 *
 * Pass `child` wherever one is available: a server that died during boot (port
 * collision, migration throw, syntax error) is then reported the instant it
 * exits, with its exit code and whatever it wrote to stderr — instead of
 * timing out and blaming the clock. Without it this can only report "did not
 * become ready", which is true of both a slow boot and a corpse.
 */
export async function waitForReady(
  base: string,
  pathName = "/api/auth/session",
  timeoutMs = READY_TIMEOUT_MS,
  child?: ChildProcess,
): Promise<void> {
  let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let stderr = "";
  if (child) {
    child.once("exit", (code, signal) => { exit = { code, signal }; });
    // Keep the tail only: a server that fails to boot says why in its last few
    // lines, and the rest is startup noise nobody reads.
    child.stderr?.on("data", (d) => { stderr = (stderr + String(d)).slice(-2000); });
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (exit) {
      const { code, signal } = exit as { code: number | null; signal: NodeJS.Signals | null };
      throw new Error(
        `server at ${base} exited during boot (${signal ? `signal ${signal}` : `code ${code}`})` +
        (stderr.trim() ? `\n--- stderr ---\n${stderr.trim()}` : ""),
      );
    }
    try {
      const res = await fetch(`${base}${pathName}`, { signal: AbortSignal.timeout(500) });
      if (res.status < 500) return;
    } catch {}
    await sleep(150);
  }
  throw new Error(
    `server did not become ready at ${base} within ${timeoutMs}ms` +
    (stderr.trim() ? `\n--- stderr ---\n${stderr.trim()}` : ""),
  );
}

/**
 * Is anything accepting connections on this port? A bare TCP connect, not an
 * HTTP request.
 *
 * Teardown used to probe with `fetch`, which on macOS + Node 24 can throw
 * `setTypeOfService EINVAL` from inside undici's socket write path as the
 * listener goes away underneath it. That is an uncaught exception, not a
 * rejected promise, so the caller's `.catch()` never sees it and the whole
 * suite dies after its last assertion has already passed. Liveness here only
 * ever meant "is the port open", which is a connect.
 */
function portAccepting(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let settled = false;
    const done = (open: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export async function killServer(child: ChildProcess | null, port: number): Promise<void> {
  if (!child) return;
  try {
    if (child.pid) process.kill(-child.pid, "SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch {}
  }
  const start = Date.now();
  while (Date.now() - start < 10000) {
    if (!(await portAccepting(port))) return;
    await sleep(150);
  }
  throw new Error("old server still answering after kill");
}

export function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Retry, then complain. A scratch dir is routinely still held the instant a
// suite tears down — a detached server keeping sqlite handles open, or a
// Chrome profile whose renderer children go on touching lock files after the
// parent dies (server/thumbs.ts retries for exactly that reason). The old
// version swallowed the failure, so `finally { cleanupDir(dir) }` read as
// proof of cleanup while quietly leaving the directory behind: correct
// structure, silent leak, nothing anywhere saying so.
//
// This warns rather than throws: a suite that passed should not be reported
// as failed because /tmp is untidy, but a leak should never again be silent.
export function cleanupDir(dir: string): void {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      lastErr = err;
      // synchronous backoff: teardown runs on the way out, with no event loop
      // left to await on, and the holder usually releases within a few ms
      const until = Date.now() + 25;
      while (Date.now() < until) { /* spin briefly */ }
    }
  }
  console.warn(`[cleanup] could not remove ${dir}: ${(lastErr as Error)?.message ?? lastErr}`);
}

export async function assertNoLeakedTestServers(): Promise<void> {
  const out = process.platform === "win32"
    ? spawn("powershell.exe", [
      "-NoProfile",
      "-Command",
      [
        "Get-CimInstance Win32_Process",
        "Where-Object { $_.CommandLine -like '*server/index.ts*' }",
        "ForEach-Object { \"$($_.ProcessId) $($_.CommandLine)\" }",
      ].join(" | "),
    ], { stdio: ["ignore", "pipe", "ignore"] })
    : spawn("pgrep", ["-af", "server/index.ts"], { stdio: ["ignore", "pipe", "ignore"] });
  let text = "";
  out.stdout?.setEncoding("utf8");
  out.stdout?.on("data", (chunk) => { text += chunk; });
  const code = await new Promise<number>((resolve) => out.on("exit", (c) => resolve(c ?? 0)));
  if (code > 1) return;
  const leaked = text.split("\n").filter((line) => line.includes("server/index.ts") && line.includes("surface-"));
  if (leaked.length) throw new Error(`possible leaked Surface test servers:\n${leaked.join("\n")}`);
}
