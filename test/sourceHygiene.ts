// Every tracked text file must actually be text.
//
// A raw NUL (or other stray control byte) in a source file makes git classify
// it as binary. That is not cosmetic: the file stops being diffable in review
// and `grep` silently matches nothing inside it — it reports "no matches"
// rather than "I can't read this", so the failure looks like an answer. This
// repo shipped exactly that: `server/thumbs.ts` carried two literal NUL bytes
// used as field separators (semantically the right separator, written the
// wrong way — `\0` in a template literal is byte-identical and stays text),
// and the 958-line file carrying the thumbnail pipeline's safety fixes went
// through review undiffable, with greps against it quietly returning nothing.
//
// The separator itself was fine. Writing it as a raw byte was the bug, and it
// is invisible in every editor. So assert it instead.

import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(import.meta.dirname, "..");

// Extensions we require to be text. Anything else (png, gif, ico, mp4, db…)
// is legitimately binary and is skipped.
const TEXT_EXT = new Set([
  ".ts", ".js", ".mjs", ".cjs", ".json", ".md", ".css", ".html", ".svg",
  ".yml", ".yaml", ".sh", ".txt",
]);

// Tab, LF and CR are the control characters that belong in source.
const ALLOWED_CONTROL = new Set([0x09, 0x0a, 0x0d]);

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAILED: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const files = trackedFiles().filter((f) => TEXT_EXT.has(path.extname(f).toLowerCase()));
check("the repo has tracked text files to inspect", files.length > 50, `found ${files.length}`);

const offenders: string[] = [];
for (const rel of files) {
  const abs = path.join(ROOT, rel);
  let buf: Buffer;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    continue; // a tracked file missing from the worktree is not this test's business
  }
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b < 0x20 && !ALLOWED_CONTROL.has(b)) {
      const line = buf.subarray(0, i).toString("utf8").split("\n").length;
      offenders.push(`${rel}:${line} contains 0x${b.toString(16).padStart(2, "0")}`);
      break;
    }
  }
}

check(
  "no tracked source file contains a raw control byte",
  offenders.length === 0,
  offenders.join("; "),
);

// git's own verdict is the one that decides whether a diff renders in review,
// so ask git directly rather than only reasoning about bytes.
const numstat = execFileSync(
  "git",
  ["diff", "--numstat", "--no-renames", "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "HEAD"],
  { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 },
).toString("utf8");
const binaryPerGit = numstat
  .split("\n")
  .filter((l) => l.startsWith("-\t-\t"))
  .map((l) => l.slice(4))
  .filter((f) => TEXT_EXT.has(path.extname(f).toLowerCase()));

check(
  "git does not consider any tracked source file binary",
  binaryPerGit.length === 0,
  binaryPerGit.join("; "),
);

// ── generator residue in Markdown ──
//
// README.md shipped with a literal `</content>` as its last line: the closing
// tag of the wrapper the file was generated inside, left behind by the tool
// that wrote it. It is not Markdown, so GitHub and the npm page render it as
// text on the page everybody reads first, and no gate caught it.
//
// Deliberately NOT an HTML validator. Markdown legitimately contains HTML, and
// these docs use <details>/<summary>. This lists only tags that are never
// document markup, and flags one only when the closing tag has no opening
// partner in the same file — so a doc that genuinely shows `<content>…
// </content>` inside a fence keeps working, while residue (which is always
// unpaired) does not.
const RESIDUE_TAGS = ["content", "document", "documents", "file", "answer", "thinking", "function_results"];

const strays: string[] = [];
for (const rel of files.filter((f) => path.extname(f).toLowerCase() === ".md")) {
  let text: string;
  try {
    text = fs.readFileSync(path.join(ROOT, rel), "utf8");
  } catch {
    continue;
  }
  for (const tag of RESIDUE_TAGS) {
    const close = `</${tag}>`;
    const closes = text.split(close).length - 1;
    if (closes === 0) continue;
    const opens = (text.match(new RegExp(`<${tag}(?:\\s[^>]*)?>`, "g")) || []).length;
    if (closes <= opens) continue;
    const line = text.slice(0, text.indexOf(close)).split("\n").length;
    strays.push(`${rel}:${line} has an unopened ${close}`);
  }
}

check(
  "no tracked Markdown file carries a stray generator tag",
  strays.length === 0,
  strays.join("; "),
);

// ── Migrations are numbered in order, and each number is claimed once ──
//
// `runMigrations` sorts defensively so a mis-ordered array cannot silently
// strand a migration at runtime, but the array should still be authored in
// order — a file that reads 15, 17, 16 is one a reviewer will "fix" back into
// the broken shape. This is the check that fails in CI when a merge conflict
// is resolved the obvious way instead of the correct one, which is exactly how
// three in-flight branches numbered 15/16/17 nearly shipped with 16 unreachable.
{
  const { migrations } = await import("../server/migrations.js");
  const versions = migrations.map((m) => m.version);

  const outOfOrder = versions
    .map((v, i) => (i > 0 && v <= versions[i - 1] ? `v${versions[i - 1]} is followed by v${v}` : null))
    .filter(Boolean);
  check(
    "migrations are declared in ascending version order",
    outOfOrder.length === 0,
    outOfOrder.join("; "),
  );

  const dupes = versions.filter((v, i) => versions.indexOf(v) !== i);
  check(
    "no two migrations claim the same version",
    dupes.length === 0,
    `duplicated: ${[...new Set(dupes)].join(", ")}`,
  );
}

// ── every res.sendFile must opt out of the dotfile check ──
//
// `send` defaults `dotfiles: "ignore"`, and with no `root` it applies that to
// EVERY segment of the absolute path — including segments the request never
// chose. Surface serves two kinds of file by absolute path, and both live
// behind a dot on ordinary machines: artifacts under `~/.surface`, and the
// package's own `client/pair.html` when Node came from nvm/fnm/volta/asdf
// (`~/.nvm/...`). Both 404'd with nothing missing and nothing unreadable.
//
// The artifact case was found and fixed; the `/pair` route was missed and
// shipped broken through 0.2.4 — the pairing page, which is the only way to
// add a phone, 404'd for every version-manager user. CI never saw it because
// runners install Node at /usr/local, which has no dot segment. No functional
// test can catch this without a dot-path install, so assert the call shape
// instead: it is cheap, and it covers the next call site rather than this one.
{
  const offenders: string[] = [];
  for (const rel of files.filter((f) => f.startsWith("server/") && f.endsWith(".ts"))) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(ROOT, rel), "utf8");
    } catch {
      continue;
    }
    // Match a sendFile call through to its closing paren on the same statement.
    for (const m of text.matchAll(/res\.sendFile\(([^;]*?)\);/gs)) {
      const call = m[1];
      if (/dotfiles/.test(call) || /SEND_FILE_OPTS/.test(call)) continue;
      const line = text.slice(0, m.index).split("\n").length;
      offenders.push(`${rel}:${line}`);
    }
  }
  check(
    "every res.sendFile passes a dotfiles option (a dot in the path is not a missing file)",
    offenders.length === 0,
    offenders.join("; "),
  );
}

if (failures > 0) {
  console.error(`\n${failures} source-hygiene check(s) failed`);
  process.exit(1);
}
console.log("Source hygiene tests passed");
