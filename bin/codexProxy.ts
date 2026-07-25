import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readCodexBridgeConfig } from "../shared/codexBridgeConfig.js";
import { readCodexLauncherManifest, routeCodexArgs, shouldAttachCodex } from "./codexLauncher.js";

interface ProxyOptions {
  manifestPath?: string;
  startHost?: () => Promise<boolean>;
  error?: (message: string) => void;
}

function endpointReachable(endpoint: string, timeoutMs = 700): Promise<boolean> {
  return new Promise((resolve) => {
    if (endpoint.startsWith("unix://")) {
      const socketPath = decodeURIComponent(endpoint.slice("unix://".length));
      const socket = net.createConnection(socketPath);
      const finish = (ok: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(timeoutMs, () => finish(false));
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      return;
    }
    let url: URL;
    try { url = new URL(endpoint); } catch { resolve(false); return; }
    const port = Number(url.port);
    if (!port || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) { resolve(false); return; }
    const socket = net.createConnection({ host: url.hostname, port });
    const finish = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function requestManagedHostStart(): Promise<boolean> {
  const base = process.env.SURFACE_URL || "http://127.0.0.1:3000";
  try {
    const response = await fetch(new URL("/codex/host/start", base), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(12_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function startUnixDaemon(command: string, baseArgs: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, [...baseArgs, "app-server", "daemon", "start"], {
      stdio: "ignore",
      windowsHide: true,
      env: process.env,
    });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}

async function waitForEndpoint(endpoint: string, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await endpointReachable(endpoint)) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

function spawnTarget(command: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      windowsHide: true,
      env: process.env,
    });
    const forward = (signal: NodeJS.Signals) => {
      try { child.kill(signal); } catch {}
    };
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
    for (const signal of signals) process.on(signal, forward);
    child.once("error", (err) => {
      for (const signal of signals) process.off(signal, forward);
      console.error(`Surface could not launch Codex: ${err.message}`);
      resolve(1);
    });
    child.once("exit", (code) => {
      for (const signal of signals) process.off(signal, forward);
      resolve(code ?? 1);
    });
  });
}

export async function runCodexProxy(args: string[], options: ProxyOptions = {}): Promise<number> {
  const error = options.error || ((message: string) => console.error(message));
  const manifestPath = options.manifestPath || process.env.SURFACE_CODEX_LAUNCHER_CONFIG;
  if (!manifestPath) {
    error("Surface Codex launcher has no provenance. Run `surface codex setup --remove`, then set it up again.");
    return 78;
  }
  const dataDir = path.dirname(manifestPath);
  const manifest = readCodexLauncherManifest(dataDir);
  if (!manifest) {
    error(`Surface Codex launcher provenance is unreadable: ${manifestPath}`);
    return 78;
  }

  let routed = args.filter((arg) => arg !== "--no-surface");
  if (shouldAttachCodex(args)) {
    const bridge = readCodexBridgeConfig(dataDir);
    const endpoint = bridge?.endpoint || manifest.remote_endpoint;
    if (!endpoint) {
      error("Surface's Codex bridge is not configured. Run `surface codex setup`, or use `codex --no-surface`.");
      return 78;
    }
    let ready = await endpointReachable(endpoint);
    if (!ready) {
      const defaultStart = endpoint.startsWith("unix://")
        ? () => startUnixDaemon(manifest.target.command, manifest.target.args)
        : requestManagedHostStart;
      const started = await (options.startHost || defaultStart)();
      if (started) ready = await waitForEndpoint(endpoint);
    }
    if (!ready) {
      error(`Surface could not reach its Codex host at ${endpoint}. Start Surface and retry, or use \`codex --no-surface\`.`);
      return 78;
    }
    routed = routeCodexArgs(args, endpoint);
  }
  return spawnTarget(manifest.target.command, [...manifest.target.args, ...routed]);
}

export function parseCodexProxyInvocation(args: string[]): { args: string[]; manifestPath?: string } {
  if (args[0] === "--surface-launcher-config" && args[1] && args[2] === "--") {
    return { args: args.slice(3), manifestPath: args[1] };
  }
  return { args };
}

const invoked = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  const invocation = parseCodexProxyInvocation(process.argv.slice(2));
  runCodexProxy(invocation.args, { manifestPath: invocation.manifestPath }).then((code) => { process.exitCode = code; });
}
