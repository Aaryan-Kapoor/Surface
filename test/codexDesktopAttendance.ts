import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer } from "ws";
import { windowsCodexClientConnected } from "../server/codexBridge.js";
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
let client: ChildProcess | null = null;

function killClient(): void {
  try { client?.kill(); } catch {}
}

async function connectAs(imageName: "ChatGPT.exe" | "codex.exe"): Promise<void> {
  const fakeClient = path.join(temp, imageName);
  fs.copyFileSync(process.execPath, fakeClient);
  client = spawn(fakeClient, [
    "-e",
    `const WebSocket=require('ws');const ws=new WebSocket('${endpoint}',{perMessageDeflate:false});setInterval(()=>{},1000)`,
  ], { cwd: REPO_ROOT, stdio: "ignore", windowsHide: true });

  const deadline = Date.now() + 5_000;
  while (wss.clients.size === 0 && Date.now() < deadline) await sleep(50);
  assert.equal(wss.clients.size, 1, `${imageName} established the loopback client connection`);
  const started = Date.now();
  assert.equal(await windowsCodexClientConnected(endpoint), true, `${imageName} client is detected as attached`);
  assert.ok(Date.now() - started < 1_500, "attendance check completes inside the old 2s failure budget");

  client.kill();
  client = null;
  for (const ws of wss.clients) ws.terminate();
  const disconnected = Date.now() + 5_000;
  while (wss.clients.size > 0 && Date.now() < disconnected) await sleep(50);
}

try {
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

  // Windows reports a process image name from the executable filename. Copied
  // node binaries provide harmless stand-ins for both supported clients.
  await connectAs("ChatGPT.exe");
  await connectAs("codex.exe");
  assert.equal(await windowsCodexClientConnected(endpoint), false, "no Codex client is not attended");

  console.log("Codex Desktop attendance tests passed");
} finally {
  killClient();
  for (const ws of wss.clients) ws.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  cleanupDir(temp);
}
