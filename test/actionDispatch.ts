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

  // `?wait_for=` is the pre-claim registration param. Deployed CLIs still send
  // it, and the codex layer's waiter-precedence check depends on the resulting
  // registration being visible. Turning it into a no-op made a connected waiter
  // invisible to the ladder, so nothing suppressed anything.
  await test("a legacy ?wait_for= connection still registers as a waiter", async () => {
    const ac = new AbortController();
    const streamed = fetch(`${BASE}/stream?wait_for=dispatch-a`, { signal: ac.signal }).catch(() => {});
    try {
      await waitForListening("dispatch-a", true, 8000);
    } finally {
      ac.abort();
      await streamed;
    }
    await waitForListening("dispatch-a", false, 8000);
  });

  // A bare `surface wait` is project-scoped, so any consumer asking "is a waiter
  // covering this surface?" must supply the surface's project root — otherwise
  // the default waiter is invisible and a second channel delivers on top of it.
  await test("a project-scoped waiter counts as listening on its project's surfaces", async () => {
    const w = spawnWaiter("proj", ["--follow", "--project", projectA], BASE);
    try {
      await waitForListening("dispatch-a", true, 12000);
    } finally {
      killWaiters();
    }
    await waitForListening("dispatch-a", false, 8000);
    void w;
  });

  // Losing a claim is not permanent. `already_claimed` means someone owns it
  // right now, and the release paths (disconnect, expired handoff, failed
  // binding) exist precisely to hand it back. A waiter that caches a lost claim
  // as "seen" goes deaf to that re-offer, so the click strands in the inbox
  // while a live, eligible waiter sits there listening.
  await test("a waiter that loses a claim still takes it after the winner releases", async () => {
    const waiter = spawnWaiter("loser", ["--follow", "--id", "dispatch-a"], BASE);
    await waitForListening("dispatch-a", true, 12000);
    await sleep(600);

    // Race the CLI and win from in-process: create the action, then claim it
    // before the CLI's SSE round-trip completes. Retry with a fresh action if
    // the CLI gets there first.
    const ac = new AbortController();
    const streamed = fetch(`${BASE}/stream?wait_for_surface=dispatch-a`, { signal: ac.signal });
    const rivalId = await firstWaiterClientId(streamed);
    let contested: string | null = null;
    try {
      for (let attempt = 0; attempt < 4 && !contested; attempt++) {
        const id = await fire("dispatch-a", "contested", { attempt });
        const claim = await api("POST", `/actions/${id}/claim`, { token: `rival-${attempt}`, client_id: rivalId });
        if (claim.status === 200) contested = id;
        else await sleep(300); // the CLI won that one; try again
      }
      assert.ok(contested, "could not win a claim ahead of the CLI waiter");
      await sleep(1200); // the CLI has now attempted and lost
      const before = waiter.lines.map((l) => JSON.parse(l).id);
      assert.ok(!before.includes(contested), "the rival claim should have blocked the CLI");
    } finally {
      ac.abort(); // rival dies mid-handoff; the server releases its claim
      await streamed.catch(() => {});
    }

    await waitFor(async () => {
      return waiter.lines.map((l) => JSON.parse(l).id).includes(contested!);
    }, 15000, "the released action to reach the waiter that had lost it");
    killWaiters();
    await waitForListening("dispatch-a", false, 8000);
  });

  // Scope is enforced server-side, not just in the CLI: a registered waiter must
  // not be able to take work its registration does not cover just by asking for
  // it by id. `waiter_not_eligible` is a permanent answer for that request — the
  // claimant must not retry it.
  await test("a waiter registered for another action is refused with 403, not given the claim", async () => {
    const id = await fire("dispatch-a", "eligible-only", {});
    const ac = new AbortController();
    const streamed = fetch(`${BASE}/stream?wait_for_surface=dispatch-a&wait_action=something-else`, { signal: ac.signal });
    try {
      const clientId = await firstWaiterClientId(streamed);
      const res = await api("POST", `/actions/${id}/claim`, { token: "tok-inelig", client_id: clientId });
      assert.equal(res.status, 403, `expected 403, got ${res.status} ${JSON.stringify(res.json)}`);
      assert.equal(res.json.error, "waiter_not_eligible");
      const { json } = await api("GET", "/artifacts/dispatch-a/actions");
      assert.ok(json.some((a: any) => a.id === id), "a refused claim must leave the action pending");
    } finally {
      ac.abort();
      await streamed.catch(() => {});
    }
    await api("POST", `/actions/${id}/ack`, {});
  });

  // v14 puts a UNIQUE index on claim_token, so a client that reuses one token
  // for two actions hits a constraint violation. That has to come back as a
  // decided 4xx: a 500 tells the caller "the server is broken, retry", and its
  // retry will fail identically forever. The action must stay pending either
  // way — the claim is a transaction, and a rejected one takes nothing.
  await test("reusing a claim token on a second action is refused, not a 500", async () => {
    const first = await fire("dispatch-a", "tokenreuse", { n: 1 });
    const second = await fire("dispatch-a", "tokenreuse", { n: 2 });
    const ac = new AbortController();
    const streamed = fetch(`${BASE}/stream?wait_for_surface=dispatch-a`, { signal: ac.signal });
    try {
      const clientId = await firstWaiterClientId(streamed);
      const won = await api("POST", `/actions/${first}/claim`, { token: "shared-token", client_id: clientId });
      assert.equal(won.status, 200, `first claim should win: ${JSON.stringify(won.json)}`);

      const reused = await api("POST", `/actions/${second}/claim`, { token: "shared-token", client_id: clientId });
      assert.ok(
        reused.status >= 400 && reused.status < 500,
        `a reused token must be a client error, got ${reused.status} ${JSON.stringify(reused.json)}`,
      );
      const { json } = await api("GET", "/artifacts/dispatch-a/actions");
      assert.ok(json.some((a: any) => a.id === second), "a refused claim must leave the action pending");
    } finally {
      ac.abort();
      await streamed.catch(() => {});
    }
    await api("POST", `/actions/${first}/ack`, { token: "shared-token" });
    await api("POST", `/actions/${second}/ack`, {});
  });

  // Grace is per action. A live-but-not-claiming waiter (registered socket, no
  // claim — a wedged harness) must still get its full five seconds on EVERY
  // action, not just on the one whose timer happened to fire. Two clicks four
  // seconds apart used to hand the binding both at once, giving the second one
  // only 0.1s of its own window.
  await test("a click inside its own grace window is not swept into an older click's binding batch", async () => {
    const batchLog = path.join(dataDir, "grace-batches.jsonl");
    try { fs.unlinkSync(batchLog); } catch {}
    const dumper = path.join(dataDir, "dump-batch.js");
    fs.writeFileSync(dumper, [
      "let b = '';",
      "process.stdin.on('data', (c) => { b += c; });",
      `process.stdin.on('end', () => { require('fs').appendFileSync(${JSON.stringify(batchLog)}, b + "\\n"); process.exit(0); });`,
    ].join("\n"));

    fs.mkdirSync(path.join(projectA, ".surface"), { recursive: true });
    fs.writeFileSync(
      path.join(projectA, ".surface", "config.json"),
      JSON.stringify({ bindings: { enabled: true } }),
    );
    const reg = await api("POST", "/artifacts/dispatch-a/bindings", {
      action_pattern: "graceclick",
      kind: "command",
      run: `node ${JSON.stringify(dumper)}`,
      cwd: projectA,
    });
    assert.equal(reg.status, 201, `binding registration failed: ${JSON.stringify(reg.json)}`);

    // A registered waiter that never claims: eligible, so grace applies, but it
    // will not take either action. Portable stand-in for a wedged CLI.
    const ac = new AbortController();
    const streamed = fetch(`${BASE}/stream?wait_for_surface=dispatch-a&wait_action=graceclick`, { signal: ac.signal });
    try {
      await firstWaiterClientId(streamed);
      const first = await fire("dispatch-a", "graceclick", { n: 1 });
      await sleep(4000);
      const second = await fire("dispatch-a", "graceclick", { n: 2 });

      await waitFor(async () => fs.existsSync(batchLog), 8000, "the first binding batch to run");
      await sleep(300);
      const batch = JSON.parse(fs.readFileSync(batchLog, "utf8").trim().split("\n")[0]);
      const ids = batch.actions.map((a: any) => a.id);
      assert.ok(ids.includes(first), `the first batch should carry the elapsed action: ${JSON.stringify(ids)}`);
      assert.ok(
        !ids.includes(second),
        `a click still inside its own grace window was swept into an older click's batch: ${JSON.stringify(ids)}`,
      );
    } finally {
      ac.abort();
      await streamed.catch(() => {});
      await api("DELETE", `/bindings/${reg.json.id}`);
    }
  });

  // A `surface wait` whose SERVER goes away is not talking to an old server, it
  // is talking to no server. The one-shot "this service predates single-claimant
  // delivery" warning must not fire in that case: it tells the user to upgrade
  // something that is merely restarting.
  await test("a waiter whose server restarts does not claim the server is too old", async () => {
    const p = await isolatedPorts();
    const tmp = tmpDir("surface-dispatch-restart-");
    const short = spawnServer(p.port, tmp, {}, p.contentPort);
    let killed = false;
    let w: Waiter;
    try {
      const shortBase = `http://127.0.0.1:${p.port}`;
      await waitForReady(shortBase, "/artifacts");
      const created = await makeClient(shortBase)("POST", "/artifacts", {
        body: { id: "restart-me", title: "restart-me", kind: "html", mime: "text/html", content: "<h1>x</h1>" },
      });
      assert.ok(created.status === 201 || created.status === 200);
      w = spawnWaiter("restart", ["--follow", "--id", "restart-me"], shortBase);
      await sleep(2000); // registered
      await killServer(short, p.port);
      killed = true;
      await sleep(7000); // outlive the 5s registration timer
      assert.ok(
        !w.stderr.includes("predates single-claimant delivery"),
        `a mere server restart was reported as an out-of-date service: ${w.stderr}`,
      );
    } finally {
      killWaiters();
      // Any early failure (a slow boot, a refused create) must not strand this
      // second server: nothing else in the suite knows about it.
      if (!killed) await killServer(short, p.port).catch(() => {});
      cleanupDir(tmp);
    }
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
