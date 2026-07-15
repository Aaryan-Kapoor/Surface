import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import WebSocket from "ws";
import type Database from "better-sqlite3";
import { getDb } from "./db.js";
import { getArtifact } from "./artifacts.js";
import { getPendingActions, ackAction } from "./actionsStore.js";
import { broadcastGlobal, broadcastToSurface, hasWaiter } from "./sse.js";
import { getAgentLink, getAgentSession, sessionOpenInProcess } from "./agentSessions.js";

// Codex flowback layer (docs/interaction/codex.md): route surface actions back
// into the Codex session that created the surface, through the codex
// app-server daemon (JSON-RPC over a WebSocket on a private unix socket).
//
//   thread loaded in the daemon  → turn/start now; the user's attached TUI
//                                  renders the action batch as a native turn.
//   session open in a plain TUI  → hold (inbox); injecting via the daemon
//                                  would dual-write the rollout file.
//   session dead                 → consent-gated headless wake: thread/resume
//                                  from disk + turn/start. The transcript
//                                  lands in the same thread, so a later
//                                  `codex resume` shows the whole exchange.
//
// Safety invariants:
//   - Surface NEVER approves anything. Approval requests are declined for
//     turns this bridge started headlessly, and ignored (left to the user's
//     own client) for every other turn.
//   - A headless wake needs the same recorded project consent as a wake
//     binding (projectAllowsBindings). Live in-daemon delivery is the
//     waiter-equivalent: the agent is attached and listening.

const MIN_CODEX_VERSION = [0, 144, 0] as const;
const REQUEST_TIMEOUT_MS = 30_000;
const RESUME_RETRIES = 5;
const RESUME_RETRY_DELAY_MS = 1_000;
// Failsafe so a lost turn/completed can't wedge a surface's single-flight slot.
const TURN_WATCH_MAX_MS = 30 * 60_000;

interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string };
}

export interface CodexBridgeStatus {
  enabled: boolean;
  socket_path: string;
  connected: boolean;
  daemon_version: string | null;
  last_error: string | null;
  deliveries_ok: number;
  deliveries_failed: number;
}

function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

export function codexSocketPath(): string {
  return process.env.SURFACE_CODEX_SOCKET
    || path.join(codexHome(), "app-server-control", "app-server-control.sock");
}

function codexBin(): string {
  return process.env.SURFACE_CODEX_BIN || "codex";
}

function bridgeDisabled(): boolean {
  return process.env.SURFACE_CODEX_DISABLE === "1";
}

function autostartEnabled(): boolean {
  return process.env.SURFACE_CODEX_AUTOSTART !== "0";
}

function parseVersionFromUserAgent(userAgent: string): [number, number, number] | null {
  // e.g. "Codex Desktop/0.144.1 (Ubuntu 24.4.0; x86_64) …"
  const m = /\/(\d+)\.(\d+)\.(\d+)/.exec(userAgent || "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function versionOk(v: [number, number, number]): boolean {
  const [a, b, c] = v;
  const [x, y, z] = MIN_CODEX_VERSION;
  if (a !== x) return a > x;
  if (b !== y) return b > y;
  return c >= z;
}

// ── JSON-RPC connection ──

class CodexConnection {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private notificationHandlers = new Set<(msg: JsonRpcMessage) => void>();
  private serverRequestHandlers = new Set<(msg: JsonRpcMessage) => boolean>();
  daemonVersion: string | null = null;
  private connecting: Promise<void> | null = null;

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  onNotification(fn: (msg: JsonRpcMessage) => void): void {
    this.notificationHandlers.add(fn);
  }

  // Handlers return true when they responded to the server request.
  onServerRequest(fn: (msg: JsonRpcMessage) => boolean): void {
    this.serverRequestHandlers.add(fn);
  }

  async connect(socketPath: string): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect(socketPath).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private doConnect(socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // tungstenite rejects permessage-deflate offers on this socket.
      const ws = new WebSocket(`ws+unix:${socketPath}:/`, { perMessageDeflate: false, handshakeTimeout: 5_000 });
      let settled = false;
      ws.on("open", async () => {
        this.ws = ws;
        try {
          const init = await this.request("initialize", {
            clientInfo: { name: "surface", title: "Surface", version: "1" },
            capabilities: { experimentalApi: true },
          });
          const version = parseVersionFromUserAgent(init?.userAgent || "");
          if (!version || !versionOk(version)) {
            this.close();
            throw new Error(`codex app-server too old (need >= ${MIN_CODEX_VERSION.join(".")}): ${init?.userAgent || "unknown"}`);
          }
          this.daemonVersion = version.join(".");
          this.send({ method: "initialized", params: {} });
          settled = true;
          resolve();
        } catch (err) {
          settled = true;
          reject(err as Error);
        }
      });
      ws.on("message", (data) => this.onMessage(data.toString("utf8")));
      ws.on("error", (err) => {
        if (!settled) { settled = true; reject(err); }
      });
      ws.on("close", () => {
        if (this.ws === ws) this.ws = null;
        this.failAllPending(new Error("codex app-server connection closed"));
        if (!settled) { settled = true; reject(new Error("codex app-server connection closed during handshake")); }
      });
    });
  }

  private onMessage(text: string): void {
    let msg: JsonRpcMessage;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.id !== undefined && msg.method === undefined) {
      const entry = this.pending.get(msg.id as number);
      if (!entry) return;
      this.pending.delete(msg.id as number);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else entry.resolve(msg.result);
      return;
    }
    if (msg.method !== undefined && msg.id !== undefined) {
      // Server → client request (approvals, elicitations). First handler that
      // claims it responds; unclaimed requests are deliberately left for the
      // user's own attached client to answer.
      for (const fn of this.serverRequestHandlers) {
        try { if (fn(msg)) return; } catch {}
      }
      return;
    }
    if (msg.method !== undefined) {
      for (const fn of this.notificationHandlers) {
        try { fn(msg); } catch {}
      }
    }
  }

  private failAllPending(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  send(msg: JsonRpcMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("codex app-server not connected");
    this.ws.send(JSON.stringify(msg));
  }

  respond(id: number | string, result: unknown): void {
    try { this.send({ id, result } as JsonRpcMessage); } catch {}
  }

  request(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params: params as any });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err as Error);
      }
    });
  }

  close(): void {
    try { this.ws?.close(); } catch {}
    this.ws = null;
  }
}

// ── Bridge state ──

const connection = new CodexConnection();
let handlersInstalled = false;
let lastError: string | null = null;
let deliveriesOk = 0;
let deliveriesFailed = 0;

// Turns this bridge started on threads that were not previously loaded (i.e.
// nobody is attached): approval requests for these are declined, fail-closed.
const headlessTurnThreads = new Set<string>();
// Per-surface single-flight until the delivered turn completes.
const inFlight = new Set<string>();
const rerunRequested = new Set<string>();
// threadId → callbacks waiting for the current turn to end (several surfaces
// can share one creating thread).
const turnWatchers = new Map<string, Set<() => void>>();

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "execCommandApproval",
  "applyPatchApproval",
]);

function installHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  connection.onServerRequest((msg) => {
    if (!APPROVAL_METHODS.has(msg.method!)) return false;
    const threadId = msg.params?.threadId;
    if (threadId && headlessTurnThreads.has(threadId)) {
      // Fail closed: a headless wake must never gain privileges unattended.
      connection.respond(msg.id!, { decision: "decline" });
      return true;
    }
    return false; // someone's attached client will answer
  });
  connection.onNotification((msg) => {
    if (msg.method === "turn/completed" || msg.method === "thread/closed") {
      const threadId = msg.params?.threadId;
      if (!threadId) return;
      if (msg.method === "turn/completed") headlessTurnThreads.delete(threadId);
      const watchers = turnWatchers.get(threadId);
      if (watchers) {
        turnWatchers.delete(threadId);
        for (const done of watchers) done();
      }
    }
  });
}

async function ensureConnected(): Promise<void> {
  installHandlers();
  await connection.connect(codexSocketPath());
}

function daemonSocketExists(): boolean {
  try { return fs.existsSync(codexSocketPath()); } catch { return false; }
}

// `codex app-server daemon start` is idempotent ("alreadyRunning").
function startDaemon(): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(codexBin(), ["app-server", "daemon", "start"], { timeout: 20_000 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`failed to start codex app-server daemon: ${stderr || err.message}`));
      else resolve();
    });
  });
}

async function connectMaybeStarting(allowStart: boolean): Promise<void> {
  try {
    await ensureConnected();
    return;
  } catch (err) {
    if (!allowStart || !autostartEnabled()) throw err;
  }
  await startDaemon();
  await ensureConnected();
}

async function isThreadLoaded(threadId: string): Promise<boolean> {
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const res = await connection.request("thread/loaded/list", cursor ? { cursor } : {});
    const ids: string[] = res?.data || [];
    if (ids.includes(threadId)) return true;
    cursor = res?.nextCursor || null;
    if (!cursor) return false;
  }
  return false;
}

async function resumeThread(threadId: string): Promise<void> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < RESUME_RETRIES; attempt++) {
    try {
      await connection.request("thread/resume", { threadId, excludeTurns: true });
      return;
    } catch (err: any) {
      lastErr = err;
      // The rollout may not be flushed yet right after a session starts.
      if (!/no rollout found/i.test(err?.message || "")) break;
      await new Promise((r) => setTimeout(r, RESUME_RETRY_DELAY_MS));
    }
  }
  throw lastErr || new Error("thread/resume failed");
}

function buildTurnText(surfaceId: string, title: string, batch: Array<{ id: string; action: string; data: unknown; created_at: string }>): string {
  const payload = {
    type: "surface_action_batch",
    surface_id: surfaceId,
    surface_title: title,
    actions: batch,
  };
  return [
    `A user interacted with your surface "${title}" (${surfaceId}). Handle this action batch now, then update the surface so its state reflects reality (surface set/patch/reply). State is a claim, not an animation — only show progress you are actually making.`,
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
  ].join("\n");
}

function status(surfaceId: string, state: string, detail?: string | null): void {
  const event = { surface_id: surfaceId, state, detail: detail ?? null };
  broadcastGlobal("codex_bridge_status", event);
  broadcastToSurface(surfaceId, "codex_bridge_status", event);
}

// ── Ladder entry point ──
// Fire-and-forget from dispatchAction. `consent` is projectAllowsBindings():
// required for headless wakes, not for delivery to an already-loaded thread.
export function maybeDispatchCodex(surfaceId: string, consent: boolean): void {
  if (bridgeDisabled()) return;
  const db = getDb();
  const link = getAgentLink(db, surfaceId);
  if (!link || link.agent_kind !== "codex") return;
  if (inFlight.has(surfaceId)) {
    rerunRequested.add(surfaceId);
    return;
  }
  inFlight.add(surfaceId);
  void deliver(db, surfaceId, link.session_id, consent)
    .catch((err: any) => {
      deliveriesFailed++;
      lastError = err?.message || String(err);
      console.error(`[codex] delivery failed for ${surfaceId}: ${lastError}`);
      status(surfaceId, "failed", lastError);
    })
    .finally(() => {
      inFlight.delete(surfaceId);
      if (rerunRequested.delete(surfaceId)) {
        const stillPending = getPendingActions(getDb(), surfaceId);
        if (stillPending.length && !hasWaiter(surfaceId)) maybeDispatchCodex(surfaceId, consent);
      }
    });
}

async function deliver(db: Database.Database, surfaceId: string, threadId: string, consent: boolean): Promise<void> {
  const session = getAgentSession(db, threadId);

  // Fast local pre-checks before touching (or starting) the daemon.
  const daemonUp = daemonSocketExists();
  if (!daemonUp && session && sessionOpenInProcess(db, session)) {
    status(surfaceId, "held_live_tui", "session is open in a codex TUI that Surface cannot reach; actions stay in the inbox");
    return;
  }
  if (!daemonUp && !consent) {
    status(surfaceId, "held_no_consent", "waking a dead codex session needs recorded project consent (bindings.enabled)");
    return;
  }

  await connectMaybeStarting(consent);

  const loaded = await isThreadLoaded(threadId);
  if (!loaded) {
    if (session && sessionOpenInProcess(db, session)) {
      status(surfaceId, "held_live_tui", "session is open in a codex TUI that Surface cannot reach; actions stay in the inbox");
      return;
    }
    if (!consent) {
      status(surfaceId, "held_no_consent", "waking a dead codex session needs recorded project consent (bindings.enabled)");
      return;
    }
  }

  // Re-check: a waiter may have connected while we were connecting.
  if (hasWaiter(surfaceId)) return;
  const artifact = getArtifact(db, surfaceId);
  if (!artifact) return;
  const pending = getPendingActions(db, surfaceId);
  if (!pending.length) return;

  if (!loaded) {
    await resumeThread(threadId);
    headlessTurnThreads.add(threadId);
  }

  const batch = pending.map((a) => ({
    id: a.id,
    action: a.action,
    data: (() => { try { return JSON.parse(a.data); } catch { return a.data; } })(),
    created_at: a.created_at,
  }));

  try {
    await connection.request("turn/start", {
      threadId,
      input: [{ type: "text", text: buildTurnText(surfaceId, artifact.title, batch) }],
    });
  } catch (err) {
    headlessTurnThreads.delete(threadId);
    throw err;
  }

  // Delivered to the agent: ack, mirroring waiter/binding semantics.
  for (const a of pending) ackAction(db, a.id);
  broadcastGlobal("actions_acked", {
    surface_id: surfaceId,
    pending_actions: getPendingActions(db, surfaceId).length,
  });
  deliveriesOk++;
  lastError = null;
  status(surfaceId, loaded ? "delivered_live" : "delivered_wake");

  // Hold the single-flight slot until the turn ends so rapid clicks coalesce
  // into one follow-up batch instead of a pile of queued turns.
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      turnWatchers.get(threadId)?.delete(done);
      resolve();
    }, TURN_WATCH_MAX_MS);
    const done = () => { clearTimeout(timer); resolve(); };
    let watchers = turnWatchers.get(threadId);
    if (!watchers) turnWatchers.set(threadId, (watchers = new Set()));
    watchers.add(done);
  });
}

export function codexBridgeStatus(): CodexBridgeStatus {
  return {
    enabled: !bridgeDisabled(),
    socket_path: codexSocketPath(),
    connected: connection.connected,
    daemon_version: connection.daemonVersion,
    last_error: lastError,
    deliveries_ok: deliveriesOk,
    deliveries_failed: deliveriesFailed,
  };
}

export function closeCodexBridge(): void {
  connection.close();
}
