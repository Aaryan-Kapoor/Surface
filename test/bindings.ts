import assert from "node:assert/strict";
import { spawn, ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// End-to-end verification of the wake-binding revival path (the "tap a button
// at 11pm and the offline agent's session is respawned" flow). We boot a real
// isolated server, register a command binding, fire a click with NO live
// waiter, and prove the bound command actually runs — with the full pending
// action batch on stdin, the right cwd, env, and inbox ack — plus the two
// guardrails: a live waiter suppresses it, and a non-matching pattern doesn't
// fire. The bound command stands in for `claude -p --resume <session>`; we
// assert the contract that revival relies on, without burning a real session.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const PORT = 34000 + (process.pid % 1000);
const BASE = `http://127.0.0.1:${PORT}`;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "surface-bind-data-"));
const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "surface-bind-proj-")));
const captureOut = path.join(dataDir, "capture-out.json");

// The stand-in for the revived harness: read the action batch on stdin and
// record everything the binding contract promises (stdin, cwd, env).
const capturePath = path.join(dataDir, "capture.js");
fs.writeFileSync(
  capturePath,
  `const fs = require("fs");
let stdin = "";
try { stdin = fs.readFileSync(0, "utf8"); } catch (e) {}
fs.writeFileSync(process.argv[2], JSON.stringify({
  stdin: stdin,
  cwd: process.cwd(),
  bindingId: process.env.SURFACE_BINDING_ID || null,
  surfaceId: process.env.SURFACE_SURFACE_ID || null,
}));
`,
);

let server: ChildProcess | null = null;
let serverErr = "";

async function call(method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(BASE + p, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json: any = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE + "/artifacts");
      if (res.ok) return;
    } catch {}
    await sleep(150);
  }
  throw new Error(`server did not come up on ${BASE}\n--- server stderr ---\n${serverErr}`);
}

async function listening(id: string): Promise<boolean> {
  const { json } = await call("GET", "/artifacts");
  const card = Array.isArray(json) ? json.find((c: any) => c.id === id) : null;
  return !!(card && card.listening);
}

async function pendingCount(id: string): Promise<number> {
  const { json } = await call("GET", `/artifacts/${id}/actions`);
  return Array.isArray(json) ? json.length : -1;
}

async function waitFor(pred: () => Promise<boolean>, timeoutMs: number, label: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

function test(name: string, fn: () => Promise<void>) {
  return fn()
    .then(() => console.log(`  PASS  ${name}`))
    .catch((err) => { console.error(`  FAIL  ${name}`); throw err; });
}

async function main() {
  server = spawn(path.join(repoRoot, "node_modules", ".bin", "tsx"), ["server/index.ts"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SURFACE_DATA_DIR: dataDir,
      PORT: String(PORT),
      // Unique content port so the (now mandatory) second listener never
      // collides with another test server or the live service on the default 3100.
      SURFACE_CONTENT_PORT: String(PORT + 1000),
      SURFACE_BIND: "127.0.0.1",
      SURFACE_PAIR_ON_START: "0",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  server.stderr!.setEncoding("utf8");
  server.stderr!.on("data", (c: string) => { serverErr += c; });

  await waitForServer(15000);
  console.log("\n=== Wake-binding (revival path) Tests ===\n");

  const id = "wake-test-surface";

  await test("setup: create surface + register a wake binding", async () => {
    const created = await call("POST", "/artifacts", {
      id,
      title: "Wake test",
      mime: "text/html",
      content: "<h1>wake</h1>",
      project_root: projectRoot,
    });
    assert.equal(created.status, 201, "artifact created");

    const bind = await call("POST", `/artifacts/${id}/bindings`, {
      action_pattern: "wake",
      run: `node "${capturePath}" "${captureOut}"`,
    });
    assert.equal(bind.status, 201, "binding registered");
    assert.equal(bind.json.kind, "command");

    const list = await call("GET", `/artifacts/${id}/bindings`);
    assert.equal(list.json.length, 1, "one binding listed");
  });

  await test("click with NO waiter spawns the command with the batch on stdin", async () => {
    if (fs.existsSync(captureOut)) fs.rmSync(captureOut);
    const act = await call("POST", `/artifacts/${id}/actions`, { action: "wake", data: { foo: 1 } });
    assert.equal(act.status, 201, "action accepted");

    await waitFor(() => Promise.resolve(fs.existsSync(captureOut)), 10000, "bound command to run");
    const rec = JSON.parse(fs.readFileSync(captureOut, "utf8"));

    const batch = JSON.parse(rec.stdin);
    assert.equal(batch.type, "surface_action_batch", "stdin is the action batch");
    assert.equal(batch.surface_id, id);
    assert.ok(Array.isArray(batch.actions) && batch.actions.length >= 1, "batch carries actions");
    const wake = batch.actions.find((a: any) => a.action === "wake");
    assert.ok(wake, "the wake action is in the batch");
    assert.deepEqual(wake.data, { foo: 1 }, "action data delivered intact");
  });

  await test("command runs with cwd = project root and binding env set", async () => {
    const rec = JSON.parse(fs.readFileSync(captureOut, "utf8"));
    assert.equal(fs.realpathSync(rec.cwd), projectRoot, "cwd is the project root");
    assert.ok(rec.bindingId, "SURFACE_BINDING_ID present");
    assert.equal(rec.surfaceId, id, "SURFACE_SURFACE_ID is the surface");
  });

  await test("successful run acks the batch and records status ok", async () => {
    await waitFor(async () => (await pendingCount(id)) === 0, 5000, "inbox drained after run");
    const list = await call("GET", `/artifacts/${id}/bindings`);
    assert.equal(list.json[0].last_status, "ok", "binding status is ok");
  });

  await test("a non-matching action does NOT fire the binding (stays in inbox)", async () => {
    fs.rmSync(captureOut, { force: true });
    const act = await call("POST", `/artifacts/${id}/actions`, { action: "ignored", data: {} });
    assert.equal(act.status, 201);
    await sleep(1200);
    assert.ok(!fs.existsSync(captureOut), "binding did not run for non-matching action");
    assert.equal(await pendingCount(id), 1, "non-matching action waits in the inbox");
  });

  await test("a live waiter SUPPRESSES the binding (layer-1 wins)", async () => {
    const ac = new AbortController();
    // Hold an SSE waiter open; the connection itself registers the waiter.
    const streamPromise = fetch(`${BASE}/stream?wait_for=${id}`, { signal: ac.signal }).catch(() => {});
    try {
      await waitFor(() => listening(id), 5000, "waiter to register");
      fs.rmSync(captureOut, { force: true });
      const act = await call("POST", `/artifacts/${id}/actions`, { action: "wake", data: { foo: 2 } });
      assert.equal(act.status, 201);
      await sleep(1200);
      assert.ok(!fs.existsSync(captureOut), "binding suppressed while a waiter is connected");
      assert.equal(await pendingCount(id), 2, "both unhandled actions remain pending");
    } finally {
      ac.abort();
      await streamPromise;
    }
    await waitFor(async () => !(await listening(id)), 5000, "waiter to disconnect");
  });

  console.log("\nWake-binding tests passed\n");
}

main()
  .then(() => { cleanup(); process.exit(0); })
  .catch((err) => { console.error(err); cleanup(); process.exit(1); });

function cleanup() {
  try { server?.kill("SIGKILL"); } catch {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch {}
}
