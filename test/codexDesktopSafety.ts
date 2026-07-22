import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { createWindowsBridgeConfig, desktopLaunchEnvironment } from "../bin/codex.js";
import { writeCodexBridgeConfig } from "../shared/codexBridgeConfig.js";
import { cleanupDir, freePort, sleep, tmpDir } from "./helpers.js";

const endpoint = "ws://127.0.0.1:45678";
const config = createWindowsBridgeConfig(endpoint, "C:\\private\\codex.exe");
assert.equal("desktop_env_set" in config, false, "setup config never requests a persistent Desktop endpoint");
assert.equal("desktop_env_previous" in config, false, "setup config never captures a persistent Desktop endpoint");

const parent = { KEEP_ME: "yes", CODEX_APP_SERVER_WS_URL: "ws://stale.invalid" };
const launched = desktopLaunchEnvironment(parent, endpoint);
assert.equal(launched.CODEX_APP_SERVER_WS_URL, endpoint, "bridged launch receives the managed endpoint");
assert.equal(parent.CODEX_APP_SERVER_WS_URL, "ws://stale.invalid", "launch does not mutate its parent environment");
assert.equal(launched.KEEP_ME, "yes", "launch preserves unrelated environment values");

if (process.platform !== "win32") {
  console.log("Codex Desktop safety tests passed (host lifecycle skipped outside Windows)");
  process.exit(0);
}

const temp = tmpDir("surface-codex-host-safety-");
const previousDataDir = process.env.SURFACE_DATA_DIR;
const previousCwd = process.cwd();
let spawnedPid: number | null = null;

function reachable(url: string, timeout = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { perMessageDeflate: false, handshakeTimeout: timeout });
    let done = false;
    const finish = (value: boolean) => {
      if (done) return;
      done = true;
      try { ws.terminate(); } catch {}
      resolve(value);
    };
    ws.once("open", () => finish(true));
    ws.once("error", () => finish(false));
    setTimeout(() => finish(false), timeout + 100).unref();
  });
}

try {
  const port = await freePort();
  const liveEndpoint = `ws://127.0.0.1:${port}`;
  const fakeCodex = path.join(temp, "codex.exe");
  fs.copyFileSync(process.execPath, fakeCodex);
  const wsEntry = JSON.stringify(path.resolve("node_modules/ws"));
  fs.writeFileSync(path.join(temp, "app-server"), [
    `const { WebSocketServer } = require(${wsEntry});`,
    "const endpoint = process.argv[process.argv.indexOf('--listen') + 1];",
    "const url = new URL(endpoint);",
    "const wss = new WebSocketServer({ host: url.hostname, port: Number(url.port), perMessageDeflate: false });",
    "process.on('SIGTERM', () => wss.close(() => process.exit(0)));",
    "setInterval(() => {}, 1000);",
  ].join("\n"));

  process.env.SURFACE_DATA_DIR = temp;
  process.chdir(temp);
  writeCodexBridgeConfig(temp, createWindowsBridgeConfig(liveEndpoint, fakeCodex));
  const host = await import("../server/codexManagedHost.js");

  assert.equal(await host.ensureCodexManagedHost(), true, "managed host becomes reachable");
  spawnedPid = host.codexManagedHostStatus().pid;
  assert.ok(spawnedPid, "Surface records the spawned host pid");

  host.closeCodexManagedHost();
  await sleep(200);
  assert.equal(await reachable(liveEndpoint), true, "normal Surface shutdown leaves the detached Desktop host alive");

  assert.equal(await host.ensureCodexManagedHost(), true, "a restarted Surface process adopts the existing endpoint");
  assert.equal(host.codexManagedHostStatus().reachable, true, "adopted host is reported as reachable");
  assert.equal(host.stopCodexManagedHost(), true, "explicit removal stops the adopted Codex host");

  const deadline = Date.now() + 3_000;
  while (await reachable(liveEndpoint, 200) && Date.now() < deadline) await sleep(50);
  assert.equal(await reachable(liveEndpoint, 200), false, "removed host no longer accepts Desktop connections");
  spawnedPid = null;
  console.log("Codex Desktop safety tests passed");
} finally {
  if (spawnedPid) {
    try { process.kill(spawnedPid); } catch {}
  }
  process.chdir(previousCwd);
  if (previousDataDir === undefined) delete process.env.SURFACE_DATA_DIR;
  else process.env.SURFACE_DATA_DIR = previousDataDir;
  cleanupDir(temp);
}
