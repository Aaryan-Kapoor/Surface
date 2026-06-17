import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate the data dir BEFORE importing thumbs (getDataDir caches on first call).
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "surface-thumbs-test-"));
process.env.SURFACE_DATA_DIR = tmpRoot;

const { setThumbServerPort, getThumbPath } = await import("../server/thumbs.js");

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

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log("\nThumbnail tests passed\n");
