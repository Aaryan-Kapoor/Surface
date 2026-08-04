import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate the data dir BEFORE importing thumbs (getDataDir caches on first call).
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "surface-thumbs-test-"));
process.env.SURFACE_DATA_DIR = tmpRoot;

const { setThumbServerPort, getThumbPath } = await import("../server/thumbs.js");
const { renderThumbPlaceholder } = await import("../server/render.js");

function test(name: string, fn: () => void) {
  try {
    fn();
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
  fs.writeFileSync(path.join(tmpRoot, "db.sqlite"), "data");

  setThumbServerPort(0); // triggers sweepStaleChromeDirs()

  assert.ok(!fs.existsSync(path.join(tmpRoot, ".chrome-aaa")), "stale .chrome-aaa removed");
  assert.ok(!fs.existsSync(path.join(tmpRoot, ".chrome-bbb")), "stale .chrome-bbb removed");
  assert.ok(fs.existsSync(path.join(tmpRoot, "thumbs", "keep.png")), "thumbnails preserved");
  assert.ok(fs.existsSync(path.join(tmpRoot, "db.sqlite")), "database preserved");
});

test("boot sweep is a no-op when there are no scratch dirs", () => {
  // Second call: nothing left to sweep, must not throw or touch real files.
  setThumbServerPort(0);
  assert.ok(fs.existsSync(path.join(tmpRoot, "db.sqlite")), "database still preserved");
});

// getThumbPath is the defensive last line against an unsafe id reaching the FS.
test("getThumbPath rejects traversal / absolute ids, accepts safe ids", () => {
  assert.throws(() => getThumbPath("../evil"), /Invalid artifact id/);
  assert.throws(() => getThumbPath("/abs"), /Invalid artifact id/);
  assert.throws(() => getThumbPath("a/b"), /Invalid artifact id/);
  assert.equal(getThumbPath("good-id_1"), path.join(tmpRoot, "thumbs", "good-id_1.png"));
});

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

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log("\nThumbnail tests passed\n");
