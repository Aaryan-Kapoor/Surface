import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { cleanupDir, isolatedPorts, killServer, makeClient, REPO_ROOT, sleep, spawnServer, tmpDir, waitForReady } from "./helpers.js";

// The delivery ladder's exclusivity contract (docs/interaction/delivery-ladder.md).
//
// A user action is a WORK ITEM, not a notification: it must be handled once, by
// one agent. Before this suite existed, `surface_action` was broadcast to every
// global SSE client and every `surface wait --follow` on the machine printed it —
// so one click woke every Claude Code session, each of which did the same work
// (and, with wake bindings, each of which billed a headless spawn).
//
// These tests spawn REAL waiter processes against a REAL isolated server, because
// the bug lived in the seam between them: the server broadcasts (correctly), the
// database has an atomic claim (correctly), and the CLI used to throw the claim
// result away. Only an end-to-end assertion catches that.

const cli = path.join(REPO_ROOT, "dist", "surface.mjs");

const dataDir = tmpDir("surface-dispatch-data-");
const projectA = fs.realpathSync(tmpDir("surface-dispatch-projA-"));
const projectB = fs.realpathSync(tmpDir("surface-dispatch-projB-"));

let server: ChildProcess | null = null;
let call: ReturnType<typeof makeClient>;
const waiters: Waiter[] = [];

interface Waiter {
  proc: ChildProcess;
  lines: string[];
  stderr: string;
  label: string;
}

function spawnWaiter(label: string, args: string[], base: string, cwd = REPO_ROOT): Waiter {
  const proc = spawn("node", [cli, "wait", ...args], {
    cwd,
    env: { ...process.env, SURFACE_URL: base },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const w: Waiter = { proc, lines: [], stderr: "", label };
  let buf = "";
  proc.stdout?.setEncoding("utf8");
  proc.stdout?.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) w.lines.push(line);
    }
  });
  proc.stderr?.setEncoding("utf8");
  proc.stderr?.on("data", (chunk: string) => { w.stderr += chunk; });
  waiters.push(w);
  return w;
}

function killWaiters(): void {
  for (const w of waiters.splice(0)) {
    try { w.proc.kill("SIGKILL"); } catch {}
  }
}

async function api(method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await call(method, p, { body });
  return { status: res.status, json: res.body };
}

async function createSurface(id: string, projectRoot: string): Promise<void> {
  const { status } = await api("POST", "/artifacts", {
    id,
    title: id,
    kind: "html",
    mime: "text/html",
    project_root: projectRoot,
    content: `<h1>${id}</h1>`,
  });
  assert.ok(status === 201 || status === 200, `could not create surface ${id}`);
}

async function fire(surfaceId: string, action: string, data: unknown = {}): Promise<string> {
  const { status, json } = await api("POST", `/artifacts/${surfaceId}/actions`, { action, data });
  assert.equal(status, 201, `firing ${action} failed`);
  return json.id;
}

// Waiters register asynchronously (spawn → HTTP → SSE). Poll the server's own
// view of waiter presence rather than sleeping a guessed interval.
async function waitForListening(surfaceId: string, expected: boolean, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { json } = await api("GET", "/artifacts");
    const card = Array.isArray(json) ? json.find((c: any) => c.id === surfaceId) : null;
    if (card && !!card.listening === expected) return;
    await sleep(120);
  }
  throw new Error(`timed out waiting for listening===${expected} on ${surfaceId}`);
}

async function isListening(surfaceId: string): Promise<boolean> {
  const { json } = await api("GET", "/artifacts");
  const card = Array.isArray(json) ? json.find((c: any) => c.id === surfaceId) : null;
  return !!(card && card.listening);
}

async function waitFor(pred: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await sleep(150);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

// Read the server-assigned waiter identity off a raw SSE connection, so a test
// can act as a waiter without spawning the CLI.
async function firstWaiterClientId(streamed: Promise<Response>): Promise<string> {
  const res = await streamed;
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buf += decoder.decode(chunk.value, { stream: true });
    const match = /event: waiter_registered\s*\ndata: (.*)\n/.exec(buf);
    if (match) return String(JSON.parse(match[1]).client_id);
  }
  throw new Error("never received waiter_registered");
}

function totalLines(...ws: Waiter[]): number {
  return ws.reduce((n, w) => n + w.lines.length, 0);
}

function describe(ws: Waiter[]): string {
  return ws.map((w) => `${w.label}=${w.lines.length}${w.stderr ? ` (stderr: ${w.stderr.slice(0, 200)})` : ""}`).join(", ");
}

// Collect failures instead of aborting on the first: these cases probe
// independent seams (waiter/waiter, backlog, waiter/binding), and seeing only
// the first failure hides whether the others regressed too.
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
  } catch (err: any) {
    console.error(`  FAIL  ${name}\n        ${err?.message || err}`);
    failures.push(name);
    killWaiters();
  }
}

const ports = await isolatedPorts();
const BASE = `http://127.0.0.1:${ports.port}`;

try {
  server = spawnServer(ports.port, dataDir, {}, ports.contentPort);
  call = makeClient(BASE);
  await waitForReady(BASE, "/artifacts");

  await createSurface("dispatch-a", projectA);
  await createSurface("dispatch-b", projectB);

  // ── The reported bug ───────────────────────────────────────────────────
  await test("one action reaches exactly one of two waiters on the same surface", async () => {
    const w1 = spawnWaiter("w1", ["--follow", "--id", "dispatch-a"], BASE);
    const w2 = spawnWaiter("w2", ["--follow", "--id", "dispatch-a"], BASE);
    await waitForListening("dispatch-a", true);
    await sleep(400); // let both SSE registrations settle, not just the first

    await fire("dispatch-a", "click", { n: 1 });
    await sleep(1500);

    assert.equal(
      totalLines(w1, w2),
      1,
      `expected exactly one waiter to emit the action, got ${describe([w1, w2])}`,
    );
    killWaiters();
    await waitForListening("dispatch-a", false);
  });

  // ── Backlog must not be double-claimed either ──────────────────────────
  await test("a pending backlog is split, never duplicated, across two waiters", async () => {
    const ids = [
      await fire("dispatch-a", "backlog", { n: 1 }),
      await fire("dispatch-a", "backlog", { n: 2 }),
      await fire("dispatch-a", "backlog", { n: 3 }),
    ];
    const w1 = spawnWaiter("w1", ["--follow", "--id", "dispatch-a"], BASE);
    const w2 = spawnWaiter("w2", ["--follow", "--id", "dispatch-a"], BASE);
    await waitForListening("dispatch-a", true);
    await sleep(2000);

    const emitted = [...w1.lines, ...w2.lines].map((l) => JSON.parse(l).id);
    assert.equal(emitted.length, 3, `expected 3 emissions total, got ${describe([w1, w2])}`);
    assert.equal(new Set(emitted).size, 3, "the same action was emitted by more than one waiter");
    for (const id of ids) assert.ok(emitted.includes(id), `action ${id} was never delivered`);
    killWaiters();
    await waitForListening("dispatch-a", false);
  });

  // ── Layer 1 vs layer 2: a waiter arriving mid-binding-run ──────────────
  // runBindings() reads the pending batch up front and only acks after the
  // command succeeds (server/bindings.ts). For the whole run — up to the 600s
  // default timeout — those actions sit `pending`, so a waiter that connects
  // during the run drains them and the work happens twice.
  await test("a waiter connecting mid-binding-run does not re-handle the batch", async () => {
    fs.mkdirSync(path.join(projectA, ".surface"), { recursive: true });
    fs.writeFileSync(
      path.join(projectA, ".surface", "config.json"),
      JSON.stringify({ bindings: { enabled: true } }),
    );
    // A binding that takes long enough for a waiter to race it.
    const slowPath = path.join(dataDir, "slow.js");
    fs.writeFileSync(slowPath, `setTimeout(() => process.exit(0), 3000);`);

    const reg = await api("POST", "/artifacts/dispatch-a/bindings", {
      action_pattern: "slowclick",
      kind: "command",
      run: `node ${JSON.stringify(slowPath)}`,
      cwd: projectA,
    });
    assert.equal(reg.status, 201, `binding registration failed: ${JSON.stringify(reg.json)}`);

    await fire("dispatch-a", "slowclick", { n: 1 });
    await sleep(600); // binding is now mid-run, action still pending

    const late = spawnWaiter("late", ["--follow", "--id", "dispatch-a"], BASE);
    await sleep(3500); // outlive the binding

    assert.equal(
      late.lines.length,
      0,
      `a waiter drained an action already claimed by a running binding: ${describe([late])}`,
    );
    killWaiters();
    await api("DELETE", `/bindings/${reg.json.id}`);
    await waitForListening("dispatch-a", false);
  });

  // ── Tenancy: a waiter must not drain another repo's clicks ─────────────
  await test("a project-scoped waiter ignores another project's actions", async () => {
    const w = spawnWaiter("projA", ["--follow", "--project", projectA], BASE);
    await waitForListening("dispatch-a", true);
    await sleep(400);

    await fire("dispatch-b", "click", { n: 1 }); // different project
    await sleep(1500);
    assert.equal(w.lines.length, 0, `waiter took another project's action: ${describe([w])}`);

    await fire("dispatch-a", "click", { n: 2 }); // its own project
    await sleep(1500);
    assert.equal(w.lines.length, 1, `waiter missed its own project's action: ${describe([w])}`);
    killWaiters();
    await waitForListening("dispatch-a", false);
  });

  // The auto-created global board has no project_root; it belongs to no repo, so
  // a project-scoped waiter must not silently absorb its clicks.
  await test("an unowned surface's actions are not absorbed by a project waiter", async () => {
    const { status } = await api("POST", "/artifacts", {
      id: "dispatch-unowned",
      title: "Unowned",
      kind: "html",
      mime: "text/html",
      content: "<h1>unowned</h1>",
    });
    assert.ok(status === 201 || status === 200);
    await api("PATCH", "/artifacts/dispatch-unowned/state", { seed: 1 }).catch(() => {});

    const scoped = spawnWaiter("scoped", ["--follow", "--project", projectA], BASE);
    await sleep(1200);
    const unownedId = await fire("dispatch-unowned", "click", {});
    await sleep(1500);
    assert.equal(scoped.lines.length, 0, `project waiter took an unowned action: ${describe([scoped])}`);
    killWaiters();

    // --all is the explicit opt-in to machine-wide consumption, so it should
    // pick this up. Assert by id: it legitimately also drains anything else
    // left pending by earlier cases.
    const all = spawnWaiter("all", ["--follow", "--all"], BASE);
    await sleep(2500);
    const ids = all.lines.map((l) => JSON.parse(l).id);
    assert.ok(ids.includes(unownedId), `--all waiter missed the unowned action: ${describe([all])}`);
    killWaiters();
  });

  // ── Observers take nothing and hold nothing back ───────────────────────
  await test("--no-ack observes without claiming, leaving the action pending", async () => {
    const observer = spawnWaiter("observer", ["--follow", "--id", "dispatch-a", "--no-ack"], BASE);
    await sleep(1200);
    const id = await fire("dispatch-a", "observed", {});
    await sleep(1500);

    assert.equal(observer.lines.length, 1, `observer should still see everything: ${describe([observer])}`);
    const { json } = await api("GET", "/artifacts/dispatch-a/actions");
    assert.ok(
      Array.isArray(json) && json.some((a: any) => a.id === id),
      "an observed action must stay pending for a real handler",
    );
    // And it must not register as a waiter at all.
    assert.equal(await isListening("dispatch-a"), false, "an observer must not appear as a live waiter");
    killWaiters();
    await api("POST", `/actions/${id}/ack`, {});
  });

  // ── Recovery: a claim that never completes must not eat the action ─────
  await test("a waiter killed mid-handoff releases its claim on disconnect", async () => {
    const id = await fire("dispatch-a", "orphan", {});
    // Claim it directly as a waiter would, then drop the connection.
    const ac = new AbortController();
    const streamed = fetch(`${BASE}/stream?wait_for_surface=dispatch-a`, { signal: ac.signal });
    const clientId = await firstWaiterClientId(streamed);
    const claim = await api("POST", `/actions/${id}/claim`, { token: "tok-orphan", client_id: clientId });
    assert.equal(claim.status, 200, `claim failed: ${JSON.stringify(claim.json)}`);

    const claimed = await api("GET", "/artifacts/dispatch-a/actions");
    assert.ok(
      !claimed.json.some((a: any) => a.id === id),
      "a claimed action must not be offered to a second handler",
    );

    ac.abort(); // the "waiter" dies before completing the handoff
    await waitFor(async () => {
      const { json } = await api("GET", "/artifacts/dispatch-a/actions");
      return Array.isArray(json) && json.some((a: any) => a.id === id);
    }, 10000, "the orphaned claim to return to pending");
    await api("POST", `/actions/${id}/ack`, {});
  });

  await test("re-claiming with the same token is a replay, with a different token a conflict", async () => {
    const id = await fire("dispatch-a", "idem", {});
    const ac = new AbortController();
    const streamed = fetch(`${BASE}/stream?wait_for_surface=dispatch-a`, { signal: ac.signal });
    const clientId = await firstWaiterClientId(streamed);
    try {
      const first = await api("POST", `/actions/${id}/claim`, { token: "tok-a", client_id: clientId });
      assert.equal(first.status, 200);
      assert.equal(first.json.replayed, false);

      // The lost-response case: retrying the same attempt must not lose the action.
      const retry = await api("POST", `/actions/${id}/claim`, { token: "tok-a", client_id: clientId });
      assert.equal(retry.status, 200, "same token must replay, not conflict");
      assert.equal(retry.json.replayed, true);

      const other = await api("POST", `/actions/${id}/claim`, { token: "tok-b", client_id: clientId });
      assert.equal(other.status, 409, "a different token must lose");
      assert.equal(other.json.error, "already_claimed");

      const done = await api("POST", `/actions/${id}/ack`, { token: "tok-a" });
      assert.equal(done.status, 200);
    } finally {
      ac.abort();
    }
  });

  // A stale registration must not consume work. The CLI holds a client_id across
  // a reconnect gap; if a failed claim from a dead identity counted as "someone
  // else has it", the waiter would mark the action seen and skip it forever
  // while nobody had actually handled it.
  await test("claiming with a dead client_id leaves the action pending", async () => {
    const id = await fire("dispatch-a", "stale", {});
    const ac = new AbortController();
    const streamed = fetch(`${BASE}/stream?wait_for_surface=dispatch-a`, { signal: ac.signal });
    const clientId = await firstWaiterClientId(streamed);
    ac.abort();
    await sleep(500); // let the server drop the registration

    const res = await api("POST", `/actions/${id}/claim`, { token: "tok-stale", client_id: clientId });
    assert.equal(res.status, 409, `expected a rejected claim, got ${JSON.stringify(res.json)}`);
    assert.equal(res.json.error, "waiter_not_live");

    const { json } = await api("GET", "/artifacts/dispatch-a/actions");
    assert.ok(
      json.some((a: any) => a.id === id),
      "a claim from a dead waiter must not consume the action",
    );
    await api("POST", `/actions/${id}/ack`, {});
  });

  if (failures.length) {
    throw new Error(`actionDispatch: ${failures.length} failing case(s): ${failures.join(", ")}`);
  }
  console.log("\nactionDispatch: all tests passed");
} finally {
  killWaiters();
  await killServer(server, ports.port);
  cleanupDir(dataDir);
  cleanupDir(projectA);
  cleanupDir(projectB);
}
