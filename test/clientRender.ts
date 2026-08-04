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
  /** Handlers currently registered on `window` for `type`. */
  windowListeners: (type: string) => Function[];
  /** Every element still registered with the thumbnail IntersectionObserver. */
  observedThumbs: () => FakeElement[];
}

interface AppOptions {
  /**
   * Give the sandbox an IntersectionObserver. Off by default: with one, thumbs
   * wait for an intersection that never comes in a headless DOM, so the tests
   * that read `img.src` want the eager path.
   */
  intersectionObserver?: boolean;
}

function loadApp(options: AppOptions = {}): App {
  const doc = new FakeDocument();
  const appRoot = doc.createElement("div");
  appRoot.id = "app";
  doc.body.appendChild(appRoot);
  // The two tags client/index.html ships — applyTheme() rewrites them.
  for (const [content, media] of [["#0a0a0a", "(prefers-color-scheme: dark)"], ["#f6f6f7", "(prefers-color-scheme: light)"]]) {
    const meta = doc.createElement("meta");
    meta.setAttribute("name", "theme-color");
    meta.setAttribute("content", content);
    meta.setAttribute("media", media);
    doc.head.appendChild(meta);
  }

  const listeners = new Map<string, Function[]>();
  const win: any = {
    addEventListener: (type: string, fn: Function) => listeners.set(type, [...(listeners.get(type) || []), fn]),
    // A real removal: "how many listeners are still on window" is a property
    // this suite asserts, and a no-op would make every answer wrong.
    removeEventListener: (type: string, fn: Function) => {
      listeners.set(type, (listeners.get(type) || []).filter((f) => f !== fn));
    },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    location: { hash: "", origin: "http://127.0.0.1", protocol: "http:", hostname: "127.0.0.1", reload() {} },
    innerWidth: 1280,
    innerHeight: 800,
    isSecureContext: false,
    open() {},
  };

  // Records what is observed and never fires — a real IntersectionObserver
  // keeps its targets alive, so "what is still registered" is exactly the
  // retention question the leak test asks.
  const observers: any[] = [];
  class FakeIntersectionObserver {
    targets = new Set<FakeElement>();
    constructor(public cb: Function, public opts: unknown) { observers.push(this); }
    observe(el: FakeElement) { this.targets.add(el); }
    unobserve(el: FakeElement) { this.targets.delete(el); }
    disconnect() { this.targets.clear(); }
  }

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
  if (options.intersectionObserver) {
    sandbox.IntersectionObserver = FakeIntersectionObserver;
    // app.js feature-detects with `"IntersectionObserver" in window`.
    win.IntersectionObserver = FakeIntersectionObserver;
  }
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, "client", "app.js"), "utf8"), sandbox, { filename: "client/app.js" });
  return {
    document: doc,
    window: win,
    appRoot,
    run: (code: string) => vm.runInContext(code, sandbox),
    windowListeners: (type: string) => [...(listeners.get(type) || [])],
    observedThumbs: () => observers.flatMap((o) => [...o.targets]),
  };
}

function renderGridWith(app: App, surfaces: unknown[]): void {
  app.run(`surfaces = JSON.parse(${JSON.stringify(JSON.stringify(surfaces))}); renderGrid();`);
}

// ── the attribute-interpolation guard ──
//
// Every `="…"` / `='…'` attribute value in client/app.js that carries a `${…}`
// has to run that value through escapeAttr() or encodeURIComponent().
// escapeText() is NOT safe here (it leaves quotes alone), which is exactly how
// the card title became a sink.
//
// This walks the source instead of matching /=(["'])\$\{([^}]*)\}/g, because
// that pattern had two holes big enough to drive the original bug back through:
//
//   * it only fired when `${` sat flush against the opening quote, so
//     `title="Surface ${s.title}"` and `class="chip${on ? " on" : ""}"` were
//     never inspected at all;
//   * `[^}]*` stopped at the first `}`, so an expression holding a brace was
//     classified on a truncated prefix — `${escapeAttr(pick({ a: 1 })) + raw}`
//     reads as "starts with escapeAttr(" and passes.
//
// So: find the end of a string literal properly, find the end of an
// interpolation properly, and require each interpolation to be wrapped *whole*
// rather than merely to mention an encoder somewhere inside.

/** Index just past the string literal that starts at `i` (`src[i]` is its quote). */
function endOfString(src: string, i: number): number {
  const quote = src[i];
  i++;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") { i += 2; continue; }
    // A template literal can hold its own `${…}`, which can hold more strings.
    if (quote === "`" && c === "$" && src[i + 1] === "{") { i = endOfExpr(src, i + 2); continue; }
    if (c === quote) return i + 1;
    i++;
  }
  return i;
}

/** Index just past the `${…}` whose body starts at `i` (i.e. past the `}`). */
function endOfExpr(src: string, i: number): number {
  let depth = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") { i += 2; continue; }
    if (c === '"' || c === "'" || c === "`") { i = endOfString(src, i); continue; }
    if (c === "{") { depth++; i++; continue; }
    if (c === "}") { depth--; i++; if (depth === 0) return i; continue; }
    i++;
  }
  return i;
}

/** Index just past the `(…)` that opens at `i`, or -1 if it never closes. */
function endOfParen(src: string, i: number): number {
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") { i += 2; continue; }
    if (c === '"' || c === "'" || c === "`") { i = endOfString(src, i); continue; }
    if (c === "(") { depth++; i++; continue; }
    if (c === ")") { depth--; i++; if (depth === 0) return i; continue; }
    i++;
  }
  return -1;
}

// Not "mentions escapeAttr" — the whole value has to be the encoder's result.
// `${escapeAttr(a) + b}` concatenates raw `b` into the attribute and is a sink.
const ATTR_ENCODERS = ["escapeAttr(", "encodeURIComponent("];
function wrappedWhole(expr: string): boolean {
  const e = expr.trim();
  for (const fn of ATTR_ENCODERS) {
    if (!e.startsWith(fn)) continue;
    if (endOfParen(e, fn.length - 1) === e.length) return true;
  }
  return false;
}

/**
 * Every `${…}` body that sits inside an `="…"` attribute value in `src`,
 * wherever in the value it sits and however many braces it contains.
 */
function attrInterpolations(src: string): { attr: string; expr: string }[] {
  const found: { attr: string; expr: string }[] = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== "=") continue;
    const quote = src[i + 1];
    if (quote !== '"' && quote !== "'") continue;
    const exprs: string[] = [];
    let j = i + 2;
    let closed = -1;
    while (j < src.length) {
      const c = src[j];
      if (c === quote) { closed = j; break; }
      if (c === "\\") { j += 2; continue; }
      // A quote inside `${…}` does not end the attribute value, so the
      // interpolation has to be skipped as a unit.
      if (c === "$" && src[j + 1] === "{") {
        const end = endOfExpr(src, j + 2);
        exprs.push(src.slice(j + 2, end - 1));
        j = end;
        continue;
      }
      j++;
    }
    if (closed === -1) continue;
    const attr = src.slice(i, closed + 1);
    for (const expr of exprs) found.push({ attr, expr });
    i = closed;
  }
  return found;
}

/** The interpolations from `attrInterpolations` that no encoder wraps. */
function unsafeAttrInterpolations(src: string): string[] {
  return attrInterpolations(src)
    .filter(({ expr }) => !wrappedWhole(expr))
    .map(({ expr }) => `="…\${${expr}}…"`);
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
    // CRLF-normalised: git checks out with CRLF on Windows, and this guard must
    // never pass merely because the scanner tripped over a line ending.
    const src = fs.readFileSync(path.join(REPO_ROOT, "client", "app.js"), "utf8").replace(/\r\n/g, "\n");
    const bad = unsafeAttrInterpolations(src);
    assert.deepEqual(bad, [], `unsafe attribute interpolation(s): ${bad.join(", ")}`);
  });

  // The guard above is the standing defence against reintroducing the stored
  // XSS this file exists for, so it gets a guard of its own: these are the
  // shapes the old flush-quote regex waved through.
  check("the attribute guard sees interpolations the old flush-quote pattern missed", () => {
    const OLD = /=(["'])\$\{([^}]*)\}/g;
    const oldVerdict = (sample: string): string[] => {
      const bad: string[] = [];
      for (const m of sample.matchAll(OLD)) {
        if (/escapeAttr\(|encodeURIComponent\(/.test(m[2])) continue;
        bad.push(m[0]);
      }
      return bad;
    };
    // No template interpolation runs in these: they are ordinary quoted
    // strings, so `${…}` reaches the scanner as source text.
    const sinks = [
      // `${` is not flush against the opening quote — a prefixed value.
      '<a title="Surface ${s.title}">',
      // …nor is it in the conditional-class shape, the one that was live.
      '<button class="grid-chip${on ? " grid-chip--active" : ""}">',
      // A brace inside the expression truncated the old match, so the old
      // classifier read "escapeAttr(" and passed a value that concatenates raw.
      '<a title="${escapeAttr(pick({ a: 1 })) + s.title}">',
      // A second interpolation later in the same value.
      '<a title="${escapeAttr(s.title)} — ${s.subtitle}">',
    ];
    for (const sample of sinks) {
      assert.deepEqual(oldVerdict(sample), [], `the old pattern already caught: ${sample}`);
      assert.equal(unsafeAttrInterpolations(sample).length, 1, `not caught: ${sample}`);
    }
    // …and the encoded forms of the same shapes still pass.
    for (const safe of [
      '<a title="Surface ${escapeAttr(s.title)}">',
      '<a href="/artifact/${encodeURIComponent(s.id)}/raw">',
      '<a title="${escapeAttr(pick({ a: 1 }))}">',
      '<a title="${escapeAttr(a ? "x" : "y")}">',
    ]) {
      assert.deepEqual(unsafeAttrInterpolations(safe), [], `false positive: ${safe}`);
    }
    // An interpolation outside a value (`<option value="az"${sel}>`) adds an
    // attribute rather than filling one, and is not this guard's business.
    assert.deepEqual(unsafeAttrInterpolations('<option value="az"${on ? " selected" : ""}>'), []);
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
    const titles = [...grid.document.querySelectorAll(".card-title")];
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
    const results = [...finder.document.querySelectorAll(".finder-result-title")];
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
    // renderGrid assigns the IDL property (`headerSearch.value = …`); a browser
    // reflects nothing into markup from that, so the property is what to read.
    assert.equal(input!.value, `" onfocus="alert(1)`);
  });

  // The active chip used to be interpolated into `class`, which is the shape
  // the attribute guard now rejects; it is set through classList instead, so
  // the state it carries needs its own test.
  check("the filter toolbar marks exactly the active chip", () => {
    const chips = loadApp();
    const mixed = [
      { id: "a", title: "one", artifact_mime: "text/html", updated_at: "2026-01-01T00:00:00Z" },
      { id: "b", title: "two", artifact_mime: "image/png", updated_at: "2026-01-02T00:00:00Z" },
      { id: "c", title: "three", artifact_mime: "video/mp4", updated_at: "2026-01-03T00:00:00Z" },
    ];
    chips.run(`gridFilter = "image"; surfaces = JSON.parse(${JSON.stringify(JSON.stringify(mixed))}); renderGrid();`);
    const all = [...chips.document.querySelectorAll(".grid-chip")];
    assert.ok(all.length >= 3, `expected a filter row, got ${all.length} chip(s)`);
    const active = all.filter((c) => c.classList.contains("grid-chip--active"));
    assert.equal(active.length, 1, "exactly one chip must read as active");
    assert.equal(active[0].getAttribute("data-filter"), "image");
    assert.equal(active[0].getAttribute("aria-pressed"), "true");
    for (const chip of all) {
      if (chip === active[0]) continue;
      assert.equal(chip.getAttribute("aria-pressed"), "false", `${chip.getAttribute("data-filter")} must not claim to be pressed`);
    }
  });

  // ══ 2b. what a display that never reloads accumulates ═══════════════════
  //
  // Both of these grow per re-render, and renderGrid()/paintGrid() run on every
  // hash change, every keystroke in the search box, every SSE reconnect and
  // every display_theme. A kiosk runs for weeks without a reload.

  check("repainting the grid does not leave detached thumbnails observed", () => {
    const kiosk = loadApp({ intersectionObserver: true });
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: `s${i}`,
      title: `surface ${i}`,
      artifact_mime: "text/html",
      updated_at: "2026-01-01T00:00:00Z",
    }));
    kiosk.run(`surfaces = JSON.parse(${JSON.stringify(JSON.stringify(many))}); renderGrid();`);
    assert.equal(kiosk.observedThumbs().length, many.length, "each card's thumb registers once");

    // None of these thumbs ever intersects, so nothing ever unobserves itself.
    for (let i = 0; i < 5; i++) kiosk.run("paintGrid();");

    const observed = kiosk.observedThumbs();
    const detached = observed.filter((el) => !el.isConnected);
    assert.equal(
      detached.length, 0,
      `${detached.length} detached thumb(s) still observed — an IntersectionObserver holds its targets strongly, and img.onerror closes over the card`,
    );
    assert.equal(observed.length, many.length, "the observer must hold one target per visible card, not one per paint");
  });

  // A dashboard showing a home widget. `displayConfig` has to be non-empty:
  // applyTheme() treats an empty config as "reset" and tears the widget back
  // out, and the empty state's gallery registers a resize listener of its own,
  // so a card keeps that out of the count.
  const withHomeWidget = (kiosk: App): void => {
    kiosk.run(`
      displayConfig = { title: "Kiosk" };
      surfaces = [{ id: "a", title: "one", artifact_mime: "text/html", updated_at: "2026-01-01T00:00:00Z" }];
      displaySlots = { renderer: null, home: { html: "<p>hi</p>" }, overlay: null };
    `);
  };

  check("a re-render replaces the home widget's resize listener instead of stacking one", () => {
    const kiosk = loadApp();
    withHomeWidget(kiosk);
    // app.js registers one at boot (presence reporting); count from there.
    const base = kiosk.windowListeners("resize").length;
    // Each render builds a brand-new iframe, whose load then fires.
    const renderAndLoad = (): void => {
      kiosk.run("renderGrid();");
      const widget = kiosk.document.getElementById("home-widget");
      assert.ok(widget, "the home widget iframe is missing");
      (widget as any).onload();
    };

    renderAndLoad();
    assert.equal(kiosk.windowListeners("resize").length, base + 1, "the home widget registers one resize listener");

    for (let i = 0; i < 5; i++) renderAndLoad();
    assert.equal(
      kiosk.windowListeners("resize").length, base + 1,
      "the previous render's listener must not survive the iframe it measures",
    );

    // The slot can also be cleared, and then nothing should still be measuring.
    kiosk.run("displaySlots = { renderer: null, home: null, overlay: null }; renderGrid();");
    assert.equal(kiosk.windowListeners("resize").length, base, "the listener must go when the widget does");
  });

  check("a stray home-widget resize handler unregisters itself rather than measuring a dead iframe", () => {
    const kiosk = loadApp();
    withHomeWidget(kiosk);
    const base = kiosk.windowListeners("resize").length;
    kiosk.run("renderGrid();");
    const handler = kiosk.windowListeners("resize")[base];
    assert.ok(handler, "the home widget registered no resize listener");
    const widget = kiosk.document.getElementById("home-widget");
    assert.ok(widget, "the home widget iframe is missing");
    widget!.remove();
    handler();
    assert.ok(
      !kiosk.windowListeners("resize").includes(handler),
      "a handler whose iframe is gone must take itself off window",
    );
    // Measuring a detached iframe reads a null contentDocument, and the catch
    // writes "200px" to a dead node; nothing should have been written at all.
    assert.ok(!(widget!.style as any).height, "a detached iframe must not be resized");
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

  // The header's furniture is reachable from nowhere else: the tutorial had no
  // entry point at all once a dashboard had surfaces on it (only the empty
  // state offered it), and a paired display has no host shell to read a version
  // off. Losing any of it is silent — the bar still looks fine.
  check("the header carries its brand, tagline and action cluster", () => {
    const header = emptyApp.document.querySelector(".grid-header");
    assert.ok(header, "no .grid-header rendered");
    assert.equal(header!.querySelector(".grid-title")?.textContent, "Surface");
    const tagline = header!.querySelector(".grid-subtitle")?.textContent || "";
    assert.ok(tagline.length > 0, "the wordmark lost its tagline");
    assert.ok(header!.querySelector("#grid-guide"), "no tutorial entry point in the header");
    const repo = header!.querySelector(".grid-actions a");
    assert.ok(repo, "no repository link in the header");
    assert.match(repo!.getAttribute("href") || "", /^https:\/\/github\.com\//, "repo link must point at GitHub");
    assert.equal(repo!.getAttribute("rel"), "noopener noreferrer", "an external target needs rel=noopener");
    assert.ok(header!.querySelector("#grid-version"), "no version chip host in the header");
  });

  check("the version chip stays hidden until the server has told us a version", () => {
    // It reads from the update-status payload the client already fetches. A
    // chip that renders "vundefined" for the first second is worse than one
    // that arrives late.
    const chip = emptyApp.document.querySelector("#grid-version");
    assert.ok(chip, "no version chip");
    assert.equal(chip!.hidden, true, "the chip must start hidden");
    assert.equal(chip!.textContent, "", "the chip must start empty");

    emptyApp.run(`applyUpdateStatus({ current: "9.9.9", latest: "9.9.9", update_available: false });`);
    assert.equal(chip!.hidden, false, "the chip must appear once a version is known");
    assert.equal(chip!.textContent, "v9.9.9");

    emptyApp.run(`applyUpdateStatus({ current: "unknown", latest: null, update_available: false });`);
    assert.equal(chip!.hidden, true, "an unknown version must not render as a chip");
  });

  // The stacking fix below keeps the header *painted* over the empty state.
  // That is not the same as the empty state being readable: it is `inset: 0`,
  // so it spans the strip the header occupies, and once the narrow layout
  // centres it on the full height its first line lands underneath. Measured in
  // a real browser before this guard existed: 22px of the "Surface is
  // listening" pill hidden at 390px, 4px at 820px.
  check("the narrow empty state clears the header instead of centring through it", () => {
    const css = fs.readFileSync(path.join(REPO_ROOT, "client", "style.css"), "utf8");
    const blockFor = (query: string) => {
      const at = css.indexOf(`@media (max-width: ${query})`);
      assert.ok(at > -1, `no ${query} breakpoint`);
      return css.slice(at, css.indexOf("@media", at + 10));
    };
    for (const width of ["1100px", "760px"]) {
      const rule = /\.empty-state\s*\{([^}]*)\}/.exec(blockFor(width));
      assert.ok(rule, `no .empty-state rule at ${width}`);
      assert.match(
        rule![1],
        /padding(-top)?:\s*calc\(var\(--header-h\)/,
        `.empty-state at ${width} must reserve the header's height`,
      );
    }
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

  // The shell shipped a blue-leaning grey set (#0a0b0d, #131417) that read as
  // cold slate rather than black. The replacement is three neutral planes
  // ranked by attention, so this guards both properties: the exact tones, and
  // that they are actually neutral — a one-digit drift back toward blue is the
  // failure mode, and it is invisible in a diff.
  check("the dark shell keeps its three neutral planes, ranked", () => {
    const css = fs.readFileSync(path.join(REPO_ROOT, "client", "style.css"), "utf8");
    const dark = css.slice(0, css.indexOf("@media (prefers-color-scheme: light)"));
    const tokenOf = (name: string) => {
      const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(dark);
      assert.ok(m, `--${name} is not a literal hex in the dark scheme`);
      return m![1].toLowerCase();
    };
    const planes = { bg: tokenOf("bg"), overlay: tokenOf("overlay"), interactive: tokenOf("interactive") };
    assert.equal(planes.bg, "#0a0a0a");
    assert.equal(planes.overlay, "#020202");
    assert.equal(planes.interactive, "#121212");

    for (const [name, hex] of Object.entries(planes)) {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      assert.ok(r === g && g === b, `--${name} (${hex}) is tinted, not neutral grey`);
    }

    const lum = (hex: string) => parseInt(hex.slice(1, 3), 16);
    assert.ok(lum(planes.overlay) < lum(planes.bg), "overlays must sink below the page");
    assert.ok(lum(planes.interactive) > lum(planes.bg), "interactive surfaces must lift above the page");
  });

  // Overlays and cards shared one token, so ranking them apart is only real if
  // the floating chrome actually reads the overlay plane.
  check("floating chrome sits on the overlay plane, not the card plane", () => {
    const css = fs.readFileSync(path.join(REPO_ROOT, "client", "style.css"), "utf8");
    for (const selector of [".modal-panel", ".toast", ".finder-panel"]) {
      const rule = new RegExp(`\\n\\${selector}\\s*\\{([^}]*)\\}`).exec(css);
      assert.ok(rule, `no rule for ${selector}`);
      assert.match(rule![1], /background:\s*var\(--overlay\)/, `${selector} must use --overlay`);
    }
    assert.match(css, /--chip-bg:\s*rgba\(2,\s*2,\s*2,/, "the preview tray must use the overlay tone");
  });

  // DESIGN.md rule 5: the pairing card, the tutorial modal and the finder are
  // one object. pair.html is a standalone document that copies the tokens
  // rather than importing them — which is exactly how it drifted into being a
  // second dialog style, and why the drift has to be asserted rather than
  // trusted to reviewers noticing two files at once.
  check("the pairing card is built to the same spec as the app's dialogs", () => {
    const css = fs.readFileSync(path.join(REPO_ROOT, "client", "style.css"), "utf8");
    const pair = fs.readFileSync(path.join(REPO_ROOT, "client", "pair.html"), "utf8");
    const ruleIn = (src: string, selector: string) => {
      const m = new RegExp(`[\\n\\s]\\${selector}\\s*\\{([^}]*)\\}`).exec(src);
      assert.ok(m, `no rule for ${selector}`);
      return m![1];
    };
    const card = ruleIn(pair, ".card");
    assert.match(card, /background:\s*var\(--overlay\)/, "the pairing card must sit on the overlay plane");
    assert.match(card, /padding:\s*32px 32px 28px/, "the pairing card must use the shared dialog padding");
    assert.match(pair, /--r-card:\s*18px/, "the pairing card must use the shared dialog radius");
    assert.match(ruleIn(css, ".modal-panel"), /border-radius:\s*18px/, "the modal radius moved away from the shared spec");

    // Rule 5: the *box* is shared; the header is one of exactly two. The modal
    // is the task-dialog header, the pairing page is the front door, so their
    // titles are deliberately not the same size.
    assert.match(ruleIn(css, ".modal-title"), /font-size:\s*23px/, "the modal title left the task-dialog scale");
    // The pairing page wears the wordmark instead of an eyebrow — it is a front
    // door, not a section of one — so eyebrow parity is asserted only where an
    // eyebrow exists. The title and lede scale is shared unconditionally.
    assert.ok(!/class="eyebrow"/.test(pair), "the pairing page should carry the brand lockup, not an eyebrow");
    assert.match(ruleIn(css, ".modal-eyebrow"), /font-size:\s*10\.5px/, "the modal eyebrow left the shared scale");
    assert.match(ruleIn(css, ".modal-eyebrow"), /text-transform:\s*uppercase/, "the modal eyebrow lost its treatment");

    // Rule 3: what you click inside a dialog lifts off it.
    assert.match(ruleIn(pair, "input"), /background:\s*var\(--interactive\)/, "the token field must lift off the card");
    assert.match(ruleIn(css, ".modal-prompt"), /background:\s*var\(--interactive\)/, "the prompt must lift off the panel");

    // Rule 4, in the file that keeps its own copy of the tokens.
    assert.match(pair, /--overlay:\s*#020202/, "pair.html drifted from the overlay tone");
    assert.match(pair, /--interactive:\s*#121212/, "pair.html drifted from the interactive tone");
    assert.match(pair, /--bg:\s*#0a0a0a/, "pair.html drifted from the page tone");
  });

  check("the pairing page names the command that produces a token", () => {
    const pair = fs.readFileSync(path.join(REPO_ROOT, "client", "pair.html"), "utf8");
    const cmd = /<code id="cmd-text">([^<]*)<\/code>/.exec(pair);
    assert.ok(cmd, "no command block on the pairing page");
    // Bare, on purpose. `--name` would set the session label from the host,
    // and the device name field two rows below sets the same thing from here;
    // shipping both invites someone to fill in each and wonder which won.
    assert.equal(cmd![1], "surface pair");

    // Both clipboard paths must exist, and the async one must fall through to
    // the legacy one on rejection rather than reporting failure — the reasons
    // writeText is refused (permissions policy, a denied prompt) are invisible
    // to a feature test. Neither path can run in headless Chrome, which
    // returns false from execCommand for any element, so this is asserted on
    // the source rather than exercised.
    assert.match(pair, /navigator\.clipboard\.writeText/, "no async clipboard path");
    assert.match(pair, /function\s*\(\s*\)\s*\{\s*done\(legacyCopy\(text\)\);\s*\}/,
      "a refused clipboard write must fall back, not report failure");
    assert.match(pair, /document\.execCommand\("copy"\)/, "no legacy clipboard fallback");
  });

  check("the pairing page leads with the Surface wordmark, centred", () => {
    const pair = fs.readFileSync(path.join(REPO_ROOT, "client", "pair.html"), "utf8");
    const brand = /<div class="brand">([\s\S]*?)<\/div>/.exec(pair);
    assert.ok(brand, "no wordmark on the pairing page");
    assert.equal(brand![1].trim(), "Surface");
    // Surface has no mark. A glyph invented for this page would be a second
    // identity, and the app icon is a launcher tile rather than a logo.
    assert.ok(!/<svg/.test(brand![1]), "the wordmark is the identity — no invented glyph");

    const rule = /[\n\s]\.brand\s*\{([^}]*)\}/.exec(pair);
    assert.ok(rule, "no .brand rule");
    assert.match(rule![1], /text-align:\s*center/, "the wordmark must be centred");
    // It has to outrank the task line under it, or it is not a front door.
    const brandSize = Number(/font-size:\s*([\d.]+)px/.exec(rule![1])![1]);
    const h1Size = Number(/\.card > h1 \{[^}]*font-size:\s*([\d.]+)px/.exec(pair)![1]);
    assert.ok(brandSize > h1Size, `wordmark (${brandSize}px) must lead the title (${h1Size}px)`);
    const h1Rule = /\.card > h1 \{([^}]*)\}/.exec(pair);
    assert.ok(h1Rule, "no .card > h1 rule");
    assert.match(h1Rule![1], /text-align:\s*center/, "the task line must be centred under the wordmark");
    // It supports the wordmark rather than competing with it.
    assert.match(h1Rule![1], /color:\s*var\(--fg-muted\)/, "the task line must sit back from the wordmark");
  });

  // Pairing spans two machines, and the token cannot be typed until the command
  // has been run over there. The numbered sequence is the instruction; a flat
  // stack of fields was not.
  check("the pairing page walks the three steps in the order they happen", () => {
    const pair = fs.readFileSync(path.join(REPO_ROOT, "client", "pair.html"), "utf8");
    const titles = [...pair.matchAll(/<h2 class="step-title">(?:<label[^>]*>)?([^<]+)/g)].map((m) => m[1].trim());
    assert.deepEqual(titles, ["Run command", "Enter pairing token", "Name this device"]);

    // The command must come before the field that consumes its output.
    assert.ok(pair.indexOf('id="cmd-text"') < pair.indexOf('id="token"'), "the command must precede the token field");
    assert.ok(pair.indexOf('id="token"') < pair.indexOf('id="device-name"'), "the token must precede the device name");

    // A token pasted with the dashes people add out of habit is not a wrong token.
    assert.match(pair, /replace\(\/\[\\s-\]\/g, ""\)/, "the token must tolerate whitespace and dashes");
  });

  // `1fr` is `minmax(auto, 1fr)`, and that `auto` floor is the grid item's
  // min-content width — so one unbreakable thing inside a card (a log line set
  // in `white-space: pre`, say) sizes the whole track and the grid runs off the
  // side of the screen. This shipped: at 380px and below the grid used a bare
  // 1fr, and a 360px viewport laid out a 460px column.
  check("every grid track that flexes is floored at zero, not at min-content", () => {
    const css = fs.readFileSync(path.join(REPO_ROOT, "client", "style.css"), "utf8");
    const offenders: string[] = [];
    for (const m of css.matchAll(/grid-template-columns\s*:\s*([^;]+);/g)) {
      const value = m[1].replace(/\s+/g, " ").trim();
      // Not `\bfr\b`: there is no word boundary between the digit and the unit
      // in "1fr", so that pattern matches nothing and the guard inspects
      // nothing — which is exactly how it passed the first time it was run
      // against the bug it exists to catch.
      if (!/[\d.]\s*fr\b/.test(value)) continue;
      // Every fr-bearing track function in the value must carry its own zero
      // floor. `repeat(auto-fill, minmax(250px, 1fr))` is fine too: a fixed
      // minimum is a floor, it just is not zero.
      const floored = /minmax\(\s*(0|[\d.]+px|var\(--[a-z-]+\))\s*,/.test(value);
      if (!floored) offenders.push(value);
    }
    assert.deepEqual(offenders, [], `flexible track(s) floored at min-content: ${offenders.join(" | ")}`);
  });

  // The frame is white so a surface that declares no background of its own gets
  // the page the browser would have given it. That white is also what the empty
  // element paints while the content loads, so it is revealed rather than shown
  // — and the reveal must be driven by something that always happens. An
  // `is-loaded` class with only a `load` listener behind it leaves a stalled
  // frame invisible forever.
  check("a surface frame that never fires load is still revealed", () => {
    const js = fs.readFileSync(path.join(REPO_ROOT, "client", "app.js"), "utf8");
    const reveal = js.slice(js.indexOf("const reveal = "), js.indexOf("iframe.src = frameSrc;"));
    assert.ok(reveal.length > 0, "the reveal path moved; this guard needs updating");
    assert.match(reveal, /addEventListener\("load"/, "the fast path is the load event");
    assert.match(reveal, /setTimeout\(reveal/, "a frame that never loads must still be revealed");
    // And the unavailable notice is a div, not an iframe: scoping the rule to
    // `iframe.surface-frame` is what keeps it from being hidden forever.
    const css = fs.readFileSync(path.join(REPO_ROOT, "client", "style.css"), "utf8");
    assert.match(css, /iframe\.surface-frame\s*\{[^}]*opacity:\s*0/, "the hidden-until-loaded rule must be scoped to the iframe");
    assert.ok(
      !/\n\.surface-frame\s*\{[^}]*opacity:\s*0/.test(css),
      "an unscoped rule would also hide .surface-frame-unavailable, which never loads",
    );
  });

  // Zeroing durations is not enough. The grid staggers its entrance with
  // `animation-delay` and a `both` fill, so a card sits at opacity 0 until its
  // delay elapses no matter how short the animation is — twelve cards popping
  // in over half a second, for a user who asked for no motion.
  check("reduced motion zeroes delays, not just durations", () => {
    const css = fs.readFileSync(path.join(REPO_ROOT, "client", "style.css"), "utf8");
    const at = css.indexOf("@media (prefers-reduced-motion: reduce)");
    assert.ok(at !== -1, "no reduced-motion block");
    const block = css.slice(at, css.indexOf("\n}", css.indexOf("*, *::before, *::after", at)));
    for (const prop of ["animation-duration", "animation-delay", "transition-duration", "transition-delay"]) {
      assert.match(
        block,
        new RegExp(`${prop}:\\s*[^;]+!important`),
        `reduced motion must override ${prop}`,
      );
    }
  });

  // An iframe with no height is 150px tall. The home widget measures its own
  // content and sets a height — but only ever did so from `onload`, and a frame
  // that is slow to fire `load` (about one run in six, measured) was left at
  // that 150px default with 74px of content in it.
  check("the home widget is sized without waiting for its frame to load", () => {
    const js = fs.readFileSync(path.join(REPO_ROOT, "client", "app.js"), "utf8");
    const start = js.indexOf("const sizeWidget = ");
    assert.ok(start !== -1, "the widget sizer moved; this guard needs updating");
    const block = js.slice(start, js.indexOf("widget.onload", start));
    assert.match(block, /setTimeout\(/, "sizing must not depend solely on the load event");
    // And measuring documentElement first would read the frame's own viewport,
    // which is how a 74px widget locked itself at 150px and then measured that
    // as correct forever.
    const bodyAt = block.indexOf("doc.body.scrollHeight");
    const docElAt = block.indexOf("doc.documentElement.scrollHeight");
    assert.ok(bodyAt !== -1, "the body's own box must be measured");
    assert.ok(docElAt === -1 || bodyAt < docElAt, "documentElement is a fallback, not the first choice");

    const css = fs.readFileSync(path.join(REPO_ROOT, "client", "style.css"), "utf8");
    const rule = /\n\.home-widget\s*\{([^}]*)\}/.exec(css);
    assert.ok(rule, "no .home-widget rule");
    assert.match(rule![1], /height:\s*\d+px/, "the widget must reserve its own height, not the iframe default");
  });

  check("the stylesheet uses no deprecated declaration keywords", () => {
    const css = fs.readFileSync(path.join(REPO_ROOT, "client", "style.css"), "utf8");
    // `word-break: break-word` is deprecated (and was never in any spec as
    // anything but an alias); `overflow-wrap: break-word` is the property that
    // expresses this, and is what browsers map it onto anyway.
    const deprecated = [...css.matchAll(/word-break\s*:\s*break-word/g)].map((m) => m[0]);
    assert.deepEqual(deprecated, [], `deprecated declaration(s): ${deprecated.join(", ")}`);
  });

  // ══ 4. theme reset restores the PWA chrome ══════════════════════════════
  const themed = loadApp();
  const metaState = () =>
    [...themed.document.querySelectorAll('meta[name="theme-color"]')]
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

  // ══ 5. display slots are not theme state ════════════════════════════════
  //
  // `surface slot home|overlay` promotes an artifact (metadata.display_role);
  // a theme is display config. applyTheme()'s reset branch used to remove both
  // slot iframes, and an unthemed display — the default — reaches that branch
  // with `{}` on every render, because renderGrid() ends with
  // applyTheme(displayConfig). The home slot was therefore dead out of the box.

  check("an unthemed display keeps the home widget renderGrid just built", () => {
    const plain = loadApp();
    plain.run(`
      displayConfig = {};
      surfaces = [];
      displaySlots = { renderer: null, home: { html: "<p>hi</p>" }, overlay: null };
      renderGrid();
    `);
    const widget = plain.document.getElementById("home-widget");
    assert.ok(widget, "the home widget was destroyed by the theme reset at the end of renderGrid()");
    assert.equal(widget!.getAttribute("src"), "/display/home/html");
  });

  check("a themed display keeps it too", () => {
    const plain = loadApp();
    plain.run(`
      surfaces = [];
      displaySlots = { renderer: null, home: { html: "<p>hi</p>" }, overlay: null };
      displayConfig = { colors: { void: "#123456" } };
      renderGrid();
    `);
    assert.ok(plain.document.getElementById("home-widget"), "the home widget is missing");
  });

  check("a theme reset mounts the overlay slot rather than tearing it out", () => {
    const plain = loadApp();
    plain.run(`
      displaySlots = { renderer: null, home: null, overlay: { html: "<p>o</p>" } };
      applyTheme({});
    `);
    const overlay = plain.document.getElementById("display-overlay");
    assert.ok(overlay, "the overlay slot did not survive a theme reset");
    assert.equal(overlay!.getAttribute("src"), "/display/overlay/html");
  });

  check("…and still drops the overlay once the slot is empty", () => {
    const plain = loadApp();
    plain.run(`
      displaySlots = { renderer: null, home: null, overlay: { html: "<p>o</p>" } };
      applyTheme({});
      displaySlots = { renderer: null, home: null, overlay: null };
      applyTheme({});
    `);
    assert.equal(plain.document.getElementById("display-overlay"), null, "a cleared overlay slot must leave no iframe");
  });

  check("a theme reset still clears the theme state it does own", () => {
    const plain = loadApp();
    plain.run(`applyTheme({ css: ".card { color: red }", colors: { void: "#123456" } });`);
    const bg = () => plain.document.documentElement.style.getPropertyValue("--bg");
    assert.ok(plain.document.getElementById("theme-css"), "the custom stylesheet was never injected");
    assert.equal(bg(), "#123456", "no custom properties were set");
    plain.run("applyTheme({});");
    assert.equal(plain.document.getElementById("theme-css"), null, "the custom stylesheet survived the reset");
    assert.equal(bg(), "", "the custom properties survived the reset");
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
