import assert from "node:assert/strict";
import { spawn, ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// End-to-end verification of content-origin isolation. We boot one server with
// two listeners — the app port (:PORT, loopback = system) and the content port
// (:CONTENT_PORT, the untrusted device plane) — and prove the pivot: the SAME
// loopback machine is system on the app port but NEVER system on the content
// port, while the surface runtime (state/stream/actions) still works there. A
// device-authored surface served from the content origin therefore can't reach
// any system-only endpoint, which closes the device→system escalation.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const PORT = 35000 + (process.pid % 800);
const CONTENT_PORT = PORT + 1;
const APP = `http://127.0.0.1:${PORT}`;
const CONTENT = `http://127.0.0.1:${CONTENT_PORT}`;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "surface-content-data-"));
let server: ChildProcess | null = null;
let serverErr = "";

async function call(base: string, method: string, p: string, body?: unknown) {
  const res = await fetch(base + p, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  let json: any = null;
  try { json = await res.clone().json(); } catch {}
  return { status: res.status, json };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(base: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const res = await fetch(base + "/display/config"); if (res.ok) return; } catch {}
    await sleep(150);
  }
  throw new Error(`server did not come up on ${base}\n--- stderr ---\n${serverErr}`);
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
      SURFACE_CONTENT_PORT: String(CONTENT_PORT),
      // A pinned content origin for the proxy-deploy path; advertised verbatim.
      SURFACE_CONTENT_ORIGIN: "http://content.test:4555",
      SURFACE_BIND: "127.0.0.1",
      SURFACE_PAIR_ON_START: "0",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  server.stderr!.setEncoding("utf8");
  server.stderr!.on("data", (c: string) => { serverErr += c; });

  await waitForServer(APP, 15000);
  await waitForServer(CONTENT, 15000); // the second listener must be up too
  console.log("\n=== Content-origin isolation Tests ===\n");

  const id = "content-test-surface";

  await test("setup: a surface exists (created as system on the app port)", async () => {
    const r = await call(APP, "POST", "/artifacts", {
      id, title: "Content test", mime: "text/html", content: "<h1>hi</h1>",
    });
    assert.equal(r.status, 201, "created on app port");
  });

  await test("app port from loopback IS system (control)", async () => {
    const reset = await call(APP, "POST", "/display/reset", {});
    assert.notEqual(reset.status, 403, "system endpoint allowed on app port");
    const tpl = await call(APP, "GET", "/api/templates");
    assert.notEqual(tpl.status, 403, "templates allowed on app port");
  });

  await test("content port is NEVER system — system-only endpoints 403 (the pivot)", async () => {
    const reset = await call(CONTENT, "POST", "/display/reset", {});
    assert.equal(reset.status, 403, "display/reset is 403 on the content port");
    const tpl = await call(CONTENT, "GET", "/api/templates");
    assert.equal(tpl.status, 403, "/api/templates is 403 on the content port");
    const present = await call(CONTENT, "POST", "/artifacts/present-file", { path: "/etc/hosts" });
    assert.equal(present.status, 403, "file-reading present-file is 403 on the content port");
  });

  await test("content port still serves the surface runtime (state / actions)", async () => {
    const state = await call(CONTENT, "GET", `/artifacts/${id}/state`);
    assert.equal(state.status, 200, "state readable on content port");
    const act = await call(CONTENT, "POST", `/artifacts/${id}/actions`, { action: "tap", data: { ok: 1 } });
    assert.equal(act.status, 201, "actions emittable on content port (device plane)");
  });

  await test("content port serves the artifact view (so it can be embedded)", async () => {
    const view = await fetch(`${CONTENT}/artifacts/${id}/view`);
    assert.ok(view.ok || view.status === 200, `view loads on content port (got ${view.status})`);
  });

  await test("/display/config advertises the content port (and pinned origin) to the PWA", async () => {
    const cfg = await call(APP, "GET", "/display/config");
    assert.equal(cfg.json.content_port, CONTENT_PORT, "content_port advertised");
    assert.equal(
      cfg.json.content_origin,
      "http://content.test:4555",
      "pinned SURFACE_CONTENT_ORIGIN advertised for proxy/HTTPS deploys",
    );
  });

  await test("server refuses to boot when the content port is taken (content plane is mandatory)", async () => {
    // The content plane is the isolation boundary; a server with a dead content
    // listener must not run (it would break or mis-route device surfaces).
    const appPort = PORT + 10;
    const takenContentPort = PORT + 11;
    const squatter = net.createServer();
    await new Promise<void>((resolve) => squatter.listen(takenContentPort, "127.0.0.1", () => resolve()));
    const guardDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "surface-bindfail-"));
    const proc = spawn(path.join(repoRoot, "node_modules", ".bin", "tsx"), ["server/index.ts"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        SURFACE_DATA_DIR: guardDataDir,
        PORT: String(appPort),
        SURFACE_CONTENT_PORT: String(takenContentPort),
        SURFACE_BIND: "127.0.0.1",
        SURFACE_PAIR_ON_START: "0",
        NODE_ENV: "test",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    proc.stderr!.setEncoding("utf8");
    proc.stderr!.on("data", (c: string) => { err += c; });
    const code: number = await new Promise((resolve) => proc.on("exit", (c) => resolve(c ?? -1)));
    await new Promise<void>((resolve) => squatter.close(() => resolve()));
    fs.rmSync(guardDataDir, { recursive: true, force: true });
    assert.notEqual(code, 0, "process must exit non-zero when the content port can't bind");
    assert.match(err, /could not bind|content plane/i, "logs why it refused to run");
  });

  await test("server refuses to boot when CONTENT_PORT === PORT (collision guard)", async () => {
    // A collision would make the content gate match the app port too, forcing
    // every request — including the agent plane's own — to `device`. The server
    // must fail fast instead of booting into a fully de-privileged state.
    const samePort = PORT + 5; // exits before any listen, so the value need only collide
    const guardDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "surface-guard-"));
    const proc = spawn(path.join(repoRoot, "node_modules", ".bin", "tsx"), ["server/index.ts"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        SURFACE_DATA_DIR: guardDataDir,
        PORT: String(samePort),
        SURFACE_CONTENT_PORT: String(samePort),
        SURFACE_BIND: "127.0.0.1",
        SURFACE_PAIR_ON_START: "0",
        NODE_ENV: "test",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    proc.stderr!.setEncoding("utf8");
    proc.stderr!.on("data", (c: string) => { err += c; });
    const code: number = await new Promise((resolve) => proc.on("exit", (c) => resolve(c ?? -1)));
    fs.rmSync(guardDataDir, { recursive: true, force: true });
    assert.notEqual(code, 0, "process must exit non-zero on port collision");
    assert.match(err, /must differ from PORT/, "logs the collision reason");
  });

  console.log("\nContent-origin tests passed\n");
}

main()
  .then(() => { cleanup(); process.exit(0); })
  .catch((err) => { console.error(err); cleanup(); process.exit(1); });

function cleanup() {
  try { server?.kill("SIGKILL"); } catch {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
