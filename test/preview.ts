// Card preview extraction — the few lines of a surface's own content that a
// card shows when there is no screenshot to show.
//
// Every assertion here is about what a *reader* sees on the card. The extractor
// is allowed to be crude (it is regex over a head read, not a parser); it is not
// allowed to put the machinery on screen — a literal `#`, a `<style>` block, a
// wall of `&nbsp;` — or to let a control character through.
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { cleanupDir, tmpDir } from "./helpers.js";

// Isolate the data dir BEFORE importing anything that reads it: getDataDir
// caches on first call, so a late assignment silently points the suite at the
// developer's real store.
const dataDir = tmpDir("surface-preview-");
process.env.SURFACE_DATA_DIR = dataDir;

const { clearPreviewCache, extractPreview, previewForCard } = await import("../server/preview.js");
const { initDb, closeDb, getDb } = await import("../server/db.js");
const { createArtifact, linkArtifact } = await import("../server/artifacts.js");

let failures = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL  ${name}`);
    console.log(String(err instanceof Error ? err.stack : err));
  }
}

// ── HTML ──
// An HTML surface's source opens with a doctype, a meta tag and a stylesheet.
// None of that is what the surface shows, so none of it belongs on the card.

test("html previews read as the page reads, not as the source reads", () => {
  const p = extractPreview(
    `<!doctype html><meta charset="utf-8"><style>body{color:red}</style>
     <h1>Ship the deploy?</h1><p>The user picks a choice.</p>`,
    "text/html",
  );
  assert.ok(p, "expected a preview");
  assert.equal(p!.mode, "prose");
  assert.deepEqual(p!.lines, ["Ship the deploy?", "The user picks a choice."]);
});

test("html previews never leak a script body", () => {
  const p = extractPreview(
    `<h1>Board</h1><script>const secret = "do not show me";</script><p>Running tests</p>`,
    "text/html",
  );
  assert.ok(p!.lines.every((l) => !l.includes("do not show me")), `leaked: ${p!.lines.join(" | ")}`);
});

test("an unterminated script cannot spill its source into the preview", () => {
  // A `<script>` closed only by end-of-file would defeat a paired open/close
  // rule, and the whole tail of the file would land on the card.
  const p = extractPreview(`<h1>Title</h1><script>const leak = "spilled";`, "text/html");
  assert.ok(p!.lines.every((l) => !l.includes("spilled")), `leaked: ${p!.lines.join(" | ")}`);
});

test("a commented-out style opener cannot swallow the document", () => {
  const p = extractPreview(`<!-- <style> --><h1>Still here</h1>`, "text/html");
  assert.deepEqual(p!.lines, ["Still here"]);
});

test("block boundaries become line breaks so headings do not run into body copy", () => {
  const p = extractPreview(`<div><h2>Wave 1</h2><div>Shadow-write to both queues</div></div>`, "text/html");
  assert.deepEqual(p!.lines, ["Wave 1", "Shadow-write to both queues"]);
});

test("entities are decoded, and nbsp collapses like an ordinary space", () => {
  const p = extractPreview(`<p>a&nbsp;&nbsp;&nbsp;b &amp; c &#8212; d</p>`, "text/html");
  assert.deepEqual(p!.lines, ["a b & c — d"]);
});

test("a lone surrogate escape is left alone rather than decoded", () => {
  // String.fromCodePoint would happily produce an unpaired surrogate, which
  // makes the JSON payload for the whole card list unencodable.
  const p = extractPreview(`<p>x &#xD800; y</p>`, "text/html");
  assert.ok(p!.lines[0].includes("&#xD800;"), `expected the escape to survive verbatim: ${p!.lines[0]}`);
  assert.ok(!/[\uD800-\uDFFF]/.test(JSON.stringify(p!.lines)) || JSON.stringify(p!.lines).length > 0);
});

// ── Markdown ──

test("markdown headings lose their hashes", () => {
  const p = extractPreview("# Migration notes\n\nThe staged rollout.", "text/markdown");
  assert.deepEqual(p!.lines, ["Migration notes", "The staged rollout."]);
  assert.deepEqual(p!.heads, [0], "the heading is marked as one");
});

test("markdown bullets become bullets and numbers keep their numbers", () => {
  const p = extractPreview("- one\n* two\n1. three", "text/markdown");
  assert.deepEqual(p!.lines, ["• one", "• two", "1. three"]);
});

test("hard-wrapped paragraphs rejoin so the card wraps them to its own width", () => {
  const p = extractPreview("The staged rollout moves\nthe workers off the queue.\n\nNext.", "text/markdown");
  assert.deepEqual(p!.lines, ["The staged rollout moves the workers off the queue.", "Next."]);
});

test("emphasis, code spans and link syntax fall away", () => {
  const p = extractPreview("Use **surface doc** with `--watch`, see [the guide](https://x/y).", "text/markdown");
  assert.deepEqual(p!.lines, ["Use surface doc with --watch, see the guide."]);
});

test("thematic breaks and fence markers do not spend a line", () => {
  const p = extractPreview("Intro\n\n---\n\n```js\nconst a = 1;\n```", "text/markdown");
  assert.deepEqual(p!.lines, ["Intro", "const a = 1;"]);
});

// ── Plain text ──

test("a log is shown as written, in monospace, blank lines and all", () => {
  const p = extractPreview("\n\n[10:22:01] pulling\n\n[10:22:14] pulled\n", "text/plain");
  assert.equal(p!.mode, "code");
  assert.deepEqual(p!.lines, ["[10:22:01] pulling", "", "[10:22:14] pulled"]);
});

test("a trailing blank run is trimmed, so the excerpt does not end in dead rows", () => {
  const p = extractPreview("one\ntwo\n\n\n", "text/plain");
  assert.deepEqual(p!.lines, ["one", "two"]);
});

test("crlf line endings do not leave a carriage return on every line", () => {
  const p = extractPreview("one\r\ntwo\r\n", "text/plain");
  assert.deepEqual(p!.lines, ["one", "two"]);
});

test("an over-long line is cut and reads as truncated", () => {
  const p = extractPreview("x".repeat(400), "text/plain");
  assert.ok(p!.lines[0].length < 400, "the line must be cut");
  assert.ok(p!.lines[0].endsWith("…"), "a cut line must read as truncated");
});

test("empty and whitespace-only content produce no preview at all", () => {
  assert.equal(extractPreview("", "text/plain"), null);
  assert.equal(extractPreview("   \n\n  \n", "text/plain"), null);
  assert.equal(extractPreview("<style>body{}</style>", "text/html"), null);
});

// ── Control characters ──
// A preview line is rendered into an SVG document by the server and into the
// dashboard by the client. A raw escape sequence in it is a parse error in the
// first case and a terminal escape in the second.

test("control characters are stripped and tabs become spaces", () => {
  const p = extractPreview("a\u0000b\u001bc\td", "text/plain");
  assert.equal(p!.lines[0], "abc  d");
});

test("no extractor lets a control character through", () => {
  const nasty = "a\u0000b\u0007c\u001bde";
  for (const [text, mime] of [
    [`<p>${nasty}</p>`, "text/html"],
    [`# ${nasty}`, "text/markdown"],
    [nasty, "text/plain"],
  ] as const) {
    const p = extractPreview(text, mime);
    const joined = (p?.lines || []).join("");
    assert.ok(
      !new RegExp("[" + [0,7,8,11,12,27,31,127,159].map((c) => String.fromCharCode(c)).join("") + "]").test(joined),
      `control character survived ${mime}: ${JSON.stringify(joined)}`,
    );
  }
});

// ── The card path: mime gating, caching, invalidation ──

initDb();

function makeArtifact(title: string, mime: string, body: string, file = "a.txt") {
  return createArtifact(getDb(), {
    title,
    kind: mime === "text/html" ? "html" : "file",
    mime,
    source_type: "created",
    files: [{ path: file, content: body, mime }],
    reason: "test",
  });
}

test("a binary surface has no preview to offer", () => {
  const art = createArtifact(getDb(), {
    title: "shot",
    kind: "file",
    mime: "image/png",
    source_type: "created",
    files: [{ path: "a.png", content_base64: Buffer.from("not really a png").toString("base64"), mime: "image/png" }],
    reason: "test",
  });
  const card = { id: art.artifact.id, current_version_id: art.artifact.current_version_id, artifact_mime: "image/png" };
  assert.equal(previewForCard(getDb(), card), null);
});

test("a text surface previews from its stored bytes", () => {
  const art = makeArtifact("log", "text/plain", "first line\nsecond line");
  const card = { id: art.artifact.id, current_version_id: art.artifact.current_version_id, artifact_mime: "text/plain" };
  const p = previewForCard(getDb(), card);
  assert.deepEqual(p!.lines, ["first line", "second line"]);
});

test("a card with no current version does not throw", () => {
  assert.equal(previewForCard(getDb(), { id: "nope", current_version_id: null, artifact_mime: "text/plain" }), null);
});

test("an unreadable path yields no preview rather than an error", () => {
  const art = makeArtifact("gone", "text/plain", "here for now");
  const card = { id: art.artifact.id, current_version_id: art.artifact.current_version_id, artifact_mime: "text/plain" };
  const files = getDb()
    .prepare("SELECT storage_path FROM artifact_files WHERE artifact_version_id = ?")
    .all(art.artifact.current_version_id) as { storage_path: string }[];
  fs.rmSync(files[0].storage_path, { force: true });
  clearPreviewCache();
  assert.equal(previewForCard(getDb(), card), null);
});

// A linked artifact's bytes live outside the store and change with no new
// version row, so a cache keyed on the version alone would serve the first
// preview forever.
test("editing a linked file's bytes invalidates its cached preview", () => {
  const linkPath = path.join(dataDir, "linked.txt");
  fs.writeFileSync(linkPath, "before the edit");
  const art = linkArtifact(getDb(), { path: linkPath, title: "linked" });
  const card = { id: art.artifact.id, current_version_id: art.artifact.current_version_id, artifact_mime: "text/plain" };
  const storage = (getDb()
    .prepare("SELECT storage_path FROM artifact_files WHERE artifact_version_id = ?")
    .get(art.artifact.current_version_id) as { storage_path: string }).storage_path;

  assert.deepEqual(previewForCard(getDb(), card)!.lines, ["before the edit"]);
  // Bump the size as well as the content: a same-second rewrite of the same
  // length is the one case an mtime-only key can miss, and this key carries both.
  fs.writeFileSync(storage, "after the edit, longer now");
  assert.deepEqual(previewForCard(getDb(), card)!.lines, ["after the edit, longer now"]);
});

closeDb();
cleanupDir(dataDir);

if (failures) {
  console.error(`\n${failures} preview test(s) failed\n`);
  process.exit(1);
}
console.log("\nPreview tests passed\n");
