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
function extractFunction(name: string): string {
  const match = appSrc.match(new RegExp(`function ${name}[\\s\\S]*?\\n\\}`));
  if (!match) throw new Error(`${name} not found in client/app.js (did it move or gain inner braces?)`);
  return match[0];
}

const sandbox: any = {};
vm.createContext(sandbox);
vm.runInContext(
  [
    extractFunction("surfaceFrameSrc"),
    extractFunction("versionSurfaceViewPath"),
    extractFunction("shouldRenderSurfaceCreated"),
    extractFunction("hueForId"),
    extractFunction("cardThumbUrl"),
    "this.surfaceFrameSrc = surfaceFrameSrc;",
    "this.versionSurfaceViewPath = versionSurfaceViewPath;",
    "this.shouldRenderSurfaceCreated = shouldRenderSurfaceCreated;",
    "this.hueForId = hueForId;",
    "this.cardThumbUrl = cardThumbUrl;",
  ].join("\n"),
  sandbox,
);
const surfaceFrameSrc: (device: boolean, origin: string, viewPath: string) => string | null =
  sandbox.surfaceFrameSrc;
const versionSurfaceViewPath: (viewPath: string, version: string) => string =
  sandbox.versionSurfaceViewPath;
const shouldRenderSurfaceCreated: (routeView: string, hasGrid: boolean) => boolean =
  sandbox.shouldRenderSurfaceCreated;
const hueForId: (id: string) => number = sandbox.hueForId;
const cardThumbUrl: (s: { id: string; updated_at?: string; created_at?: string }) => string =
  sandbox.cardThumbUrl;
const { renderThumbPlaceholder } = await import("../server/render.js");

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

test("initial iframe URL is cache-busted by the artifact revision", () => {
  assert.equal(
    versionSurfaceViewPath("/artifacts/x/view", "2026-07-23 13:46:03"),
    "/artifacts/x/view?v=2026-07-23%2013%3A46%3A03",
  );
  assert.equal(
    versionSurfaceViewPath("/artifacts/x/view?preview=1", "revision-2"),
    "/artifacts/x/view?preview=1&v=revision-2",
  );
});

test("an unrelated surface_created event never rerenders an open detail view", () => {
  assert.equal(shouldRenderSurfaceCreated("surface", false), false);
  assert.equal(shouldRenderSurfaceCreated("grid", false), true);
  assert.equal(shouldRenderSurfaceCreated("grid", true), false);
});

test("the PWA owns exactly one EventSource connection", () => {
  const eventSources = appSrc.match(/new EventSource\(/g) || [];
  assert.equal(eventSources.length, 1, "app.js must multiplex live events over its global stream");
});

// A surface's cover is drawn twice — client-side in the grid (`hueForId`) and
// server-side as the SVG placeholder (`hueForSeed`). They have to be the same
// picture, or a card visibly changes colour the moment anything falls back to
// the server route.
test("client and server derive the same cover hue for a surface", () => {
  for (const id of ["surface-one", "675c2133-b321-4f71-ad32-0a3b97cb09c6", "a", "z"]) {
    const svg = renderThumbPlaceholder({ id, title: "t", mime: "text/html" });
    const serverHue = Number((svg.match(/hsl\((\d+),/) || [])[1]);
    assert.equal(hueForId(id), serverHue, `hue mismatch for id ${JSON.stringify(id)}`);
  }
});

// The version key is what makes the route's immutable cache safe: drop it and
// every card would keep serving a year-stale capture.
test("card thumbnails are requested with a version key", () => {
  assert.equal(
    cardThumbUrl({ id: "abc", updated_at: "2026-07-23 13:46:03" }),
    "/artifacts/abc/thumb?v=2026-07-23%2013%3A46%3A03",
  );
  assert.equal(cardThumbUrl({ id: "a b", created_at: "x" }), "/artifacts/a%20b/thumb?v=x");
  assert.equal(cardThumbUrl({ id: "abc" }), "/artifacts/abc/thumb");
});

console.log("\nsurfaceFrameSrc tests passed\n");
