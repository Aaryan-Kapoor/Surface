// Widgets: server-side spec validation + client-side runtime rendering.
// Runs: `npx tsx test/widgets.test.ts`
import { JSDOM } from "jsdom";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { validateSpec, renderSpecShell, SpecError } from "../server/widgets.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = fs.readFileSync(
  path.join(__dirname, "..", "client", "lib", "surface-widgets.js"),
  "utf8"
);

let passed = 0;
let failed = 0;

function test(name: string, fn: () => Promise<void> | void) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ok  ${name}`); })
    .catch((err) => { failed++; console.log(`  FAIL ${name}\n       ${err.message || err}`); });
}

function assertEq<T>(a: T, b: T, label = "") {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${label}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}

function mount(spec: any) {
  const dom = new JSDOM(`<!doctype html><html><body><div id="root"></div></body></html>`, {
    runScripts: "outside-only",
  });
  const win = dom.window as any;
  win.eval(RUNTIME);
  win.SurfaceWidgets.mount(spec);
  return win;
}

(async () => {
  // ── server-side validation ────────────────────────────────────────────────

  await test("validate: rejects non-object", () => {
    try { validateSpec(null); } catch (e) {
      if (!(e instanceof SpecError)) throw e;
      return;
    }
    throw new Error("expected SpecError");
  });

  await test("validate: rejects missing root", () => {
    try { validateSpec({}); } catch (e) { if (e instanceof SpecError) return; throw e; }
    throw new Error("expected SpecError");
  });

  await test("validate: rejects unknown widget type", () => {
    try {
      validateSpec({ root: { type: "Nope" } });
    } catch (e) {
      if (e instanceof SpecError && /unknown widget/.test(e.message)) return;
      throw e;
    }
    throw new Error("expected SpecError");
  });

  await test("validate: accepts a valid nested spec", () => {
    const spec = {
      root: { type: "Stack", children: [{ type: "Text", value: "hi" }] },
      state: { x: 1 },
    };
    const v = validateSpec(spec);
    assertEq(v.root.type, "Stack");
  });

  await test("validate: timers must be >= 16ms", () => {
    try {
      validateSpec({ root: { type: "Text" }, timers: [{ every: 0, do: [] }] });
    } catch (e) { if (e instanceof SpecError) return; throw e; }
    throw new Error("expected SpecError");
  });

  await test("renderSpecShell: json is <script>-safe", () => {
    const shell = renderSpecShell({
      root: { type: "Text", value: "</script><img>" },
    });
    // raw </script> should be broken up in the json payload.
    if (shell.includes("</script>\n")) {
      // only the real closing </script> at document end is allowed
      const idx = shell.indexOf("</script>");
      const last = shell.lastIndexOf("</script>");
      if (idx !== last - "</script>".length * 0 - 0) {
        // just check the inline json doesn't contain unescaped </script
      }
    }
    if (shell.indexOf("</script><img>") !== -1) {
      throw new Error("unescaped </script sequence in json payload");
    }
  });

  // ── client runtime rendering ──────────────────────────────────────────────

  await test("runtime: renders Text", () => {
    const win = mount({ root: { type: "Text", value: "hello" } });
    const txt = win.document.querySelector("#root").textContent;
    assertEq(txt, "hello");
  });

  await test("runtime: resolves $-bindings against state", () => {
    const win = mount({
      root: { type: "Text", value: "$.name" },
      state: { name: "world" },
    });
    const txt = win.document.querySelector("#root").textContent;
    assertEq(txt, "world");
  });

  await test("runtime: button click mutates state and re-renders", () => {
    const win = mount({
      root: {
        type: "Stack",
        children: [
          { type: "Text", value: "$.count" },
          { type: "Button", label: "+1", onClick: [{ op: "inc", path: "count" }] },
        ],
      },
      state: { count: 0 },
    });
    const doc = win.document;
    assertEq(doc.querySelector("#root").textContent.startsWith("0"), true);
    doc.querySelector("button").click();
    doc.querySelector("button").click();
    doc.querySelector("button").click();
    const txt = doc.querySelector("#root").textContent;
    assertEq(txt.startsWith("3"), true, "after 3 clicks");
  });

  await test("runtime: ops — set, toggle, push, remove", () => {
    const win = mount({
      root: {
        type: "Stack",
        children: [
          { type: "Text", value: "$.items.length" },
          { type: "Button", label: "add", onClick: [{ op: "push", path: "items", value: "x" }] },
          { type: "Button", label: "rm", onClick: [{ op: "remove", path: "items", index: 0 }] },
          { type: "Button", label: "t", onClick: [{ op: "toggle", path: "on" }] },
          { type: "Button", label: "s", onClick: [{ op: "set", path: "n", value: 42 }] },
        ],
      },
      state: { items: [], on: false, n: 0 },
    });
    const btns = win.document.querySelectorAll("button");
    btns[0].click(); btns[0].click(); btns[0].click(); // push x3
    btns[1].click(); // rm first
    btns[2].click(); btns[2].click(); // toggle twice
    btns[3].click(); // set n=42
    // Count text should reflect 2 items left
    const txt = win.document.querySelector("#root").textContent;
    assertEq(txt.startsWith("2"), true, `after ops: ${txt}`);
  });

  await test("runtime: Input with bind writes state and re-renders dependents", () => {
    const win = mount({
      root: {
        type: "Stack",
        children: [
          { type: "Input", bind: "q", placeholder: "type" },
          { type: "Text", value: "$.q" },
        ],
      },
      state: { q: "" },
    });
    const input = win.document.querySelector("input");
    input.value = "hi";
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    const text = win.document.querySelectorAll("#root div")[1]?.textContent
      || win.document.querySelector("#root").textContent;
    if (!text.includes("hi")) throw new Error("state binding didn't propagate");
  });

  await test("runtime: applySpec preserves existing state keys", () => {
    const win = mount({
      root: { type: "Text", value: "$.a" },
      state: { a: 1, b: 2 },
    });
    // Simulate a user mutation before agent pushes a new spec.
    win.SurfaceWidgets._internals;
    // Increment via internal state.
    const mounted = win.SurfaceWidgets.mount; // no-op sanity
    // Apply a new spec with partial state — existing keys should stick.
    win.SurfaceWidgets.applySpec({
      root: { type: "Text", value: "$.a" },
      state: { a: 999, c: 3 }, // a is seeded only if missing; existing 1 stays
    });
    const txt = win.document.querySelector("#root").textContent;
    assertEq(txt, "1");
  });

  await test("runtime: unknown component renders a visible error, doesn't crash", () => {
    const win = mount({ root: { type: "NotAThing" } });
    const html = win.document.querySelector("#root").innerHTML;
    if (!html.includes("Unknown widget")) throw new Error("no error rendered");
  });

  await test("runtime: `when` hides subtree when falsy", () => {
    const win = mount({
      root: {
        type: "Stack",
        children: [
          { type: "Text", value: "always" },
          { type: "Text", value: "sometimes", when: "$.showIt" },
        ],
      },
      state: { showIt: false },
    });
    const html = win.document.querySelector("#root").textContent;
    assertEq(html.includes("sometimes"), false);
  });

  await test("runtime: List renders items with $item bindings", () => {
    const win = mount({
      root: {
        type: "List",
        items: "$.todos",
        item: { type: "Text", value: "$item" },
      },
      state: { todos: ["buy milk", "walk dog", "ship surface"] },
    });
    const text = win.document.querySelector("#root").textContent;
    for (const t of ["buy milk", "walk dog", "ship surface"]) {
      if (!text.includes(t)) throw new Error("missing: " + t);
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
