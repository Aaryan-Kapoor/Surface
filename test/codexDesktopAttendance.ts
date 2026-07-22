import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer } from "ws";
import { windowsCodexDesktopConnected } from "../server/codexBridge.js";
import { cleanupDir, freePort, REPO_ROOT, sleep, tmpDir } from "./helpers.js";

if (process.platform !== "win32") {
  console.log("Codex Desktop attendance: skipped (Windows-only managed transport)");
  process.exit(0);
}

const port = await freePort();
const endpoint = `ws://127.0.0.1:${port}`;
const server = http.createServer();
const wss = new WebSocketServer({ server, perMessageDeflate: false });
const temp = tmpDir("surface-codex-attendance-");
let desktop: ChildProcess | null = null;

try {
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

  // Windows reports a process image name from the executable filename. A
  // copied node binary gives the test a harmless ChatGPT.exe client without
  // depending on Codex Desktop being installed or running in CI.
  const fakeDesktop = path.join(temp, "ChatGPT.exe");
  fs.copyFileSync(process.execPath, fakeDesktop);
  desktop = spawn(fakeDesktop, [
    "-e",
    `const WebSocket=require('ws');const ws=new WebSocket('${endpoint}',{perMessageDeflate:false});setInterval(()=>{},1000)`,
  ], { cwd: REPO_ROOT, stdio: "ignore", windowsHide: true });

  const deadline = Date.now() + 5_000;
  while (wss.clients.size === 0 && Date.now() < deadline) await sleep(50);
  assert.equal(wss.clients.size, 1, "fake Desktop established the loopback client connection");

  const started = Date.now();
  assert.equal(await windowsCodexDesktopConnected(endpoint), true, "ChatGPT.exe client is detected as attached");
  assert.ok(Date.now() - started < 1_500, "attendance check completes inside the old 2s failure budget");

  desktop.kill();
  desktop = null;
  for (const ws of wss.clients) ws.terminate();
  await sleep(100);
  assert.equal(await windowsCodexDesktopConnected(endpoint), false, "no Desktop client is not attended");

  console.log("Codex Desktop attendance tests passed");
} finally {
  try { desktop?.kill(); } catch {}
  for (const ws of wss.clients) ws.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  cleanupDir(temp);
}
