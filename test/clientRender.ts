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
    const src = fs.readFileSync(path.join(REPO_ROOT, "client", "app.js"), "utf8");
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
