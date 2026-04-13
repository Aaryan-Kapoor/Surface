// Minimal runner for the edit primitive. Runs: `npx tsx test/edits.test.ts`
import { applyEdits, EditError } from "../server/edits.js";

let failed = 0;
let passed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failed++;
    console.log(`  FAIL ${name}\n       ${err.message || err}`);
  }
}

function assertEq<T>(a: T, b: T, label = "") {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${label}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}

function assertThrows(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (err) {
    if (err instanceof EditError && err.code === code) return;
    throw new Error(`expected EditError code=${code}, got ${err}`);
  }
  throw new Error(`expected throw (code=${code}), none`);
}

test("applies a single unique edit", () => {
  const r = applyEdits("<p>Hello World</p>", [
    { old_string: "Hello", new_string: "Goodbye" },
  ]);
  assertEq(r.html, "<p>Goodbye World</p>");
  assertEq(r.applied, 1);
  assertEq(r.replaced, 1);
});

test("applies multiple sequential edits", () => {
  const r = applyEdits("a b c", [
    { old_string: "a", new_string: "A" },
    { old_string: "b", new_string: "B" },
    { old_string: "c", new_string: "C" },
  ]);
  assertEq(r.html, "A B C");
  assertEq(r.applied, 3);
  assertEq(r.replaced, 3);
});

test("later edits see earlier results", () => {
  const r = applyEdits("foo", [
    { old_string: "foo", new_string: "bar" },
    { old_string: "bar", new_string: "baz" },
  ]);
  assertEq(r.html, "baz");
});

test("replace_all replaces every occurrence", () => {
  const r = applyEdits("x x x x", [
    { old_string: "x", new_string: "y", replace_all: true },
  ]);
  assertEq(r.html, "y y y y");
  assertEq(r.replaced, 4);
});

test("ambiguous match without replace_all fails", () => {
  assertThrows(
    () => applyEdits("foo foo", [{ old_string: "foo", new_string: "bar" }]),
    "ambiguous"
  );
});

test("not_found fails", () => {
  assertThrows(
    () => applyEdits("hello", [{ old_string: "nope", new_string: "x" }]),
    "not_found"
  );
});

test("identical old/new fails", () => {
  assertThrows(
    () => applyEdits("x", [{ old_string: "x", new_string: "x" }]),
    "identical"
  );
});

test("empty old_string fails", () => {
  assertThrows(
    () => applyEdits("x", [{ old_string: "", new_string: "y" }]),
    "empty_old_string"
  );
});

test("empty edits array fails", () => {
  assertThrows(() => applyEdits("x", []), "bad_shape");
});

test("replace_all with single match still works", () => {
  const r = applyEdits("only once", [
    { old_string: "once", new_string: "twice", replace_all: true },
  ]);
  assertEq(r.html, "only twice");
  assertEq(r.replaced, 1);
});

test("preserves surrounding whitespace and newlines", () => {
  const src = "<div>\n  <span>x</span>\n</div>";
  const r = applyEdits(src, [
    { old_string: "  <span>x</span>\n", new_string: "  <span>y</span>\n" },
  ]);
  assertEq(r.html, "<div>\n  <span>y</span>\n</div>");
});

test("handles edits that introduce new match sites without over-replacing", () => {
  // After first edit, the second edit's old_string only matches once.
  const r = applyEdits("abc", [
    { old_string: "b", new_string: "XbX" },
    { old_string: "XbX", new_string: "Y" },
  ]);
  assertEq(r.html, "aYc");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
