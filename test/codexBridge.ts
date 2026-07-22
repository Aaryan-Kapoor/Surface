import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { recoverCodexActions } from "../server/actionsStore.js";
import { cleanupDir, freePort, isolatedPorts, killServer, makeClient, sleep, spawnServer, tmpDir, waitForReady, REPO_ROOT } from "./helpers.js";

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
  approvalBeforeStartResponse = false;
  autoCompleteTurns = true;
  resumeDelayMs = 0;
  activeResumes = 0;
  maxConcurrentResumes = 0;
  lastTurnIdByThread = new Map<string, string>();
  private nextServerRequestId = 1000;

  constructor(public listenTarget: string | number) {
    this.server = http.createServer();
    this.wss = new WebSocketServer({ server: this.server, perMessageDeflate: false });
    this.wss.on("connection", (ws) => {
      this.sockets.add(ws);
      ws.on("close", () => this.sockets.delete(ws));
      ws.on("message", (data) => this.onMessage(ws, JSON.parse(data.toString())));
    });
  }

  listen(): Promise<void> {
    return new Promise((resolve) => typeof this.listenTarget === "number"
      ? this.server.listen(this.listenTarget, "127.0.0.1", resolve as () => void)
      : this.server.listen(this.listenTarget, resolve as () => void));
  }

  private send(ws: WebSocket, msg: unknown): void {
    ws.send(JSON.stringify(msg));
  }

  broadcast(method: string, params: unknown): void {
    for (const ws of this.sockets) this.send(ws, { method, params });
  }

  // Server → client request to every client; responses land in approvalResponses.
  // Uses the real id of the thread's latest turn, like the actual app-server.
  requestApproval(threadId: string, method = "item/commandExecution/requestApproval"): void {
    const id = this.nextServerRequestId++;
    const turnId = this.lastTurnIdByThread.get(threadId) || "turn-x";
    const params = method.startsWith("item/")
      ? { threadId, turnId, itemId: "exec-1", command: "touch /tmp/x", cwd: "/tmp" }
      : { conversationId: threadId, callId: "call-1", command: ["touch", "/tmp/x"], cwd: "/tmp", parsedCmd: [] };
    for (const ws of this.sockets) {
      this.send(ws, { id, method, params });
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
        this.activeResumes++;
        this.maxConcurrentResumes = Math.max(this.maxConcurrentResumes, this.activeResumes);
        const finish = () => {
          this.activeResumes--;
          if (this.resumeFailures > 0) {
            this.resumeFailures--;
            this.send(ws, { id: msg.id, error: { code: -32600, message: `no rollout found for thread id ${threadId}` } });
            return;
          }
          this.loadedThreads.add(threadId);
          this.send(ws, { id: msg.id, result: { thread: { id: threadId } } });
        };
        if (this.resumeDelayMs) setTimeout(finish, this.resumeDelayMs);
        else finish();
        return;
      }
      case "turn/start": {
        const threadId = msg.params.threadId;
        const text = msg.params.input?.[0]?.text || "";
        this.turnStarts.push({ threadId, text });
        const turnId = `turn-${this.turnStarts.length}`;
        this.lastTurnIdByThread.set(threadId, turnId);
        if (this.approvalBeforeStartResponse) {
          this.approvalBeforeStartResponse = false;
          this.requestApproval(threadId);
        }
        this.send(ws, { id: msg.id, result: { turn: { id: turnId, status: "inProgress" } } });
        this.broadcast("turn/started", { threadId, turn: { id: turnId } });
        if (this.autoCompleteTurns) {
          setTimeout(() => this.completeTurn(threadId), 150);
        }
        return;
      }
      default:
        this.send(ws, { id: msg.id, error: { code: -32601, message: `mock: unhandled ${msg.method}` } });
    }
  }

  completeTurn(threadId: string, status: "completed" | "failed" | "interrupted" = "completed"): void {
    const turnId = this.lastTurnIdByThread.get(threadId) || "turn-done";
    this.broadcast("turn/completed", { threadId, turn: { id: turnId, status } });
  }

  close(): Promise<void> {
    for (const ws of this.sockets) ws.terminate();
    this.wss.close();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  dropConnections(): void {
    for (const ws of this.sockets) ws.terminate();
  }
}

// ── harness ──

let PORT = 0;
let BASE = "";
let CONTENT_BASE = "";
let server: ChildProcess | null = null;
let liveTui: ChildProcess | null = null;
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
const STALE_TUI_THREAD = "019f0000-0000-7000-8000-000000000007";
const SHARED_THREAD = "019f0000-0000-7000-8000-000000000008";
const UNREGISTERED_THREAD = "019f0000-0000-7000-8000-000000000009";
const STALE_LOADED_THREAD = "019f0000-0000-7000-8000-00000000000b";

async function api(method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await call(method, p, { body });
  return { status: res.status, json: res.body };
}

async function createCodexSurface(id: string, threadId: string, root = projectRoot, register = true): Promise<void> {
  if (register) {
    const registered = await api("POST", "/codex/sessions/register", {
      kind: "codex",
      session_id: threadId,
      cwd: root,
    });
    assert.equal(registered.status, 204, `session ${threadId} registered`);
  }
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

  const daemonPort = process.platform === "win32" ? await freePort() : 0;
  daemon = new MockDaemon(process.platform === "win32" ? daemonPort : sockPath);
  await daemon.listen();

  server = spawnServer(PORT, dataDir, {
    ...(process.platform === "win32"
      ? { SURFACE_CODEX_ENDPOINT: `ws://127.0.0.1:${daemonPort}` }
      : { SURFACE_CODEX_SOCKET: sockPath }),
    SURFACE_CODEX_AUTOSTART: "0",
  }, ports.contentPort);
  await waitForReady(BASE, "/artifacts");

  if (process.platform === "win32") {
    liveTui = spawn(process.execPath, ["-e", "setTimeout(()=>{},120000)"], { stdio: "ignore" });
  } else {
    const liveCodexBin = path.join(dataDir, "codex-live-stand-in");
    fs.copyFileSync("/bin/sleep", liveCodexBin);
    fs.chmodSync(liveCodexBin, 0o755);
    liveTui = spawn(liveCodexBin, ["120"], { stdio: "ignore" });
  }
  const liveRegistration = await api("POST", "/codex/sessions/register", {
    kind: "codex",
    session_id: LIVE_THREAD,
    pid: liveTui.pid,
    cwd: projectRoot,
  });
  assert.equal(liveRegistration.status, 204, "live session registered");

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

  await test("an approval arriving before the turn/start response is still declined", async () => {
    daemon.autoCompleteTurns = false;
    daemon.turnStarts = [];
    daemon.approvalResponses = [];
    daemon.approvalBeforeStartResponse = true;
    const act = await api("POST", "/artifacts/cx-dead/actions", { action: "early-approval", data: {} });
    assert.equal(act.status, 201);
    await waitFor(() => daemon.approvalResponses.length === 1, 5000, "early approval denial");
    assert.equal(daemon.approvalResponses[0].result?.decision, "decline");
    daemon.completeTurn(DEAD_THREAD);
    daemon.autoCompleteTurns = true;
  });

  await test("follow-up turns on a bridge-resumed thread stay headless (approvals still declined)", async () => {
    // DEAD_THREAD is now loaded because the bridge resumed it — but nobody is
    // attached, so approvals on further wake turns must still be declined.
    daemon.autoCompleteTurns = false;
    daemon.turnStarts = [];
    daemon.approvalResponses = [];
    const act = await api("POST", "/artifacts/cx-dead/actions", { action: "third", data: {} });
    assert.equal(act.status, 201);
    await waitFor(() => daemon.turnStarts.length === 1, 10000, "third wake turn");
    daemon.requestApproval(DEAD_THREAD);
    await waitFor(() => daemon.approvalResponses.length === 1, 5000, "decline response");
    assert.equal(daemon.approvalResponses[0].result?.decision, "decline");
    daemon.completeTurn(DEAD_THREAD);
    daemon.autoCompleteTurns = true;
  });

  await test("legacy + permissions approval methods get shape-correct denials on bridge-owned threads", async () => {
    daemon.autoCompleteTurns = false;
    daemon.turnStarts = [];
    daemon.approvalResponses = [];
    daemon.loadedThreads.delete(DEAD_THREAD);
    const act = await api("POST", "/artifacts/cx-dead/actions", { action: "legacy", data: {} });
    assert.equal(act.status, 201);
    await waitFor(() => daemon.turnStarts.length === 1, 10000, "wake turn");
    daemon.requestApproval(DEAD_THREAD, "execCommandApproval");
    await waitFor(() => daemon.approvalResponses.length === 1, 5000, "legacy denial");
    assert.equal(daemon.approvalResponses[0].result?.decision, "denied", "legacy shape uses 'denied'");
    daemon.requestApproval(DEAD_THREAD, "item/permissions/requestApproval");
    await waitFor(() => daemon.approvalResponses.length === 2, 5000, "permissions denial");
    assert.deepEqual(daemon.approvalResponses[1].result, { permissions: {}, scope: "turn" }, "permissions denial grants nothing");
    daemon.completeTurn(DEAD_THREAD);
    daemon.autoCompleteTurns = true;
  });

  await test("revoking consent stops wakes on a bridge-resumed (still loaded) thread", async () => {
    // DEAD_THREAD is loaded only because the bridge resumed it. Flip the
    // project consent off: further clicks must hold, not start turns.
    daemon.turnStarts = [];
    fs.writeFileSync(path.join(projectRoot, ".surface", "config.json"), JSON.stringify({ bindings: { enabled: false } }));
    const act = await api("POST", "/artifacts/cx-dead/actions", { action: "revoked", data: {} });
    assert.equal(act.status, 201);
    await sleep(1000);
    assert.equal(daemon.turnStarts.length, 0, "no turn without consent, even though the thread is loaded");
    assert.ok((await pendingCount("cx-dead")) >= 1, "action holds in the inbox");
    fs.writeFileSync(path.join(projectRoot, ".surface", "config.json"), JSON.stringify({ bindings: { enabled: true } }));
    // Drain the held actions so later tests start clean.
    const rows = (await api("GET", "/artifacts/cx-dead/actions")).json;
    for (const row of rows) await api("POST", `/actions/${row.id}/ack`, {});
  });

  await test("an unrelated turn completing on the thread does NOT release the coalescing slot", async () => {
    daemon.autoCompleteTurns = false;
    daemon.turnStarts = [];
    const act = await api("POST", "/artifacts/cx-live/actions", { action: "q1", data: {} });
    assert.equal(act.status, 201);
    await waitFor(() => daemon.turnStarts.length === 1, 10000, "delivered turn");
    await api("POST", "/artifacts/cx-live/actions", { action: "q2", data: {} });
    // A DIFFERENT (user-owned) turn completes on the same thread.
    daemon.broadcast("turn/completed", { threadId: LIVE_THREAD, turn: { id: "user-turn-999", status: "completed" } });
    await sleep(700);
    assert.equal(daemon.turnStarts.length, 1, "slot stays held for our own turn");
    daemon.completeTurn(LIVE_THREAD); // completes OUR turn (real id)
    await waitFor(() => daemon.turnStarts.length === 2, 10000, "coalesced follow-up after our turn ends");
    daemon.completeTurn(LIVE_THREAD);
    daemon.autoCompleteTurns = true;
    await waitFor(async () => (await pendingCount("cx-live")) === 0, 5000, "drained");
  });

  await test("an interrupted headless turn returns its batch; an attended interrupt keeps it acked", async () => {
    // Headless: cx-dead's thread is bridge-owned.
    daemon.autoCompleteTurns = false;
    daemon.turnStarts = [];
    let act = await api("POST", "/artifacts/cx-dead/actions", { action: "int-headless", data: {} });
    assert.equal(act.status, 201);
    await waitFor(() => daemon.turnStarts.length === 1, 10000, "headless turn");
    await waitFor(async () => (await pendingCount("cx-dead")) === 0, 5000, "acked");
    daemon.completeTurn(DEAD_THREAD, "interrupted");
    await waitFor(async () => (await pendingCount("cx-dead")) === 1, 5000, "headless interrupt restores the batch");
    const rows = (await api("GET", "/artifacts/cx-dead/actions")).json;
    for (const row of rows) await api("POST", `/actions/${row.id}/ack`, {});

    // Attended: cx-live's thread is genuinely loaded (never bridge-resumed).
    daemon.turnStarts = [];
    act = await api("POST", "/artifacts/cx-live/actions", { action: "int-live", data: {} });
    assert.equal(act.status, 201);
    await waitFor(() => daemon.turnStarts.length === 1, 10000, "attended turn");
    daemon.completeTurn(LIVE_THREAD, "interrupted");
    await sleep(700);
    assert.equal(await pendingCount("cx-live"), 0, "attended interrupt keeps the batch acked (the user saw it)");
    daemon.autoCompleteTurns = true;
  });

  await test("a dropped codex connection restores a headless delivery lease", async () => {
    daemon.autoCompleteTurns = false;
    daemon.turnStarts = [];
    const act = await api("POST", "/artifacts/cx-dead/actions", { action: "disconnect", data: {} });
    assert.equal(act.status, 201);
    await waitFor(() => daemon.turnStarts.length === 1, 10000, "headless turn before disconnect");
    await waitFor(async () => (await pendingCount("cx-dead")) === 0, 5000, "batch leased out of pending");
    daemon.dropConnections();
    await waitFor(async () => (await pendingCount("cx-dead")) === 1, 5000, "lease restored after disconnect");
    const rows = (await api("GET", "/artifacts/cx-dead/actions")).json;
    for (const row of rows) await api("POST", `/actions/${row.id}/ack`, {});
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

  await test("daemon-loaded without a live TUI still requires wake consent", async () => {
    daemon.turnStarts = [];
    daemon.resumeCalls = [];
    await createCodexSurface("cx-stale-loaded", STALE_LOADED_THREAD);
    daemon.loadedThreads.add(STALE_LOADED_THREAD);
    fs.writeFileSync(path.join(projectRoot, ".surface", "config.json"), JSON.stringify({ bindings: { enabled: false } }));
    const act = await api("POST", "/artifacts/cx-stale-loaded/actions", { action: "x", data: {} });
    assert.equal(act.status, 201);
    await sleep(800);
    assert.equal(daemon.turnStarts.length, 0, "stale loaded thread did not bypass consent");
    assert.equal(await pendingCount("cx-stale-loaded"), 1, "action remains durable");
    fs.writeFileSync(path.join(projectRoot, ".surface", "config.json"), JSON.stringify({ bindings: { enabled: true } }));
    const rows = (await api("GET", "/artifacts/cx-stale-loaded/actions")).json;
    for (const row of rows) await api("POST", `/actions/${row.id}/ack`, {});
  });

  await test("two surfaces sharing a dead thread serialize resume and delivery", async () => {
    daemon.turnStarts = [];
    daemon.resumeCalls = [];
    daemon.maxConcurrentResumes = 0;
    daemon.resumeDelayMs = 150;
    daemon.loadedThreads.delete(SHARED_THREAD);
    await createCodexSurface("cx-shared-a", SHARED_THREAD);
    await createCodexSurface("cx-shared-b", SHARED_THREAD);
    await Promise.all([
      api("POST", "/artifacts/cx-shared-a/actions", { action: "a", data: {} }),
      api("POST", "/artifacts/cx-shared-b/actions", { action: "b", data: {} }),
    ]);
    await waitFor(() => daemon.turnStarts.length === 2, 10000, "both serialized turns");
    assert.equal(daemon.maxConcurrentResumes, 1, "at most one resume in flight for the thread");
    assert.deepEqual(daemon.resumeCalls, [SHARED_THREAD], "the second surface observes the first resume");
    await waitFor(async () =>
      (await pendingCount("cx-shared-a")) === 0 && (await pendingCount("cx-shared-b")) === 0,
    5000, "shared-thread batches drained");
    daemon.resumeDelayMs = 0;
  });

  await test("only the latest session registered by a live TUI is held", async () => {
    daemon.turnStarts = [];
    daemon.resumeCalls = [];
    // The liveness guard also checks the process *name* (pid-reuse defense),
    // so stand in with a live process whose comm matches /codex/i.
    let fakeTui: ChildProcess;
    if (process.platform === "win32") {
      fakeTui = spawn(process.execPath, ["-e", "setTimeout(()=>{},120000)"], { stdio: "ignore" });
    } else {
      const fakeCodexBin = path.join(dataDir, "codex-stand-in");
      fs.copyFileSync("/bin/sleep", fakeCodexBin);
      fs.chmodSync(fakeCodexBin, 0o755);
      fakeTui = spawn(fakeCodexBin, ["120"], { stdio: "ignore" });
    }
    try {
      const staleReg = await api("POST", "/codex/sessions/register", {
        kind: "codex",
        session_id: STALE_TUI_THREAD,
        pid: fakeTui.pid,
        cwd: projectRoot,
      });
      assert.equal(staleReg.status, 204);
      const currentReg = await api("POST", "/codex/sessions/register", {
        kind: "codex",
        session_id: TUI_THREAD,
        pid: fakeTui.pid,
        cwd: projectRoot,
      });
      assert.equal(currentReg.status, 204);

      // Reproduce the review finding deterministically: SQLite's datetime()
      // timestamps have only second precision, so both registrations can tie.
      const testDb = new Database(path.join(dataDir, "db.sqlite"));
      testDb.prepare(
        `UPDATE agent_sessions SET created_at = datetime('now'), last_seen_at = datetime('now')
         WHERE session_id IN (?, ?)`,
      ).run(STALE_TUI_THREAD, TUI_THREAD);
      testDb.close();

      await createCodexSurface("cx-stale-tui", STALE_TUI_THREAD, projectRoot, false);
      await createCodexSurface("cx-tui", TUI_THREAD, projectRoot, false);

      const staleAction = await api("POST", "/artifacts/cx-stale-tui/actions", { action: "x", data: {} });
      assert.equal(staleAction.status, 201);
      await waitFor(() => daemon.turnStarts.length === 1, 10000, "older TUI session to wake");
      assert.deepEqual(daemon.resumeCalls, [STALE_TUI_THREAD], "older session is no longer owned by the TUI");
      await waitFor(async () => (await pendingCount("cx-stale-tui")) === 0, 5000, "older session drained");

      daemon.turnStarts = [];
      daemon.resumeCalls = [];
      const currentAction = await api("POST", "/artifacts/cx-tui/actions", { action: "y", data: {} });
      assert.equal(currentAction.status, 201);
      await sleep(1000);
      assert.equal(daemon.resumeCalls.length, 0, "current session is not resumed while its TUI lives");
      assert.equal(daemon.turnStarts.length, 0, "current session is not woken while its TUI lives");
      assert.equal(await pendingCount("cx-tui"), 1, "current session action waits in the inbox");
    } finally {
      fakeTui.kill();
    }
  });

  await test("a dead pid whose session was registered does not hold the wake", async () => {
    // After the fake TUI dies, the same surface's next click must wake the
    // thread (pid liveness, not registration, is what holds).
    daemon.turnStarts = [];
    daemon.resumeCalls = [];
    await sleep(200); // let the killed stand-in reap
    const act = await api("POST", "/artifacts/cx-tui/actions", { action: "y", data: {} });
    assert.equal(act.status, 201);
    await waitFor(() => daemon.turnStarts.length === 1, 10000, "wake after the TUI died");
    assert.deepEqual(daemon.resumeCalls, [TUI_THREAD]);
    await waitFor(async () => (await pendingCount("cx-tui")) === 0, 5000, "drained");
  });

  await test("an explicit binding outranks the codex layer", async () => {
    daemon.turnStarts = [];
    const captureOut = path.join(dataDir, "bind-capture.json");
    const captureArg = captureOut.replace(/\\/g, "/");
    await createCodexSurface("cx-bound", LIVE_THREAD);
    const bind = await api("POST", "/artifacts/cx-bound/bindings", {
      action_pattern: "*",
      run: `node -e "require('fs').writeFileSync(process.argv[1], require('fs').readFileSync(0, 'utf8'))" "${captureArg}"`,
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

  await test("an unregistered system session cannot plant a codex flowback link", async () => {
    daemon.turnStarts = [];
    daemon.resumeCalls = [];
    await createCodexSurface("cx-unregistered", UNREGISTERED_THREAD, projectRoot, false);
    const act = await api("POST", "/artifacts/cx-unregistered/actions", { action: "x", data: {} });
    assert.equal(act.status, 201);
    await sleep(800);
    assert.equal(daemon.turnStarts.length, 0, "no delivery without SessionStart registration");
    assert.equal(daemon.resumeCalls.length, 0, "no unsafe resume without liveness registration");
    assert.equal(await pendingCount("cx-unregistered"), 1, "action stays in the inbox");
  });

  await test("startup reconciliation restores durable delivery leases", async () => {
    const testDb = new Database(path.join(dataDir, "db.sqlite"));
    const row = testDb.prepare(
      `SELECT id FROM surface_actions WHERE surface_id = ? AND status = 'pending' LIMIT 1`,
    ).get("cx-unregistered") as { id: string };
    testDb.transaction(() => {
      testDb.prepare(`UPDATE surface_actions SET status = 'delivering' WHERE id = ?`).run(row.id);
      testDb.prepare(
        `INSERT INTO codex_action_deliveries (action_id, surface_id, thread_id) VALUES (?, ?, ?)`,
      ).run(row.id, "cx-unregistered", UNREGISTERED_THREAD);
    })();
    assert.equal(recoverCodexActions(testDb), 1, "one interrupted lease recovered");
    testDb.close();
    assert.equal(await pendingCount("cx-unregistered"), 1, "recovered action is pending again");
  });

  await test("CLI stamps CODEX_THREAD_ID automatically on create", async () => {
    daemon.loadedThreads.add(CLI_THREAD);
    daemon.turnStarts = [];
    const registered = await api("POST", "/codex/sessions/register", {
      kind: "codex",
      session_id: CLI_THREAD,
      pid: liveTui?.pid,
      cwd: projectRoot,
    });
    assert.equal(registered.status, 204, "CLI thread registered like SessionStart");
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

  if (process.platform !== "win32") await test("surface codex setup installs the hook non-destructively; --remove-hook removes only ours", async () => {
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

    const runCli = (args: string[], codexBin = fakeCodex) => new Promise<{ code: number | null; out: string }>((resolve) => {
      const tsxCli = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
      const child = spawn(process.execPath, [tsxCli, "bin/surface.ts", ...args], {
        cwd: REPO_ROOT,
        env: { ...process.env, SURFACE_URL: BASE, CODEX_HOME: codexHome, SURFACE_CODEX_BIN: codexBin },
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

    await runCli(["codex", "setup"]);
    const removeWithoutCodex = await runCli(
      ["codex", "setup", "--remove-hook"],
      path.join(codexHome, "missing-codex"),
    );
    assert.equal(removeWithoutCodex.code, 0, "hook removal does not require an installed codex binary");
    file = JSON.parse(fs.readFileSync(path.join(codexHome, "hooks.json"), "utf8"));
    assert.ok(!JSON.stringify(file).includes("surface codex hook"), "hook removed without codex");
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

  await test("a failed handling turn returns the batch to the inbox", async () => {
    daemon.autoCompleteTurns = false;
    daemon.turnStarts = [];
    const act = await api("POST", "/artifacts/cx-live/actions", { action: "doomed", data: {} });
    assert.equal(act.status, 201);
    await waitFor(() => daemon.turnStarts.length === 1, 10000, "turn/start");
    await waitFor(async () => (await pendingCount("cx-live")) === 0, 5000, "optimistically acked");
    daemon.completeTurn(LIVE_THREAD, "failed");
    await waitFor(async () => (await pendingCount("cx-live")) === 1, 5000, "batch back in the inbox after the failed turn");
    // Drain so later tests start clean: complete-turn cycle with a fresh delivery.
    daemon.autoCompleteTurns = true;
    // The failed batch does NOT auto-retry (no loop): it sits in the inbox.
    await sleep(600);
    assert.equal(daemon.turnStarts.length, 1, "no automatic redelivery loop");
    const pendingRows = (await api("GET", "/artifacts/cx-live/actions")).json;
    for (const row of pendingRows) await api("POST", `/actions/${row.id}/ack`, {});
  });

  await test("SessionStart clears stale bridge ownership when the user reattaches", async () => {
    daemon.autoCompleteTurns = true;
    daemon.turnStarts = [];
    daemon.approvalResponses = [];
    const registered = await api("POST", "/codex/sessions/register", {
      kind: "codex",
      session_id: DEAD_THREAD,
      pid: liveTui?.pid,
      cwd: projectRoot,
    });
    assert.equal(registered.status, 204);
    fs.writeFileSync(path.join(projectRoot, ".surface", "config.json"), JSON.stringify({ bindings: { enabled: false } }));
    const act = await api("POST", "/artifacts/cx-dead/actions", { action: "reattached", data: {} });
    assert.equal(act.status, 201);
    await waitFor(() => daemon.turnStarts.length === 1, 10000, "live delivery after reattach");
    assert.equal(daemon.turnStarts[0].threadId, DEAD_THREAD);
    fs.writeFileSync(path.join(projectRoot, ".surface", "config.json"), JSON.stringify({ bindings: { enabled: true } }));
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
  liveTui?.kill();
  await killServer(server, PORT).catch(() => {});
  await daemon?.close().catch(() => {});
  cleanupDir(dataDir);
  cleanupDir(sockDir);
  cleanupDir(projectRoot);
  cleanupDir(noConsentRoot);
}
