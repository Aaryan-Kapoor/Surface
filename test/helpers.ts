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
  env: Record<string, string> = {},
  contentPort?: number,
): ChildProcess {
  const tsxBin = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
  const child = spawn(tsxBin, ["server/index.ts"], {
    cwd: REPO_ROOT,
    detached: true,
    env: {
      ...process.env,
      SURFACE_DATA_DIR: dataDir,
      SURFACE_BIND: "127.0.0.1",
      SURFACE_PAIR_ON_START: "0",
      PORT: String(port),
      SURFACE_CONTENT_PORT: String(contentPort ?? port + 1000),
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

export async function waitForReady(base: string, pathName = "/api/auth/session", timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${base}${pathName}`, { signal: AbortSignal.timeout(500) });
      if (res.status < 500) return;
    } catch {}
    await sleep(150);
  }
  throw new Error(`server did not become ready at ${base}`);
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
    try {
      await fetch(`http://127.0.0.1:${port}/api/auth/session`, { signal: AbortSignal.timeout(500) });
    } catch {
      return;
    }
    await sleep(150);
  }
  throw new Error("old server still answering after kill");
}

export function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function cleanupDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

export async function assertNoLeakedTestServers(): Promise<void> {
  const out = spawn("pgrep", ["-af", "server/index.ts"], { stdio: ["ignore", "pipe", "ignore"] });
  let text = "";
  out.stdout?.setEncoding("utf8");
  out.stdout?.on("data", (chunk) => { text += chunk; });
  const code = await new Promise<number>((resolve) => out.on("exit", (c) => resolve(c ?? 0)));
  if (code > 1) return;
  const leaked = text.split("\n").filter((line) => line.includes("server/index.ts") && line.includes("surface-"));
  if (leaked.length) throw new Error(`possible leaked Surface test servers:\n${leaked.join("\n")}`);
}
