import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// surfaceFrameSrc is the pure decision in client/app.js that keeps
// device-authored content off the trusted app origin. app.js is a browser script
// with heavy DOM dependencies, so rather than load the whole file we extract just
// this function (it has no inner braces) and exercise it in isolation — matching
// the repo's zero-dep, no-jsdom test convention (see test/runtime.ts).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appSrc = fs.readFileSync(path.join(__dirname, "..", "client", "app.js"), "utf8");
const match = appSrc.match(/function surfaceFrameSrc[\s\S]*?\n\}/);
if (!match) throw new Error("surfaceFrameSrc not found in client/app.js (did it move or gain inner braces?)");

const sandbox: any = {};
vm.createContext(sandbox);
vm.runInContext(match[0] + "\nthis.surfaceFrameSrc = surfaceFrameSrc;", sandbox);
const surfaceFrameSrc: (device: boolean, origin: string, viewPath: string) => string | null =
  sandbox.surfaceFrameSrc;

function test(name: string, fn: () => void) {
  try { fn(); console.log(`  PASS  ${name}`); }
  catch (err) { console.error(`  FAIL  ${name}`); throw err; }
}

console.log("\n=== app.js: surfaceFrameSrc (device content stays off the trusted origin) ===\n");

test("system surface loads same-origin (no content-origin prefix)", () => {
  assert.equal(surfaceFrameSrc(false, "http://h:3100", "/artifacts/x/view"), "/artifacts/x/view");
});

test("system surface ignores content origin even if one exists", () => {
  // A system artifact is as trusted as the agent that wrote it; it stays on the
  // app origin so the postMessage bridge and exec still work.
  assert.equal(surfaceFrameSrc(false, "", "/artifacts/x/view"), "/artifacts/x/view");
});

test("device surface loads from the content origin (never the app origin)", () => {
  assert.equal(
    surfaceFrameSrc(true, "http://h:3100", "/artifacts/x/view"),
    "http://h:3100/artifacts/x/view",
  );
});

test("device surface with NO content origin fails closed (null → placeholder)", () => {
  // The one thing that must never happen: device JS rendered on the app origin.
  assert.equal(surfaceFrameSrc(true, "", "/artifacts/x/view"), null);
});

console.log("\nsurfaceFrameSrc tests passed\n");
