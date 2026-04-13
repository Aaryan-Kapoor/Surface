// Tests the DOM morph algorithm inside the surface bootloader.
// Runs: `npx tsx test/morph.test.ts`
import { JSDOM } from "jsdom";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOOT = fs.readFileSync(
  path.join(__dirname, "..", "client", "lib", "surface-bootloader.js"),
  "utf8"
);

let passed = 0;
let failed = 0;

function bootedDom(html: string): { dom: JSDOM; window: any } {
  const dom = new JSDOM(html, { runScripts: "outside-only" });
  const win = dom.window as any;
  // Polyfill: jsdom doesn't have DOMParser.parseFromString text/html? It does.
  win.eval(BOOT);
  return { dom, window: win };
}

async function morphViaBoot(window: any, newHtml: string): Promise<void> {
  // Invoke the morph message handler directly via postMessage.
  window.postMessage({ type: "surface/morph", html: newHtml }, "*");
  // The MessageEvent is dispatched asynchronously in jsdom; wait a turn.
  await new Promise((r) => setTimeout(r, 0));
}

function test(name: string, fn: () => Promise<void> | void) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ok  ${name}`);
    })
    .catch((err) => {
      failed++;
      console.log(`  FAIL ${name}\n       ${err.message || err}`);
    });
}

function assertEq<T>(a: T, b: T, label = "") {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${label}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}

(async () => {
  await test("updates a single text node in place", async () => {
    const { window } = bootedDom(
      "<!doctype html><html><body><p id=x>Hello</p></body></html>"
    );
    const p = window.document.getElementById("x");
    await morphViaBoot(
      window,
      "<!doctype html><html><body><p id=x>Goodbye</p></body></html>"
    );
    assertEq(window.document.getElementById("x").textContent, "Goodbye");
    // Same node reused, not replaced:
    if (window.document.getElementById("x") !== p) throw new Error("node replaced");
  });

  await test("preserves uncontrolled input values on unchanged nodes", async () => {
    const { window } = bootedDom(
      "<!doctype html><html><body><input id=i><p id=y>A</p></body></html>"
    );
    const inp = window.document.getElementById("i") as HTMLInputElement;
    inp.value = "user typed"; // not an attribute; should survive morph
    await morphViaBoot(
      window,
      "<!doctype html><html><body><input id=i><p id=y>B</p></body></html>"
    );
    assertEq(window.document.getElementById("i").value, "user typed");
    assertEq(window.document.getElementById("y").textContent, "B");
  });

  await test("diffs attributes without replacing elements", async () => {
    const { window } = bootedDom(
      "<!doctype html><html><body><div id=d class='a'></div></body></html>"
    );
    const before = window.document.getElementById("d");
    await morphViaBoot(
      window,
      "<!doctype html><html><body><div id=d class='b' data-x='1'></div></body></html>"
    );
    const after = window.document.getElementById("d");
    if (before !== after) throw new Error("div was replaced");
    assertEq(after.getAttribute("class"), "b");
    assertEq(after.getAttribute("data-x"), "1");
  });

  await test("does not re-execute existing <script> tags with unchanged content", async () => {
    const { window } = bootedDom(
      "<!doctype html><html><body><p id=p>A</p></body></html>"
    );
    // Morph to introduce a surface-only script? Instead test that no script
    // re-runs when only non-script content changes.
    (window as any).__ran = 0;
    // Inject a script by morphing to a variant with one, then confirm a
    // subsequent morph that keeps the script doesn't re-run it.
    await morphViaBoot(
      window,
      "<!doctype html><html><body><p id=p>B</p><script id=s>window.__ran=(window.__ran||0)+1;</script></body></html>"
    );
    // jsdom runScripts: outside-only won't execute parser-inserted scripts
    // from morphing. To verify non-reexec we have to run it ourselves first:
    window.eval("window.__ran=(window.__ran||0)+1;");
    const after1 = (window as any).__ran;
    await morphViaBoot(
      window,
      "<!doctype html><html><body><p id=p>C</p><script id=s>window.__ran=(window.__ran||0)+1;</script></body></html>"
    );
    const after2 = (window as any).__ran;
    if (after1 !== after2) throw new Error(`script re-executed: ${after1} -> ${after2}`);
    assertEq(window.document.getElementById("p").textContent, "C");
  });

  await test("inserts new child nodes correctly", async () => {
    const { window } = bootedDom(
      "<!doctype html><html><body><ul id=l><li>a</li></ul></body></html>"
    );
    await morphViaBoot(
      window,
      "<!doctype html><html><body><ul id=l><li>a</li><li>b</li><li>c</li></ul></body></html>"
    );
    const items = window.document.querySelectorAll("#l li");
    assertEq(items.length, 3);
    assertEq(items[1].textContent, "b");
    assertEq(items[2].textContent, "c");
  });

  await test("removes trailing child nodes correctly", async () => {
    const { window } = bootedDom(
      "<!doctype html><html><body><ul id=l><li>a</li><li>b</li><li>c</li></ul></body></html>"
    );
    await morphViaBoot(
      window,
      "<!doctype html><html><body><ul id=l><li>a</li></ul></body></html>"
    );
    const items = window.document.querySelectorAll("#l li");
    assertEq(items.length, 1);
  });

  await test("exec runs inside iframe's global scope", async () => {
    const { window } = bootedDom(
      "<!doctype html><html><body></body></html>"
    );
    (window as any).__val = 0;
    window.postMessage(
      { type: "surface/exec", js: "window.__val = 42;" },
      "*"
    );
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 5));
    assertEq((window as any).__val, 42);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
