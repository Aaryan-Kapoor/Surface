import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Isolate the data dir BEFORE importing thumbs (getDataDir caches on first call).
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "surface-thumbs-test-"));
// On exit, not after the last assertion: a bare rmSync at the end of the file
// only runs when every check passed, so each failing run — including every
// deliberate red run used to prove a fix bites — left its scratch dir behind.
process.on("exit", () => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // best effort; the suite's result is what matters
  }
});
process.env.SURFACE_DATA_DIR = tmpRoot;
// A binary that cannot start: the launch-failure path is what the backfill
// recovery tests are about, and it guarantees no real Chrome is ever spawned
// by this suite.
process.env.SURFACE_CHROME = path.join(tmpRoot, "no-such-chrome");
process.env.SURFACE_THUMB_LAUNCH_BACKOFF_MS = "300";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const {
  attachCdp,
  currentThumbGeneration,
  enqueueThumb,
  getThumbPath,
  hasAnyThumb,
  hasThumb,
  installChromeExitBackstop,
  needsThumbCapture,
  removeThumbs,
  resolveThumbFile,
  setThumbServerPort,
  shutdownThumbnails,
  thumbGenerationFor,
  thumbQueueStats,
} = await import("../server/thumbs.js");
const { renderThumbPlaceholder } = await import("../server/render.js");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    throw err;
  }
}

async function atest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    throw err;
  }
}

console.log("\n=== Thumbnail Tests ===\n");

// The boot sweep is what stops headless-Chrome scratch dirs from accumulating
// across restarts: every leftover `.chrome-*` under the data dir is stale at
// boot and must be removed — but real data must be left untouched.
test("boot sweep clears stale .chrome-* dirs and keeps real files", () => {
  fs.mkdirSync(path.join(tmpRoot, ".chrome-aaa"), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, ".chrome-aaa", "SingletonLock"), "x"); // simulate Chrome's locked file
  fs.mkdirSync(path.join(tmpRoot, ".chrome-bbb", "Default"), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, "thumbs"), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, "thumbs", "keep.png"), "img");
  fs.writeFileSync(path.join(tmpRoot, "keepme.txt"), "data");

  setThumbServerPort(0); // triggers sweepStaleChromeDirs()

  assert.ok(!fs.existsSync(path.join(tmpRoot, ".chrome-aaa")), "stale .chrome-aaa removed");
  assert.ok(!fs.existsSync(path.join(tmpRoot, ".chrome-bbb")), "stale .chrome-bbb removed");
  assert.ok(fs.existsSync(path.join(tmpRoot, "thumbs", "keep.png")), "thumbnails preserved");
  assert.ok(fs.existsSync(path.join(tmpRoot, "keepme.txt")), "real data preserved");
});

test("boot sweep is a no-op when there are no scratch dirs", () => {
  // Second call: nothing left to sweep, must not throw or touch real files.
  setThumbServerPort(0);
  assert.ok(fs.existsSync(path.join(tmpRoot, "keepme.txt")), "real data still preserved");
});

// ── Generations ──
//
// A cached capture is a picture of one revision. Serving it from a location
// keyed on the id alone is what let an immutable (one-year) response hand out
// the *previous* revision's bytes under the new revision's cache key.

const GEN_A = thumbGenerationFor({ current_version_id: "v1", updated_at: "2026-08-04 10:00:00" })!;
const GEN_B = thumbGenerationFor({ current_version_id: "v2", updated_at: "2026-08-04 10:00:04" })!;

test("the thumbnail path is keyed on the revision, not just the id", () => {
  assert.match(GEN_A, /^[0-9a-f]{16}$/, "generation must be a filesystem-safe token");
  assert.equal(getThumbPath("good-id_1", GEN_A), path.join(tmpRoot, "thumbs", `good-id_1.${GEN_A}.png`));
  assert.notEqual(getThumbPath("good-id_1", GEN_A), getThumbPath("good-id_1", GEN_B));
});

// getThumbPath is the defensive last line against an unsafe id reaching the FS —
// and the generation now lands in the same path, so it is validated on the same
// terms rather than trusted because "we made it".
test("getThumbPath rejects traversal / absolute ids and hostile generations", () => {
  assert.throws(() => getThumbPath("../evil", GEN_A), /Invalid artifact id/);
  assert.throws(() => getThumbPath("/abs", GEN_A), /Invalid artifact id/);
  assert.throws(() => getThumbPath("a/b", GEN_A), /Invalid artifact id/);
  assert.throws(() => getThumbPath("good", "../../etc/passwd"), /Invalid thumbnail generation/);
  assert.throws(() => getThumbPath("good", ""), /Invalid thumbnail generation/);
});

test("a new version OR a new updated_at is a new generation", () => {
  const base = { current_version_id: "v1", updated_at: "2026-08-04 10:00:00" };
  assert.equal(thumbGenerationFor(base), thumbGenerationFor({ ...base }), "same revision, same generation");
  assert.notEqual(thumbGenerationFor(base), thumbGenerationFor({ ...base, current_version_id: "v2" }));
  // A touch or a metadata edit moves updated_at without publishing a version,
  // and it can absolutely change the picture.
  assert.notEqual(thumbGenerationFor(base), thumbGenerationFor({ ...base, updated_at: "2026-08-04 10:00:01" }));
  assert.equal(thumbGenerationFor(undefined), null);
});

// The heart of the cache bug: with the old `<id>.png` layout, a request for
// revision B found revision A's file and reported a hit.
test("a capture of the previous revision never counts as the current one", () => {
  const id = "revision-surface";
  removeThumbs(id);
  fs.writeFileSync(getThumbPath(id, GEN_A), "A-bytes");

  assert.equal(hasThumb(id, GEN_A), true, "the revision that was captured is a hit");
  assert.equal(hasThumb(id, GEN_B), false, "the revision that was NOT captured must not be a hit");

  const forB = resolveThumbFile(id, GEN_B);
  assert.ok(forB, "the older capture is still worth showing");
  assert.equal(forB!.exact, false, "…but never as if it were revision B — that is what forbids `immutable`");
  assert.equal(fs.readFileSync(forB!.path, "utf8"), "A-bytes");

  const forA = resolveThumbFile(id, GEN_A);
  assert.equal(forA!.exact, true);
  assert.equal(forA!.path, getThumbPath(id, GEN_A));

  assert.equal(hasAnyThumb(id), true);
  removeThumbs(id);
  assert.equal(hasAnyThumb(id), false, "deleting a surface must remove every generation, not just one");
  assert.equal(resolveThumbFile(id, GEN_A), null);
});

// Pre-generation releases wrote `<id>.png`. Those files have unknown provenance,
// so they are shown as a stand-in but must never satisfy a versioned request.
test("a legacy <id>.png is a stand-in, never an exact revision", () => {
  const id = "legacy-surface";
  fs.writeFileSync(path.join(tmpRoot, "thumbs", `${id}.png`), "legacy");
  const resolved = resolveThumbFile(id, GEN_A);
  assert.ok(resolved && resolved.exact === false, "a legacy file can never be an exact revision match");
  assert.equal(hasAnyThumb(id), true, "…but the card should still show it rather than a cover");
  removeThumbs(id);
  assert.equal(hasAnyThumb(id), false);
});

// ── Signal ownership ──
//
// server/index.ts owns SIGINT/SIGTERM. The thumbnailer installing its own
// handlers meant both fired on a restart and the thumbs one called
// process.exit(130/143) before the HTTP close callback and closeDb() finished.

test("the thumbnailer never takes SIGINT/SIGTERM off the server", () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, "server", "thumbs.ts"), "utf8");
  // Comments explain the defect these assertions guard, so read the code only.
  const code = src.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  assert.ok(
    !/process\.on(?:ce)?\(\s*["']SIG/.test(code),
    "server/index.ts is the sole signal owner; thumbs.ts must not register SIGINT/SIGTERM",
  );
  assert.ok(
    !/process\.exit\s*\(/.test(code),
    "thumbs.ts must never end the process — that is what truncated graceful shutdown",
  );

  const before = {
    sigint: process.listenerCount("SIGINT"),
    sigterm: process.listenerCount("SIGTERM"),
    exit: process.listenerCount("exit"),
  };
  installChromeExitBackstop();
  installChromeExitBackstop(); // idempotent
  assert.equal(process.listenerCount("SIGINT"), before.sigint, "no SIGINT listener may be added");
  assert.equal(process.listenerCount("SIGTERM"), before.sigterm, "no SIGTERM listener may be added");
  assert.equal(
    process.listenerCount("exit"),
    before.exit + 1,
    "exactly one synchronous exit backstop, installed once",
  );
});

test("server/index.ts reaps chrome inside its own graceful sequence", () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, "server", "index.ts"), "utf8");
  assert.ok(src.includes("shutdownThumbnails"), "the shutdown sequence must tear the thumbnailer down itself");
  const shutdownBody = src.slice(src.indexOf("function shutdown("));
  assert.ok(
    shutdownBody.includes("shutdownThumbnails()"),
    "shutdownThumbnails must be called from shutdown(), not left to a signal handler",
  );
});

// ── CDP deadlines ──
//
// The 30s job timeout used to bound nothing: `Promise.race` rejected while the
// underlying CDP request kept waiting, and the cleanup that followed awaited the
// same socket. A live-but-wedged connection held a worker forever, so
// `Promise.all(workers)` never resolved and the queue was dead until restart.

function stubSocket() {
  const listeners: Record<string, Array<(ev: any) => void>> = {};
  const sent: any[] = [];
  return {
    sent,
    closed: false,
    addEventListener(type: string, fn: (ev: any) => void) {
      (listeners[type] ||= []).push(fn);
    },
    send(data: string) { sent.push(JSON.parse(data)); },
    close() { this.closed = true; },
    emit(type: string, ev: any) { for (const fn of listeners[type] || []) fn(ev); },
    reply(id: number, result: any) { this.emit("message", { data: JSON.stringify({ id, result }) }); },
    event(sessionId: string, method: string, params: any) {
      this.emit("message", { data: JSON.stringify({ sessionId, method, params }) });
    },
  };
}

await atest("a CDP command that is never answered rejects on its own deadline", async () => {
  const ws = stubSocket();
  const cdp = attachCdp(ws);
  const started = Date.now();
  await assert.rejects(
    cdp.send("Page.enable", {}, "session-1", 120),
    /cdp timeout after 120ms/,
    "every command needs a deadline, not just the job as a whole",
  );
  assert.ok(Date.now() - started < 3000, "the deadline must actually fire");
  // A page that wedges is the page's problem: the browser is still fine.
  assert.equal(cdp.unhealthy, false, "a session-level timeout must not condemn the browser");

  // The request is cancelled, not merely abandoned: a late reply is ignored
  // rather than resolving a promise nobody is holding.
  const id = ws.sent[0].id;
  ws.reply(id, { ok: true });
  await sleep(10);
});

await atest("a browser-level command that hangs condemns the browser", async () => {
  const ws = stubSocket();
  const cdp = attachCdp(ws);
  await assert.rejects(cdp.send("Target.createBrowserContext", {}, undefined, 100), /cdp timeout/);
  assert.equal(cdp.unhealthy, true, "chrome not answering a browser-level command means recycle it");
});

await atest("an event waiter has a deadline and a cancellation path", async () => {
  const ws = stubSocket();
  const cdp = attachCdp(ws);
  // The load event that never comes used to be an unbounded await.
  await assert.rejects(
    cdp.once("Page.loadEventFired", "session-1", 120),
    /cdp event timeout after 120ms/,
  );
  // A late event must not blow up on a waiter that has already been removed.
  ws.event("session-1", "Page.loadEventFired", {});
  await sleep(10);

  // …and the happy path still works, only for its own session.
  const wanted = cdp.once("Page.loadEventFired", "session-2", 2000);
  ws.event("session-3", "Page.loadEventFired", { wrong: true });
  ws.event("session-2", "Page.loadEventFired", { right: true });
  assert.deepEqual(await wanted, { right: true });
});

await atest("closing the connection fails everything waiting on it", async () => {
  const ws = stubSocket();
  const cdp = attachCdp(ws);
  const cmd = cdp.send("Page.enable", {}, "session-1", 10_000);
  const evt = cdp.once("Page.loadEventFired", "session-1", 10_000);
  cdp.close();
  await assert.rejects(cmd, /cdp connection closed/);
  await assert.rejects(evt, /cdp connection closed/);
  assert.equal(ws.closed, true, "the socket itself must be closed too");
  await assert.rejects(cdp.send("Page.enable", {}, "session-1", 10), /cdp connection closed/);
});

// ── Queue recovery ──

const { initDb, getDb, closeDb } = await import("../server/db.js");
const { createArtifact, updateArtifact } = await import("../server/artifacts.js");

initDb();

// A port number, not a listener: SURFACE_CHROME points at nothing, so no
// capture is ever attempted against it.
const FAKE_PORT = 34731;
const backfillId = "backfill-surface";

await atest("a chrome that will not start keeps the backfill instead of discarding it", async () => {
  createArtifact(getDb(), {
    id: backfillId,
    title: "Backfill Surface",
    mime: "text/html",
    files: [{ path: "index.html", content: "<!doctype html><h1>hi</h1>", mime: "text/html" }],
  });
  setThumbServerPort(FAKE_PORT);
  assert.equal(needsThumbCapture(backfillId), true, "a fresh surface has no capture yet");

  enqueueThumb(backfillId);
  await sleep(250);

  const stats = thumbQueueStats();
  // Redesigned cards with `has_thumb: false` paint their own cover and never
  // request the thumb route, so a discarded boot-backfill job is never
  // naturally re-enqueued: the surface would wear its cover forever.
  assert.equal(stats.queued, 1, "a launch failure must not discard queued backfill work");
  assert.ok(stats.launchAttempts >= 1, "the drain must have tried to start chrome");
  const leaked = fs.readdirSync(tmpRoot).filter((n) => n.startsWith(".chrome-"));
  assert.deepEqual(leaked, [], "a failed launch must still remove its profile dir");
});

await atest("the queue is re-drained when the launch backoff expires", async () => {
  const before = thumbQueueStats().launchAttempts;
  await sleep(700); // SURFACE_THUMB_LAUNCH_BACKOFF_MS = 300
  const after = thumbQueueStats();
  assert.ok(
    after.launchAttempts > before,
    `the backoff must schedule a retry (attempts ${before} → ${after.launchAttempts})`,
  );
  assert.equal(after.queued, 1, "and the work must still be there to retry");
});

await atest("a revision supersedes its predecessor in the queue instead of stacking", async () => {
  const genBefore = currentThumbGeneration(backfillId);
  enqueueThumb(backfillId);
  assert.equal(thumbQueueStats().queued, 1, "the same revision must not be queued twice");
  assert.equal(thumbQueueStats().jobs[0].generation, genBefore);

  // Publish a new revision. `updated_at` has second resolution, so bump the
  // version row — that alone must move the generation.
  updateArtifact(getDb(), backfillId, {
    files: [{ path: "index.html", content: "<!doctype html><h1>changed</h1>", mime: "text/html" }],
    reason: "test_update",
  });
  const genAfter = currentThumbGeneration(backfillId);
  assert.notEqual(genAfter, genBefore, "a new version is a new generation");

  enqueueThumb(backfillId);
  const jobs = thumbQueueStats().jobs;
  assert.equal(jobs.length, 1, "the superseded job must be dropped, not left to race the new one");
  assert.equal(jobs[0].generation, genAfter, "the queued job must carry the current revision");
});

await atest("shutdownThumbnails is idempotent and stops accepting work", async () => {
  await shutdownThumbnails();
  await shutdownThumbnails();
  enqueueThumb(backfillId);
  assert.equal(thumbQueueStats().queued, 0, "no new work after shutdown");
});

closeDb();

// ── Placeholder cover ──
// This is the picture the grid shows before a capture exists, so it has to be a
// designed object: the surface's title, legible, on a field keyed to its id.

test("cover carries the full title and the kind label", () => {
  const svg = renderThumbPlaceholder({ id: "abc", title: "Ask Approval", mime: "text/html" });
  assert.match(svg, /Ask Approval/, "title present");
  assert.match(svg, />HTML</, "kind label present");
  assert.match(svg, /viewBox="0 0 600 600"/, "600x600 cover");
});

test("cover escapes titles rather than letting them build markup", () => {
  const svg = renderThumbPlaceholder({ id: "x", title: '<script>alert(1)</script>', mime: "text/html" });
  assert.ok(!svg.includes("<script>"), "raw script tag must not survive into the SVG");
  assert.match(svg, /&lt;script&gt;/, "title is escaped");
});

// The cover is served from /artifacts/:id/thumb as `image/svg+xml`, which a
// browser renders as a *document* on the app origin — so a title that could
// close a text node or an attribute would be stored XSS, not a cosmetic bug.
test("a hostile title cannot break out of the SVG text node or its attributes", () => {
  const hostile = `</text><script>alert(1)</script><text x="0" y="0" onload="alert(2)" ' " & <![CDATA[`;
  const svg = renderThumbPlaceholder({ id: "x", title: hostile, mime: "text/html" });
  assert.ok(!svg.includes("<script"), "no element may be forged out of a title");
  // The escaped text `onload=&quot;…&quot;` is inert; a real handler needs a
  // surviving quote to open its value.
  assert.ok(!/on[a-z]+\s*=\s*["']/.test(svg), "no event handler may be forged out of a title");
  assert.ok(!svg.includes("<![CDATA["), "a title must not be able to open a CDATA section");
  // No title text may carry markup delimiters at all: that is what stops it
  // closing its own <text> node and starting an element of its own.
  const textNodes = [...svg.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map((m) => m[1]);
  assert.ok(textNodes.length >= 2, "expected a label plus title lines");
  for (const node of textNodes) {
    assert.ok(!node.includes("<") && !node.includes(">"), `raw markup survived into a text node: ${node}`);
  }
  assert.ok((svg.match(/<text\b/g) || []).length <= 4, "a title must not be able to add elements");
  // The aria-label attribute is the other injection surface: it is quoted, so
  // both quote characters have to be entities.
  const ariaLabel = (svg.match(/aria-label="([^"]*)"/) || [])[1];
  assert.ok(ariaLabel !== undefined, "aria-label must still be a single well-formed attribute");
  assert.ok(!ariaLabel.includes('"') && !ariaLabel.includes("'"), "quotes must be escaped inside the attribute");
  assert.equal((svg.match(/<svg/g) || []).length, 1, "still exactly one root element");
});

// XML 1.0 forbids most C0 control characters outright. A title carrying one
// would make the whole cover a parse error — a blank card rather than a picture.
test("cover survives control characters in a title", () => {
  const svg = renderThumbPlaceholder({ id: "x", title: "we\u0000ir\u0007d ti\u001ftle", mime: "text/html" });
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(svg), "no raw C0 control may reach the SVG");
  assert.match(svg, /weird/, "the legible part of the title survives");
});

// The dashboard crops a 600x600 cover to 16:10 from the TOP edge, so every line
// of the title has to sit inside the top ~375px or it is simply not on the card.
test("cover keeps its text inside the visible top crop", () => {
  const svg = renderThumbPlaceholder({
    id: "x",
    title: "Migration notes for the ingest queue cutover and rollback plan",
    mime: "text/markdown",
  });
  const ys = [...svg.matchAll(/<text[^>]*\sy="(\d+)"/g)].map((m) => Number(m[1]));
  assert.ok(ys.length >= 2, "expected a label plus title lines");
  assert.ok(Math.max(...ys) <= 375, `text must stay above the 16:10 crop line, saw y=${Math.max(...ys)}`);
});

test("cover wraps to at most three lines and ellipsises the overflow", () => {
  const svg = renderThumbPlaceholder({
    id: "x",
    title: "one two three four five six seven eight nine ten eleven twelve thirteen",
    mime: "text/html",
  });
  const titleLines = [...svg.matchAll(/font-size="45"[^>]*>([^<]*)</g)].map((m) => m[1]);
  assert.ok(titleLines.length <= 3, `expected <= 3 title lines, got ${titleLines.length}`);
  assert.ok(titleLines[titleLines.length - 1].endsWith("…"), "truncated title must end in an ellipsis");
});

// Two covers inlined into one document must not share gradient ids, or every
// card after the first wears the first card's colour.
test("cover namespaces its gradient ids per surface", () => {
  const a = renderThumbPlaceholder({ id: "surface-one", title: "One", mime: "text/html" });
  const b = renderThumbPlaceholder({ id: "surface-two", title: "Two", mime: "text/html" });
  const idOf = (svg: string) => (svg.match(/<linearGradient id="([^"]+)"/) || [])[1];
  assert.ok(idOf(a), "gradient id present");
  assert.notEqual(idOf(a), idOf(b), "different surfaces must not share a gradient id");
  assert.ok(a.includes(`url(#${idOf(a)})`), "the rect must reference its own gradient");
});

test("cover colour is stable per id and spread across ids", () => {
  const hue = (id: string) => {
    const m = renderThumbPlaceholder({ id, title: "t", mime: "text/html" }).match(/hsl\((\d+),/);
    return m ? Number(m[1]) : -1;
  };
  assert.equal(hue("stable-id"), hue("stable-id"), "same id must give the same colour");
  // Sequential ids used to walk the hue wheel in lockstep and land on the same
  // colour family; the hash has to scatter them.
  const hues = ["surface-1", "surface-2", "surface-3", "surface-4", "surface-5"].map(hue);
  const spread = Math.max(...hues) - Math.min(...hues);
  assert.ok(spread > 90, `neighbouring ids should not cluster, spread was ${spread}`);
});

console.log("\nThumbnail tests passed\n");
