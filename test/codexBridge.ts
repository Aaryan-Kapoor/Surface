import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { cleanupDir, isolatedPorts, killServer, makeClient, sleep, spawnServer, tmpDir, waitForReady, REPO_ROOT } from "./helpers.js";

// The codex flowback layer (docs/interaction/codex.md), tested against a mock
// codex app-server daemon speaking the real wire protocol: JSON-RPC over a
// WebSocket on a unix socket. We assert the ladder policy end to end:
//
//   - a surface created with a codex agent_session delivers clicks as a
//     turn/start on the loaded thread, batch in the input text, inbox acked
//   - clicks during an active delivered turn coalesce into ONE follow-up
//   - a dead session is resumed from disk first (with retry on the
//     "no rollout found" race) — but only with recorded project consent
//   - a session open in an unreachable plain TUI (live pid) is never woken
//   - approval requests are declined for bridge-initiated headless turns and
//     left unanswered for turns on attached threads
//   - explicit bindings outrank the codex layer; waiters outrank everything
//   - a device-plane caller cannot plant an agent_session link

// ── mock codex app-server daemon ──

interface TurnStartCall { threadId: string; text: string }

class MockDaemon {
  server: http.Server;
  wss: WebSocketServer;
  sockets = new Set<WebSocket>();
  loadedThreads = new Set<string>();
  resumeFailures = 0; // fail this many thread/resume calls with the rollout race
  resumeCalls: string[] = [];
  turnStarts: TurnStartCall[] = [];
  approvalResponses: any[] = [];
  autoCompleteTurns = true;
  private nextServerRequestId = 1000;

  constructor(public sockPath: string) {
    this.server = http.createServer();
    this.wss = new WebSocketServer({ server: this.server, perMessageDeflate: false });
    this.wss.on("connection", (ws) => {
      this.sockets.add(ws);
      ws.on("close", () => this.sockets.delete(ws));
      ws.on("message", (data) => this.onMessage(ws, JSON.parse(data.toString())));
    });
  }

  listen(): Promise<void> {
    return new Promise((resolve) => this.server.listen(this.sockPath, resolve as () => void));
  }

  private send(ws: WebSocket, msg: unknown): void {
    ws.send(JSON.stringify(msg));
  }

  broadcast(method: string, params: unknown): void {
    for (const ws of this.sockets) this.send(ws, { method, params });
  }

  // Server → client request to every client; responses land in approvalResponses.
  requestApproval(threadId: string): void {
    const id = this.nextServerRequestId++;
    for (const ws of this.sockets) {
      this.send(ws, {
        id,
        method: "item/commandExecution/requestApproval",
        params: { threadId, turnId: "turn-x", itemId: "exec-1", command: "touch /tmp/x", cwd: "/tmp" },
      });
    }
  }

  private onMessage(ws: WebSocket, msg: any): void {
    if (msg.id !== undefined && msg.method === undefined) {
      // response to a server → client request (an approval decision)
      this.approvalResponses.push(msg);
      return;
    }
    switch (msg.method) {
      case "initialize":
        this.send(ws, { id: msg.id, result: { userAgent: "Codex Mock/0.199.0 (Test; x86_64) test (surface; 1)" } });
        return;
      case "initialized":
        return;
      case "thread/loaded/list":
        this.send(ws, { id: msg.id, result: { data: [...this.loadedThreads], nextCursor: null } });
        return;
      case "thread/resume": {
        const threadId = msg.params.threadId;
        this.resumeCalls.push(threadId);
        if (this.resumeFailures > 0) {
          this.resumeFailures--;
          this.send(ws, { id: msg.id, error: { code: -32600, message: `no rollout found for thread id ${threadId}` } });
          return;
        }
        this.loadedThreads.add(threadId);
        this.send(ws, { id: msg.id, result: { thread: { id: threadId } } });
        return;
      }
      case "turn/start": {
        const threadId = msg.params.threadId;
        const text = msg.params.input?.[0]?.text || "";
        this.turnStarts.push({ threadId, text });
        this.send(ws, { id: msg.id, result: { turn: { id: `turn-${this.turnStarts.length}`, status: "inProgress" } } });
        this.broadcast("turn/started", { threadId, turn: { id: `turn-${this.turnStarts.length}` } });
        if (this.autoCompleteTurns) {
          setTimeout(() => this.completeTurn(threadId), 150);
        }
        return;
      }
      default:
        this.send(ws, { id: msg.id, error: { code: -32601, message: `mock: unhandled ${msg.method}` } });
    }
  }

  completeTurn(threadId: string): void {
    this.broadcast("turn/completed", { threadId, turn: { id: "turn-done", status: "completed" } });
  }

  close(): Promise<void> {
    for (const ws of this.sockets) ws.terminate();
    this.wss.close();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

// ── harness ──

let PORT = 0;
let BASE = "";
let CONTENT_BASE = "";
let server: ChildProcess | null = null;
let call: ReturnType<typeof makeClient>;
let daemon: MockDaemon;

const dataDir = tmpDir("surface-codex-data-");
const sockDir = fs.mkdtempSync(path.join(os.tmpdir(), "sfcx-"));
const sockPath = path.join(sockDir, "d.sock");
const projectRoot = fs.realpathSync(tmpDir("surface-codex-proj-"));
fs.mkdirSync(path.join(projectRoot, ".surface"), { recursive: true });
fs.writeFileSync(path.join(projectRoot, ".surface", "config.json"), JSON.stringify({ bindings: { enabled: true } }));
const noConsentRoot = fs.realpathSync(tmpDir("surface-codex-nocons-"));

const LIVE_THREAD = "019f0000-0000-7000-8000-000000000001";
const DEAD_THREAD = "019f0000-0000-7000-8000-000000000002";
const TUI_THREAD = "019f0000-0000-7000-8000-000000000003";
const NOCONSENT_THREAD = "019f0000-0000-7000-8000-000000000004";
const RETRY_THREAD = "019f0000-0000-7000-8000-000000000005";
const CLI_THREAD = "019f0000-0000-7000-8000-000000000006";

async function api(method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await call(method, p, { body });
  return { status: res.status, json: res.body };
}

async function createCodexSurface(id: string, threadId: string, root = projectRoot): Promise<void> {
  const created = await api("POST", "/artifacts", {
    id,
    title: `Codex ${id}`,
    mime: "text/html",
    content: "<h1>codex</h1>",
    project_root: root,
    agent_session: { kind: "codex", session_id: threadId },
  });
  assert.equal(created.status, 201, `surface ${id} created`);
}

async function pendingCount(id: string): Promise<number> {
  const { json } = await api("GET", `/artifacts/${id}/actions`);
  return Array.isArray(json) ? json.length : -1;
}

async function waitFor(pred: () => Promise<boolean> | boolean, timeoutMs: number, label: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await sleep(75);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

function test(name: string, fn: () => Promise<void>) {
  return fn()
    .then(() => console.log(`  PASS  ${name}`))
    .catch((err) => { console.error(`  FAIL  ${name}`); throw err; });
}

function batchOf(turn: TurnStartCall): any {
  const m = /```json\n([\s\S]*?)\n```/.exec(turn.text);
  assert.ok(m, "turn text carries a fenced JSON batch");
  return JSON.parse(m![1]);
}

async function main() {
  const ports = await isolatedPorts();
  PORT = ports.port;
  BASE = `http://127.0.0.1:${PORT}`;
  CONTENT_BASE = `http://127.0.0.1:${ports.contentPort}`;
  call = makeClient(BASE);

  daemon = new MockDaemon(sockPath);
  await daemon.listen();

  server = spawnServer(PORT, dataDir, {
    SURFACE_CODEX_SOCKET: sockPath,
    SURFACE_CODEX_AUTOSTART: "0",
  }, ports.contentPort);
  await waitForReady(BASE, "/artifacts");

  console.log("\n=== Codex flowback bridge Tests ===\n");

  await test("live thread: click becomes turn/start with the batch, inbox acked", async () => {
    daemon.loadedThreads.add(LIVE_THREAD);
    await createCodexSurface("cx-live", LIVE_THREAD);
    const act = await api("POST", "/artifacts/cx-live/actions", { action: "approve", data: { env: "staging" } });
    assert.equal(act.status, 201);
    await waitFor(() => daemon.turnStarts.length === 1, 10000, "turn/start to arrive");
    const turn = daemon.turnStarts[0];
    assert.equal(turn.threadId, LIVE_THREAD);
    const batch = batchOf(turn);
    assert.equal(batch.type, "surface_action_batch");
    assert.equal(batch.surface_id, "cx-live");
    assert.equal(batch.actions.length, 1);
    assert.equal(batch.actions[0].action, "approve");
    assert.deepEqual(batch.actions[0].data, { env: "staging" });
    assert.equal(daemon.resumeCalls.length, 0, "no resume needed for a loaded thread");
    await waitFor(async () => (await pendingCount("cx-live")) === 0, 5000, "inbox drained");
  });

  await test("clicks during an active delivered turn coalesce into one follow-up batch", async () => {
    daemon.autoCompleteTurns = false;
    daemon.turnStarts = [];
    const first = await api("POST", "/artifacts/cx-live/actions", { action: "a", data: { n: 1 } });
    assert.equal(first.status, 201);
    await waitFor(() => daemon.turnStarts.length === 1, 10000, "first turn/start");
    // Two more clicks while the turn is running
    await api("POST", "/artifacts/cx-live/actions", { action: "b", data: { n: 2 } });
    await api("POST", "/artifacts/cx-live/actions", { action: "c", data: { n: 3 } });
    await sleep(600);
    assert.equal(daemon.turnStarts.length, 1, "no extra turn while one is active");
    daemon.completeTurn(LIVE_THREAD);
    await waitFor(() => daemon.turnStarts.length === 2, 10000, "coalesced follow-up turn");
    const batch = batchOf(daemon.turnStarts[1]);
    assert.deepEqual(batch.actions.map((a: any) => a.action).sort(), ["b", "c"], "follow-up carries both queued clicks");
    daemon.completeTurn(LIVE_THREAD);
    daemon.autoCompleteTurns = true;
    await waitFor(async () => (await pendingCount("cx-live")) === 0, 5000, "inbox drained");
  });

  await test("dead session with consent: resumed from disk, then woken", async () => {
    daemon.turnStarts = [];
    await createCodexSurface("cx-dead", DEAD_THREAD);
    const act = await api("POST", "/artifacts/cx-dead/actions", { action: "retry", data: {} });
    assert.equal(act.status, 201);
    await waitFor(() => daemon.turnStarts.length === 1, 10000, "wake turn/start");
    assert.deepEqual(daemon.resumeCalls, [DEAD_THREAD], "thread resumed before the wake turn");
    assert.equal(daemon.turnStarts[0].threadId, DEAD_THREAD);
    await waitFor(async () => (await pendingCount("cx-dead")) === 0, 5000, "inbox drained");
  });

  await test("approval on a bridge-initiated headless turn is declined (fail closed)", async () => {
    // cx-dead's thread was resumed by the bridge and its turn is still the
    // bridge's own headless turn until turn/completed clears it — but
    // autoComplete already fired. Start a fresh headless wake and interrogate
    // before completion.
    daemon.autoCompleteTurns = false;
    daemon.turnStarts = [];
    daemon.approvalResponses = [];
    daemon.loadedThreads.delete(DEAD_THREAD);
    const act = await api("POST", "/artifacts/cx-dead/actions", { action: "again", data: {} });
    assert.equal(act.status, 201);
    await waitFor(() => daemon.turnStarts.length === 1, 10000, "second wake turn");
    daemon.requestApproval(DEAD_THREAD);
    await waitFor(() => daemon.approvalResponses.length === 1, 5000, "decline response");
    assert.equal(daemon.approvalResponses[0].result?.decision, "decline");
    daemon.completeTurn(DEAD_THREAD);
    daemon.autoCompleteTurns = true;
  });

  await test("approval on an attached (non-headless) thread is left for the user's client", async () => {
    daemon.approvalResponses = [];
    daemon.requestApproval(LIVE_THREAD);
    await sleep(800);
    assert.equal(daemon.approvalResponses.length, 0, "surface stayed silent");
  });

  await test("resume retries through the 'no rollout found' race", async () => {
    daemon.turnStarts = [];
    daemon.resumeCalls = [];
    daemon.resumeFailures = 2;
    await createCodexSurface("cx-retry", RETRY_THREAD);
    const act = await api("POST", "/artifacts/cx-retry/actions", { action: "go", data: {} });
    assert.equal(act.status, 201);
    await waitFor(() => daemon.turnStarts.length === 1, 15000, "wake after retries");
    assert.equal(daemon.resumeCalls.length, 3, "two failures + one success");
    await waitFor(async () => (await pendingCount("cx-retry")) === 0, 5000, "inbox drained");
  });

  await test("dead session WITHOUT project consent stays in the inbox", async () => {
    daemon.turnStarts = [];
    daemon.resumeCalls = [];
    await createCodexSurface("cx-nocons", NOCONSENT_THREAD, noConsentRoot);
    const act = await api("POST", "/artifacts/cx-nocons/actions", { action: "x", data: {} });
    assert.equal(act.status, 201);
    await sleep(1000);
    assert.equal(daemon.resumeCalls.length, 0, "no resume without consent");
    assert.equal(daemon.turnStarts.length, 0, "no wake without consent");
    assert.equal(await pendingCount("cx-nocons"), 1, "action waits in the inbox");
  });

  await test("session open in an unreachable TUI (live pid) is never woken", async () => {
    daemon.turnStarts = [];
    daemon.resumeCalls = [];
    const reg = await api("POST", "/codex/sessions/register", {
      kind: "codex",
      session_id: TUI_THREAD,
      pid: process.pid, // this very test process: alive for sure
      cwd: projectRoot,
    });
    assert.equal(reg.status, 204);
    await createCodexSurface("cx-tui", TUI_THREAD);
    const act = await api("POST", "/artifacts/cx-tui/actions", { action: "x", data: {} });
    assert.equal(act.status, 201);
    await sleep(1000);
    assert.equal(daemon.resumeCalls.length, 0, "no resume while the owning TUI lives");
    assert.equal(daemon.turnStarts.length, 0, "no wake while the owning TUI lives");
    assert.equal(await pendingCount("cx-tui"), 1, "action waits in the inbox");
  });

  await test("an explicit binding outranks the codex layer", async () => {
    daemon.turnStarts = [];
    const captureOut = path.join(dataDir, "bind-capture.json");
    await createCodexSurface("cx-bound", LIVE_THREAD);
    const bind = await api("POST", "/artifacts/cx-bound/bindings", {
      action_pattern: "*",
      run: `node -e "require('fs').writeFileSync(process.argv[1], require('fs').readFileSync(0, 'utf8'))" "${captureOut}"`,
    });
    assert.equal(bind.status, 201);
    const act = await api("POST", "/artifacts/cx-bound/actions", { action: "z", data: {} });
    assert.equal(act.status, 201);
    await waitFor(() => fs.existsSync(captureOut), 10000, "binding to run");
    await sleep(500);
    assert.equal(daemon.turnStarts.length, 0, "codex layer suppressed by the explicit binding");
  });

  await test("device-plane callers cannot plant an agent_session link", async () => {
    // The content plane is the device plane: same app, role forced to
    // `device` even over loopback. A device-authored create may succeed, but
    // its agent_session must be ignored.
    const contentCall = makeClient(CONTENT_BASE);
    const res = await contentCall("POST", "/artifacts", {
      body: {
        id: "cx-device",
        title: "Device made",
        mime: "text/html",
        content: "<p>d</p>",
        project_root: projectRoot,
        agent_session: { kind: "codex", session_id: LIVE_THREAD },
      },
    });
    assert.equal(res.status, 201, "device create allowed");
    daemon.turnStarts = [];
    await api("POST", "/artifacts/cx-device/actions", { action: "x", data: {} });
    await sleep(800);
    assert.equal(daemon.turnStarts.length, 0, "no codex delivery for a device-planted session");
    assert.equal(await pendingCount("cx-device"), 1, "action stays in the inbox");
  });

  await test("CLI stamps CODEX_THREAD_ID automatically on create", async () => {
    daemon.loadedThreads.add(CLI_THREAD);
    daemon.turnStarts = [];
    const tsxCli = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
    const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [tsxCli, "bin/surface.ts", "create", "CLI codex surface", "--id", "cx-cli", "--content", "<p>hi</p>", "--mime", "text/html"], {
        cwd: REPO_ROOT,
        env: { ...process.env, SURFACE_URL: BASE, CODEX_THREAD_ID: CLI_THREAD },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      child.on("exit", (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(out.code, 0, `CLI create succeeded: ${out.stderr}`);
    const act = await api("POST", "/artifacts/cx-cli/actions", { action: "ping", data: {} });
    assert.equal(act.status, 201);
    await waitFor(() => daemon.turnStarts.length === 1, 10000, "delivery to the env-captured thread");
    assert.equal(daemon.turnStarts[0].threadId, CLI_THREAD);
    const read = await api("GET", "/artifacts/cx-cli");
    const meta = typeof read.json.artifact.metadata === "string" ? JSON.parse(read.json.artifact.metadata) : read.json.artifact.metadata;
    assert.equal(meta.agent, "codex", "display label defaults to the captured kind");
  });

  await test("surface codex setup installs the hook non-destructively; --remove-hook removes only ours", async () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "sfcx-home-"));
    // Pre-existing foreign hook that must survive untouched.
    const foreign = { type: "command", command: "python3 /tmp/other.py" };
    fs.writeFileSync(path.join(codexHome, "hooks.json"), JSON.stringify({
      description: "user file",
      hooks: { SessionStart: [{ hooks: [foreign] }], PreToolUse: [{ matcher: "^Bash$", hooks: [foreign] }] },
    }, null, 2));
    // Fake codex binary: new enough version, daemon start succeeds.
    const fakeCodex = path.join(codexHome, "codex");
    fs.writeFileSync(fakeCodex, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli 0.199.0"; exit 0; fi
echo '{"status":"alreadyRunning"}'
`);
    fs.chmodSync(fakeCodex, 0o755);

    const runCli = (args: string[]) => new Promise<{ code: number | null; out: string }>((resolve) => {
      const tsxCli = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
      const child = spawn(process.execPath, [tsxCli, "bin/surface.ts", ...args], {
        cwd: REPO_ROOT,
        env: { ...process.env, SURFACE_URL: BASE, CODEX_HOME: codexHome, SURFACE_CODEX_BIN: fakeCodex },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { out += d; });
      child.on("exit", (code) => resolve({ code, out }));
    });

    const setup = await runCli(["codex", "setup"]);
    assert.equal(setup.code, 0, `setup ok: ${setup.out}`);
    let file = JSON.parse(fs.readFileSync(path.join(codexHome, "hooks.json"), "utf8"));
    assert.equal(file.description, "user file", "top-level fields preserved");
    assert.equal(file.hooks.PreToolUse[0].hooks[0].command, foreign.command, "foreign event untouched");
    assert.equal(file.hooks.SessionStart.length, 2, "our group appended");
    assert.ok(JSON.stringify(file.hooks.SessionStart).includes("surface codex hook"), "our hook present");

    const again = await runCli(["codex", "setup"]);
    assert.equal(again.code, 0);
    file = JSON.parse(fs.readFileSync(path.join(codexHome, "hooks.json"), "utf8"));
    assert.equal(file.hooks.SessionStart.length, 2, "setup is idempotent");

    const remove = await runCli(["codex", "setup", "--remove-hook"]);
    assert.equal(remove.code, 0);
    file = JSON.parse(fs.readFileSync(path.join(codexHome, "hooks.json"), "utf8"));
    assert.ok(!JSON.stringify(file).includes("surface codex hook"), "our hook removed");
    assert.equal(file.hooks.SessionStart[0].hooks[0].command, foreign.command, "foreign SessionStart hook kept");
    cleanupDir(codexHome);
  });

  await test("surface codex hook registers the session from the stdin payload", async () => {
    const before = (await api("GET", "/codex/status")).json.registered_sessions;
    const tsxCli = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
    const hookSession = "019f0000-0000-7000-8000-00000000000a";
    const result = await new Promise<{ code: number | null }>((resolve) => {
      const child = spawn(process.execPath, [tsxCli, "bin/surface.ts", "codex", "hook"], {
        cwd: REPO_ROOT,
        env: { ...process.env, SURFACE_URL: BASE },
        stdio: ["pipe", "ignore", "ignore"],
      });
      child.stdin.write(JSON.stringify({ session_id: hookSession, cwd: projectRoot, transcript_path: "/tmp/rollout.jsonl", hook_event_name: "SessionStart" }));
      child.stdin.end();
      child.on("exit", (code) => resolve({ code }));
    });
    assert.equal(result.code, 0, "hook exits 0");
    const after = (await api("GET", "/codex/status")).json.registered_sessions;
    assert.equal(after, before + 1, "session registered");
  });

  await test("a live waiter outranks the codex layer", async () => {
    daemon.turnStarts = [];
    const ac = new AbortController();
    const streamPromise = fetch(`${BASE}/stream?wait_for=cx-live`, { signal: ac.signal }).catch(() => {});
    try {
      await sleep(500);
      await api("POST", "/artifacts/cx-live/actions", { action: "w", data: {} });
      await sleep(800);
      assert.equal(daemon.turnStarts.length, 0, "codex layer suppressed while a waiter is connected");
    } finally {
      ac.abort();
      await streamPromise;
    }
  });

  console.log("\nCodex bridge tests passed\n");
}

main()
  .then(async () => { await cleanup(); process.exit(0); })
  .catch(async (err) => { console.error(err); await cleanup(); process.exit(1); });

async function cleanup() {
  await killServer(server, PORT).catch(() => {});
  await daemon?.close().catch(() => {});
  cleanupDir(dataDir);
  cleanupDir(sockDir);
  cleanupDir(projectRoot);
  cleanupDir(noConsentRoot);
}
