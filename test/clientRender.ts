// The dashboard render path (client/app.js), exercised for real.
//
// Three properties are checked here, all of which used to be assertable only
// by opening a browser:
//
//   1. ESCAPING. A paired device may create and rename surfaces; the
//      system-plane dashboard renders those titles, and that dashboard can
//      POST /api/update/apply (a global npm install + a service restart). A
//      title that escapes its markup is therefore device-content → system-plane
//      script → host code execution. The test creates a hostile title through
//      the *device* plane of a real server, renders it through the real grid
//      code, and asserts the tree it produced holds no injected attribute.
//
//   2. STACKING. The empty state must not bury the header (which carries the
//      release pill) — the fresh-dashboard case is exactly where update
//      awareness matters.
//
//   3. THEME RESET. Applying a theme rewrites the two <meta name="theme-color">
//      tags; resetting has to put them back, or the PWA chrome stays wrong
//      until a reload.
//
// client/app.js is a browser script, so it runs here inside a vm context on
// test/fakeDom.ts — a small DOM that parses innerHTML into real attributes, so
// an injected `onmouseover=` shows up exactly as a browser would see it.
import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import vm from "node:vm";
import {
  allAttributes,
  FakeDocument,
  FakeElement,
  serializeNode,
} from "./fakeDom.js";
import { cleanupDir, killServer, makeClient, REPO_ROOT, sleep, spawnServer, tmpDir, waitForReady } from "./helpers.js";

let passed = 0;
const failures: string[] = [];

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err: any) {
    failures.push(name);
    console.error(`  FAIL  ${name}\n        ${err?.message || err}`);
  }
}

// The live Surface on this machine owns 3000/3100; test servers stay in a band
// that can never collide with it.
let nextPort = 35000 + (process.pid % 400) * 2;
function claimPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const port = nextPort++;
    if (port > 35999) { reject(new Error("out of test ports")); return; }
    const srv = net.createServer();
    srv.once("error", () => resolve(claimPort()));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(port)));
  });
}

// ── the harness ──

interface App {
  document: FakeDocument;
  window: any;
  run: (code: string) => any;
  appRoot: FakeElement;
}

function loadApp(): App {
  const doc = new FakeDocument();
  const appRoot = doc.createElement("div");
  appRoot.id = "app";
  doc.body.appendChild(appRoot);
  // The two tags client/index.html ships — applyTheme() rewrites them.
  for (const [content, media] of [["#0a0b0d", "(prefers-color-scheme: dark)"], ["#f6f6f7", "(prefers-color-scheme: light)"]]) {
    const meta = doc.createElement("meta");
    meta.setAttribute("name", "theme-color");
    meta.setAttribute("content", content);
    meta.setAttribute("media", media);
    doc.head.appendChild(meta);
  }

  const listeners = new Map<string, Function[]>();
  const win: any = {
    addEventListener: (type: string, fn: Function) => listeners.set(type, [...(listeners.get(type) || []), fn]),
    removeEventListener: () => {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    location: { hash: "", origin: "http://127.0.0.1", protocol: "http:", hostname: "127.0.0.1", reload() {} },
    innerWidth: 1280,
    innerHeight: 800,
    isSecureContext: false,
    open() {},
  };

  class FakeEventSource {
    static CLOSED = 2;
    readyState = 1;
    constructor(public url: string) {}
    addEventListener() {}
    close() { this.readyState = 2; }
  }

  const sandbox: any = {
    document: doc,
    window: win,
    location: win.location,
    navigator: { clipboard: { writeText: async () => {} } },
    localStorage: {
      store: new Map<string, string>(),
      getItem(k: string) { return this.store.has(k) ? this.store.get(k) : null; },
      setItem(k: string, v: string) { this.store.set(k, v); },
    },
    // Never-resolving: app.js's boot chain must not run behind the test's back.
    fetch: () => new Promise(() => {}),
    EventSource: FakeEventSource,
    Image: class { constructor() { return doc.createElement("img"); } },
    console,
    // Deterministic: no timer in app.js is load-bearing for what is asserted
    // here, and a live one would keep the suite alive.
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: () => 0,
    confirm: () => false,
    alert: () => {},
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, "client", "app.js"), "utf8"), sandbox, { filename: "client/app.js" });
  return {
    document: doc,
    window: win,
    appRoot,
    run: (code: string) => vm.runInContext(code, sandbox),
  };
}

function renderGridWith(app: App, surfaces: unknown[]): void {
  app.run(`surfaces = JSON.parse(${JSON.stringify(JSON.stringify(surfaces))}); renderGrid();`);
}

// Anything a browser would fire as script: inline handlers, javascript: URLs.
function injectedAttributes(root: FakeElement): string[] {
  return allAttributes(root)
    .filter(({ name, value }) => /^on[a-z]+$/.test(name) || /^\s*javascript:/i.test(value))
    .map(({ el, name, value }) => `<${el.tagName} ${name}="${value}">`);
}

// ── the fixtures ──

const HOSTILE_TITLE = `" onmouseover="alert(1)" x="`;
const HOSTILE_TITLES = [
  HOSTILE_TITLE,
  `' onfocus='alert(2)`,
  `<img src=x onerror=alert(3)>`,
  `</div><script>alert(4)</script>`,
];

const scratch = tmpDir("surface-client-render-");
let server: ChildProcess | null = null;
let port = 0;

try {
  console.log("\n=== client/app.js: escaping, stacking, theme ===\n");

  // ══ 1. the escapers themselves ══════════════════════════════════════════
  const app = loadApp();

  check("escapeAttr escapes the quotes that break out of an attribute", () => {
    const out = app.run(`escapeAttr('" onmouseover="x" \\'')`);
    assert.ok(!/["']/.test(out), `escapeAttr left a raw quote: ${out}`);
    assert.ok(out.includes("&quot;"), out);
    assert.ok(out.includes("&#39;"), out);
  });

  check("escapeText escapes the characters that break out of a text node", () => {
    const out = app.run(`escapeText('<b>&</b>')`);
    assert.equal(out, "&lt;b&gt;&amp;&lt;/b&gt;");
  });

  check("no attribute in app.js interpolates anything but escapeAttr/encodeURIComponent", () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, "client", "app.js"), "utf8");
    // `="${…}"` is an attribute-value interpolation. Every one of them has to
    // use the attribute encoder — escapeText() is NOT safe here (it leaves
    // quotes alone), which is exactly how the card title became a sink.
    const bad: string[] = [];
    for (const m of src.matchAll(/=(["'])\$\{([^}]*)\}/g)) {
      const expr = m[2];
      if (/escapeAttr\(|encodeURIComponent\(/.test(expr)) continue;
      bad.push(m[0]);
    }
    assert.deepEqual(bad, [], `unsafe attribute interpolation(s): ${bad.join(", ")}`);
  });

  // ══ 2. a hostile title through the real device plane ════════════════════
  port = await claimPort();
  const contentPort = await claimPort();
  const dataDir = path.join(scratch, "data");
  const base = `http://127.0.0.1:${port}`;
  const contentBase = `http://127.0.0.1:${contentPort}`;
  server = spawnServer(port, dataDir, {}, contentPort);
  await waitForReady(base, "/display/config");
  await waitForReady(contentBase, "/display/config");
  const appReq = makeClient(base);
  const contentReq = makeClient(contentBase);

  // The content listener resolves to `device` by construction (see
  // docs/auth/trust-model.md), so this is a genuine lower-trust author.
  const created: string[] = [];
  for (const [i, title] of HOSTILE_TITLES.entries()) {
    const res = await contentReq("POST", "/artifacts", {
      body: { title, mime: "text/html", content: "<p>hi</p>" },
    });
    if (res.status === 201) created.push(res.body?.artifact?.id);
    else console.error(`    (device create ${i} answered ${res.status}: ${JSON.stringify(res.body).slice(0, 200)})`);
  }
  check("a device-plane caller can author a surface with any title it likes", () => {
    assert.equal(created.length, HOSTILE_TITLES.length);
  });

  const cards = (await appReq("GET", "/artifacts")).body as any[];
  check("the dashboard's own card feed carries the hostile titles verbatim", () => {
    assert.ok(Array.isArray(cards) && cards.length >= HOSTILE_TITLES.length, JSON.stringify(cards).slice(0, 200));
    for (const title of HOSTILE_TITLES) {
      assert.ok(cards.some((c) => c.title === title), `server did not store ${JSON.stringify(title)}`);
    }
    for (const card of cards) {
      const meta = typeof card.metadata === "string" ? JSON.parse(card.metadata) : card.metadata || {};
      assert.equal(meta.author_plane, "device", "fixture must be device-authored");
    }
  });

  const grid = loadApp();
  renderGridWith(grid, cards);

  check("the rendered grid contains no injected event handler or javascript: URL", () => {
    const injected = injectedAttributes(grid.document.documentElement);
    assert.deepEqual(injected, [], `injected attribute(s): ${injected.join(" ")}`);
  });

  check("no injected element smuggled itself into the tree", () => {
    // `<img src=x onerror=…>` and `</div><script>` both have to land as text.
    assert.equal(grid.document.querySelectorAll("script").length, 0, "a <script> element was parsed into the dashboard");
    const imgs = grid.document.querySelectorAll("img");
    for (const img of imgs) {
      assert.ok(
        (img.getAttribute("src") || "").startsWith("/artifacts/"),
        `unexpected <img src=${img.getAttribute("src")}>`,
      );
    }
  });

  check("each card renders its title as text, and as an exact title attribute", () => {
    const titles = grid.document.querySelectorAll(".card-title");
    assert.equal(titles.length, cards.length, "one .card-title per card");
    for (const title of HOSTILE_TITLES) {
      const el = titles.find((t) => t.textContent === title);
      assert.ok(el, `no .card-title rendering ${JSON.stringify(title)} as text`);
      assert.equal(el!.getAttribute("title"), title, "the tooltip attribute must hold the raw title, not markup");
    }
  });

  check("the grid survives a serialize → reparse round trip with nothing injected", () => {
    // Text nodes legitimately contain the raw title (browsers do not escape
    // quotes in text), so the honest check is structural: serialize the tree the
    // way a browser would, parse it back, and look for anything executable.
    const html = serializeNode(grid.document.documentElement);
    const reparsed = new FakeElement("div");
    reparsed.innerHTML = html;
    const injected = injectedAttributes(reparsed);
    assert.deepEqual(injected, [], `injected attribute(s) after round trip: ${injected.join(" ")}`);
    assert.equal(reparsed.querySelectorAll("script").length, 0, "a <script> element survived the round trip");
  });

  // The finder (⌘K) renders the same titles from the same list.
  check("the ⌘K finder renders hostile titles without injecting anything", () => {
    const finder = loadApp();
    finder.run(`surfaces = JSON.parse(${JSON.stringify(JSON.stringify(cards))}); openSurfaceFinder();`);
    const injected = injectedAttributes(finder.document.documentElement);
    assert.deepEqual(injected, [], `injected attribute(s): ${injected.join(" ")}`);
    const results = finder.document.querySelectorAll(".finder-result-title");
    assert.equal(results.length, cards.length);
    assert.ok(results.some((r) => r.textContent === HOSTILE_TITLE), "the finder must render the raw title as text");
  });

  // The surface detail header renders one title, and a search box round-trips
  // whatever the user typed back into a value attribute.
  check("the grid search box cannot break out of its value attribute", () => {
    const searched = loadApp();
    searched.run(`gridQuery = '" onfocus="alert(1)'; surfaces = JSON.parse(${JSON.stringify(JSON.stringify(cards))}); renderGrid();`);
    const injected = injectedAttributes(searched.document.documentElement);
    assert.deepEqual(injected, [], `injected attribute(s): ${injected.join(" ")}`);
    const input = searched.document.querySelector(".grid-search");
    assert.ok(input, "the header search input is missing");
    assert.equal(input!.getAttribute("value"), `" onfocus="alert(1)`);
  });

  check("the update notice renders server text without injecting anything", () => {
    const notice = loadApp();
    notice.run(`surfaces = JSON.parse(${JSON.stringify(JSON.stringify(cards))}); renderGrid();`);
    notice.run(`applyUpdateStatus({
      current: "0.2.3",
      latest: "9.9.9",
      update_available: true,
      can_apply: false,
      apply_blocked_reason: '" onmouseover="alert(1)',
      run: { phase: "failed", started_at: "s", error: '<img src=x onerror=alert(1)>" onmouseover="alert(2)' },
    });`);
    const injected = injectedAttributes(notice.document.documentElement);
    assert.deepEqual(injected, [], `injected attribute(s): ${injected.join(" ")}`);
    const text = notice.document.querySelector(".update-notice-text");
    assert.ok(text && text.textContent.includes("<img src=x onerror=alert(1)>"), "the error must render as text");
  });

  // ══ 3. the empty state must not bury the header ═════════════════════════
  const emptyApp = loadApp();
  renderGridWith(emptyApp, []);

  check("a fresh dashboard still renders the header (and the release pill's host)", () => {
    const header = emptyApp.document.querySelector(".grid-header");
    assert.ok(header, "no .grid-header rendered");
    assert.ok(emptyApp.document.querySelector("#update-notice"), "no release-pill host rendered");
  });

  check("the empty state shares the header's stacking context instead of covering it", () => {
    // .grid-view is `position: relative; z-index: 1`, i.e. a stacking context.
    // While the empty state lived outside it, the header's z-index:20 could not
    // escape — an opaque z-index:3 panel painted straight over it. Keeping the
    // empty state inside .grid-view puts both in one context, where the
    // header's higher z-index wins.
    const gridView = emptyApp.document.querySelector(".grid-view");
    assert.ok(gridView, "no .grid-view rendered");
    const empty = emptyApp.document.querySelector(".empty-state");
    assert.ok(empty, "no .empty-state rendered");
    assert.ok(gridView!.contains(empty), ".empty-state must render inside .grid-view, not as a sibling over it");
    assert.ok(gridView!.querySelector(".grid-header"), "the header must live in the same stacking context");
  });

  check("the stylesheet keeps the empty state below the header", () => {
    const css = fs.readFileSync(path.join(REPO_ROOT, "client", "style.css"), "utf8");
    const zIndexOf = (selector: string) => {
      const rule = new RegExp(`\\n${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css);
      assert.ok(rule, `no rule for ${selector}`);
      const z = /z-index:\s*(-?\d+)/.exec(rule![1]);
      assert.ok(z, `${selector} has no z-index`);
      return Number(z![1]);
    };
    assert.ok(
      zIndexOf(".empty-state") < zIndexOf(".grid-header"),
      "the empty state must paint below the sticky header",
    );
  });

  // ══ 4. theme reset restores the PWA chrome ══════════════════════════════
  const themed = loadApp();
  const metaState = () =>
    themed.document.querySelectorAll('meta[name="theme-color"]')
      .map((m) => `${m.getAttribute("content")}|${m.getAttribute("media") ?? ""}`);
  const before = metaState();

  check("applying a theme overrides both theme-color metas", () => {
    themed.run(`applyTheme({ colors: { void: "#123456" } });`);
    const after = metaState();
    assert.ok(after.every((s) => s.startsWith("#123456")), JSON.stringify(after));
  });

  check("resetting the theme restores the shipped theme-color metas", () => {
    themed.run(`applyTheme({});`);
    assert.deepEqual(metaState(), before, "theme-color metas were not restored on reset");
  });

  check("a second apply/reset cycle still restores the originals", () => {
    themed.run(`applyTheme({ background: "#abcdef" }); applyTheme({});`);
    assert.deepEqual(metaState(), before);
  });
} finally {
  await killServer(server, port).catch(() => {});
  await sleep(100);
  cleanupDir(scratch);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  FAILED: ${f}`);
  process.exitCode = 1;
} else {
  console.log("client render tests passed");
}
