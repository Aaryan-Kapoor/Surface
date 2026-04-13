// Full-pipeline integration test: spawns the dev server, drives it via
// HTTP, and verifies the SSE event contract that the client relies on.
//
// Runs: `npx tsx test/integration.test.ts`  (starts + tears down server)
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || "3457";
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;

function test(name: string, fn: () => Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ok  ${name}`); })
    .catch((err) => { failed++; console.log(`  FAIL ${name}\n       ${err.stack || err.message || err}`); });
}

function assertEq<T>(a: T, b: T, label = "") {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${label}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v != null) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("waitFor timed out");
}

// Minimal SSE client over fetch streams.
class SSE {
  events: Array<{ event: string; data: any }> = [];
  private ctrl = new AbortController();

  static async connect(url: string): Promise<SSE> {
    const sse = new SSE();
    const res = await fetch(url, { signal: sse.ctrl.signal });
    if (!res.ok || !res.body) throw new Error(`SSE ${url}: ${res.status}`);
    sse.pump(res.body);
    return sse;
  }

  private async pump(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let event = "message";
          let data = "";
          for (const line of chunk.split("\n")) {
            if (line.startsWith("event: ")) event = line.slice(7).trim();
            else if (line.startsWith("data: ")) data += line.slice(6);
          }
          if (data) {
            try { this.events.push({ event, data: JSON.parse(data) }); }
            catch { this.events.push({ event, data }); }
          }
        }
      }
    } catch (err: any) {
      if (err.name !== "AbortError") console.error("[sse pump]", err);
    }
  }

  close() { this.ctrl.abort(); }
  find(event: string, pred: (d: any) => boolean) {
    return this.events.find((e) => e.event === event && pred(e.data));
  }
}

async function http(method: string, url: string, body?: unknown): Promise<any> {
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, json, text };
}

// ── Boot server ───────────────────────────────────────────────────────────
const dbPath = path.join(__dirname, "..", "surfaces.db");
for (const ext of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(dbPath + ext); } catch {}
}
// Use node + tsx/esm loader directly so the child inherits the exact runtime
// we're already in (tsx via npx/tsx/node --import all end up slightly
// different under sandboxes and signal handling).
const tsxBin = path.join(__dirname, "..", "node_modules", ".bin", "tsx");
const proc = spawn(tsxBin, ["server/index.ts"], {
  cwd: path.join(__dirname, ".."),
  env: { ...process.env, PORT },
  stdio: ["ignore", "pipe", "pipe"],
});
let bootLog = "";
proc.stdout.on("data", (b) => { bootLog += b.toString(); });
proc.stderr.on("data", (b) => { bootLog += b.toString(); });

async function shutdown() {
  proc.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 100));
  if (!proc.killed) proc.kill("SIGKILL");
}

(async () => {
  // Wait for the server to come up.
  await waitFor(async () => {
    try { const r = await fetch(BASE + "/surfaces"); return r.ok ? true : null; }
    catch { return null; }
  }, 5000).catch(() => { console.error("server did not boot:\n" + bootLog); process.exit(2); });

  // Connect SSE streams BEFORE making changes so we don't race.
  const global = await SSE.connect(BASE + "/stream");

  await test("html: create + edit morphs via surface_edited event", async () => {
    const created = await http("POST", "/surfaces", {
      id: "it-1",
      title: "Greeting",
      html: "<!doctype html><html><body><p>Hello World</p></body></html>",
    });
    assertEq(created.status, 201);
    assertEq(created.json.kind, "html");
    assertEq(created.json.revision, 1);

    const perSurface = await SSE.connect(BASE + "/surfaces/it-1/stream");

    const edit = await http("PATCH", "/surfaces/it-1", {
      edits: [{ old_string: "World", new_string: "Surface" }],
    });
    assertEq(edit.status, 200);
    assertEq(edit.json.revision, 2);
    assertEq(edit.json.applied, 1);

    await waitFor(async () => perSurface.find("surface_edited", () => true) ? true : null);
    const ev = perSurface.find("surface_edited", (d) => d.id === "it-1");
    if (!ev) throw new Error("no surface_edited event");
    assertEq(Array.isArray((ev.data as any).edits), true);
    assertEq((ev.data as any).edits[0].new_string, "Surface");

    perSurface.close();
  });

  await test("html: ambiguous edit fails with 422 + code=ambiguous", async () => {
    await http("POST", "/surfaces", {
      id: "it-2", title: "Echo",
      html: "<!doctype html><html><body><p>foo foo</p></body></html>",
    });
    const r = await http("PATCH", "/surfaces/it-2", {
      edits: [{ old_string: "foo", new_string: "bar" }],
    });
    assertEq(r.status, 422);
    assertEq(r.json.code, "ambiguous");
  });

  await test("html: served html has bootloader injected", async () => {
    const r = await fetch(BASE + "/surfaces/it-1/html");
    const body = await r.text();
    if (!body.includes("/lib/surface-bootloader.js"))
      throw new Error("bootloader not injected");
  });

  await test("widgets: create + update via spec emits surface_updated with spec", async () => {
    const spec = {
      root: { type: "Text", value: "$.msg" },
      state: { msg: "start" },
    };
    const created = await http("POST", "/surfaces", {
      id: "it-w1", title: "Widget", kind: "widgets", spec,
    });
    assertEq(created.status, 201);
    assertEq(created.json.kind, "widgets");

    const perSurface = await SSE.connect(BASE + "/surfaces/it-w1/stream");

    const updated = await http("PUT", "/surfaces/it-w1", {
      spec: { root: { type: "Text", value: "$.msg" }, state: { msg: "next" } },
    });
    assertEq(updated.status, 200);

    await waitFor(async () => perSurface.find("surface_updated", () => true) ? true : null);
    const ev = perSurface.find("surface_updated", (d) => d.id === "it-w1");
    if (!ev) throw new Error("no surface_updated event");
    assertEq((ev.data as any).kind, "widgets");
    if (!(ev.data as any).spec || !(ev.data as any).spec.root)
      throw new Error("missing spec payload");

    perSurface.close();
  });

  await test("widgets: invalid spec fails with 422 + code=spec_error", async () => {
    const r = await http("POST", "/surfaces", {
      id: "it-w2", title: "bad", kind: "widgets",
      spec: { root: { type: "NotReal" } },
    });
    assertEq(r.status, 422);
    assertEq(r.json.code, "spec_error");
  });

  await test("revisions: list + restore produces a new revision", async () => {
    const list1 = await http("GET", "/surfaces/it-1/revisions");
    assertEq(list1.status, 200);
    if (list1.json.length < 2) throw new Error("expected >= 2 revisions");
    const restore = await http("POST", "/surfaces/it-1/revisions/1/restore");
    assertEq(restore.status, 200);
    const current = await http("GET", "/surfaces/it-1");
    // Should match original html now.
    if (!current.json.html.includes("Hello World"))
      throw new Error("restore didn't revert html");
    // Restore created a new revision (monotonic — does not rewrite history).
    if (current.json.revision <= list1.json[0].revision)
      throw new Error("restore should bump revision");
  });

  await test("global stream: saw surface_created events", async () => {
    const ids = ["it-1", "it-2", "it-w1"];
    for (const id of ids) {
      const ev = global.find("surface_created", (d) => d.id === id);
      if (!ev) throw new Error(`no surface_created for ${id}`);
    }
  });

  global.close();
  await shutdown();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(async (err) => {
  console.error(err);
  await shutdown();
  process.exit(1);
});
