import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// surface.js is a browser IIFE (reads document.currentScript, window, fetch,
// EventSource). We load it into a hand-rolled DOM shim so we can drive
// Surface.stage()/commit() and assert exactly what hits the network — no jsdom,
// no build step, matching the repo's zero-dep test convention.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeSrc = fs.readFileSync(path.join(__dirname, "..", "client", "surface.js"), "utf8");

interface FetchCall { url: string; method: string; body: any }

function loadRuntime(cfg: { failActions?: boolean } = {}) {
  const fetchCalls: FetchCall[] = [];

  const fetchMock = (url: string, opts?: any) => {
    fetchCalls.push({
      url,
      method: (opts && opts.method) || "GET",
      body: opts && opts.body ? JSON.parse(opts.body) : undefined,
    });
    // Simulate a server-rejected action POST so we can assert staged retention.
    if (cfg.failActions && url.includes("/actions") && opts && opts.method === "POST") {
      return Promise.resolve({ ok: false, json: () => Promise.resolve({ error: "server rejected" }) });
    }
    // /state hydrate and /actions POST both read .json(); .ok for hydrate.
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ state: {}, state_version: 0 }) });
  };

  class EventSourceStub {
    onerror: any = null;
    addEventListener() {}
    constructor(_url: string) {}
  }

  const documentStub: any = {
    readyState: "complete", // boot() runs synchronously on load
    currentScript: { src: "http://localhost/surface.js?id=test-id" },
    addEventListener() {},
    querySelectorAll() { return []; },
  };

  const sandbox: any = {
    console,
    URL,
    fetch: fetchMock,
    EventSource: EventSourceStub,
    location: { origin: "http://localhost" },
    document: documentStub,
    setTimeout,
    clearTimeout,
  };
  // window IS the global, and window.parent === window (standalone-tab path → fetch).
  sandbox.window = sandbox;
  sandbox.window.parent = sandbox.window;

  vm.createContext(sandbox);
  vm.runInContext(runtimeSrc, sandbox);

  return { Surface: sandbox.window.Surface, fetchCalls };
}

function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  PASS  ${name}`))
    .catch((err) => { console.error(`  FAIL  ${name}`); throw err; });
}

const actionsPosts = (calls: FetchCall[]) =>
  calls.filter((c) => c.url.includes("/actions") && c.method === "POST");

// staged() builds its object inside the vm realm, so its prototype differs from
// this realm's Object.prototype and strict deepEqual rejects it. Normalize the
// shape through JSON before structural comparison.
const plain = (x: unknown) => JSON.parse(JSON.stringify(x));

console.log("\n=== Surface runtime: stage / commit ===\n");

await test("runtime exposes stage / commit / staged / action", () => {
  const { Surface } = loadRuntime();
  assert.equal(typeof Surface.stage, "function");
  assert.equal(typeof Surface.commit, "function");
  assert.equal(typeof Surface.staged, "function");
  assert.equal(typeof Surface.action, "function");
});

await test("stage() accumulates locally and emits ZERO actions", () => {
  const { Surface, fetchCalls } = loadRuntime();
  Surface.stage("region", "us-east");
  Surface.stage("plan", "pro");
  Surface.stage("region", "eu-west"); // last write wins
  assert.equal(actionsPosts(fetchCalls).length, 0, "no action POST before commit");
  assert.deepEqual(plain(Surface.staged()), { region: "eu-west", plan: "pro" });
});

await test("commit() emits exactly ONE action with the full staged payload", async () => {
  const { Surface, fetchCalls } = loadRuntime();
  Surface.stage("region", "eu-west");
  Surface.stage("plan", "pro");
  await Surface.commit("choices");
  const posts = actionsPosts(fetchCalls);
  assert.equal(posts.length, 1, "exactly one action POST");
  assert.equal(posts[0].body.action, "choices");
  assert.deepEqual(plain(posts[0].body.data), { region: "eu-west", plan: "pro" });
});

await test("commit(extra) merges extra over staged, then clears staged", async () => {
  const { Surface, fetchCalls } = loadRuntime();
  Surface.stage("region", "eu-west");
  await Surface.commit("choices", { confirmed: true });
  const posts = actionsPosts(fetchCalls);
  assert.deepEqual(plain(posts[0].body.data), { region: "eu-west", confirmed: true });
  assert.deepEqual(plain(Surface.staged()), {}, "staged cleared after commit");
});

await test("stage(key, undefined) unsets; clearStaged() empties", () => {
  const { Surface } = loadRuntime();
  Surface.stage("a", 1);
  Surface.stage("b", 2);
  Surface.stage("a", undefined);
  assert.deepEqual(plain(Surface.staged()), { b: 2 });
  Surface.clearStaged();
  assert.deepEqual(plain(Surface.staged()), {});
});

await test("a burst of 4 stages + 1 commit = ONE wake (the whole point)", async () => {
  const { Surface, fetchCalls } = loadRuntime();
  Surface.stage("g1", "agree");
  Surface.stage("g2", "agree");
  Surface.stage("g3", "agree");
  Surface.stage("g4", "agree");
  assert.equal(actionsPosts(fetchCalls).length, 0, "four selections, zero wakes");
  await Surface.commit("verdict", { kind: "approve" });
  assert.equal(actionsPosts(fetchCalls).length, 1, "one commit, one wake");
});

await test("commit() with no name rejects and preserves staged (no POST)", async () => {
  const { Surface, fetchCalls } = loadRuntime();
  Surface.stage("a", 1);
  await assert.rejects(() => Surface.commit(""), /action name is required/);
  assert.equal(actionsPosts(fetchCalls).length, 0, "a nameless commit never POSTs");
  assert.deepEqual(plain(Surface.staged()), { a: 1 }, "staged retained after rejected commit");
});

await test("a FAILED commit preserves staged data (intent is not lost)", async () => {
  const { Surface } = loadRuntime({ failActions: true });
  Surface.stage("region", "eu-west");
  Surface.stage("plan", "pro");
  await assert.rejects(() => Surface.commit("choices"), /commit failed/);
  assert.deepEqual(
    plain(Surface.staged()),
    { region: "eu-west", plan: "pro" },
    "staged retained after a server rejection — the user can retry",
  );
});

console.log("\nRuntime tests passed\n");
