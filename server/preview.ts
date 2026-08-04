// Card previews — the few lines of a surface's own content that a dashboard
// card shows when there is no screenshot to show.
//
// A capture is the best picture of a surface, but it is not always available:
// Chrome may be missing entirely, the capture queue may not have reached an old
// surface yet, and a brand-new surface has nothing on disk for the first second
// or two. The card still has to look like something. Showing the title in large
// type over a tinted field — the previous fallback — repeats the caption
// directly underneath it and says nothing the caption did not already say.
//
// So the fallback shows the *content*: the opening lines of the artifact, set
// small, exactly where the screenshot would be. It costs one bounded read, it
// needs no browser, and it is the same information a screenshot would have
// carried.
import fs from "node:fs";
import type Database from "better-sqlite3";
import { getArtifactFiles } from "./artifacts.js";

export type PreviewMode = "prose" | "code";

export interface CardPreview {
  /** Ready-to-render lines, already trimmed and length-capped. */
  lines: string[];
  /** `prose` sets proportional type and flows; `code` sets monospace lines. */
  mode: PreviewMode;
  /**
   * Indices into `lines` that are headings. A markdown doc whose sub-headings
   * render at body weight reads as one undifferentiated block; the card should
   * keep the structure the author wrote.
   */
  heads?: number[];
}

/** Never read more than this from the head of a file to build a preview. */
const READ_BYTES = 48 * 1024;
const MAX_LINES = 12;
const MAX_CODE_CHARS = 78;
const MAX_PROSE_CHARS = 300;

// Bounded: a dashboard holds a few hundred cards at most, and every entry is a
// dozen short strings. Keyed by version + the file's size/mtime so a linked
// artifact — whose bytes live outside the store and change without a new
// version row — re-reads when the file on disk moves under it.
const CACHE_LIMIT = 512;
const cache = new Map<string, CardPreview | null>();

function cacheGet(key: string): { hit: boolean; value: CardPreview | null } {
  if (!cache.has(key)) return { hit: false, value: null };
  const value = cache.get(key)!;
  // Refresh recency so the map's insertion order is a usable LRU.
  cache.delete(key);
  cache.set(key, value);
  return { hit: true, value };
}

function cacheSet(key: string, value: CardPreview | null): void {
  cache.set(key, value);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/** Test seam — the cache is process-global and would leak between suites. */
export function clearPreviewCache(): void {
  cache.clear();
}

function isTextual(mime: string | null | undefined): boolean {
  if (!mime) return false;
  if (mime.startsWith("text/")) return true;
  return mime === "application/json" || mime === "application/xml";
}

/** Read the head of a file without pulling a multi-megabyte log into memory. */
function readHead(filePath: string): { text: string; size: number; mtimeMs: number } | null {
  let fd: number | undefined;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(Math.min(READ_BYTES, stat.size));
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    return { text: buf.subarray(0, read).toString("utf8"), size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

const ENTITIES: Record<string, string> = {
  // `nbsp` decodes to an ordinary space, not U+00A0: the only thing a preview
  // does with whitespace is collapse it, and a non-breaking space would survive
  // that collapse and print as a gap.
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      // Reject surrogates and out-of-range values rather than emitting a lone
      // surrogate, which would make the JSON payload unencodable.
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      if (code >= 0xd800 && code <= 0xdfff) return whole;
      return String.fromCodePoint(code);
    }
    const named = ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

// Strip C0/C1 controls (except tab) so a preview line can never carry a raw
// escape sequence into a terminal-styled card, and so the JSON payload stays
// clean. Tabs become spaces; everything else in that range is dropped.
function stripControls(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\t/g, "  ").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

/**
 * HTML previews read as the page reads, not as the source reads. `<!doctype
 * html><meta charset="utf-8"><style>…` is a true excerpt of the file and a
 * useless picture of the surface; the words the surface actually shows are the
 * ones worth putting on the card.
 */
function fromHtml(text: string): CardPreview | null {
  const stripped = text
    // Order matters: comments first, or a commented-out `<style>` opener would
    // swallow the rest of the document.
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|head|template|svg)\b[\s\S]*?<\/\1\s*>/gi, " ")
    // An unclosed <script> (or one closed only by EOF) would otherwise leak its
    // source into the preview.
    .replace(/<(script|style)\b[\s\S]*$/gi, " ")
    // Block-level closers become line breaks so headings and paragraphs do not
    // run into each other as one wall of words.
    // Break on the opening tag as well as the closing one. Buttons, cells and
    // labels are inline boxes that read as separate lines on screen, and markup
    // like `<b>Approve</b><span>Emit one action.</span>` inside a single block
    // has no closing block tag between the two — run together it becomes
    // "Approve Emit one action."
    .replace(/<\/?(p|div|section|article|h[1-6]|li|tr|td|th|dt|dd|blockquote|pre|button|label|option|summary|figcaption|legend|nav|header|footer|main|aside|figure)\b[^>]*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ");
  const decoded = stripControls(decodeEntities(stripped));
  const lines: string[] = [];
  let total = 0;
  for (const raw of decoded.split("\n")) {
    // Every run of horizontal whitespace collapses — including the U+00A0 that
    // survives an `&nbsp;`-heavy document — but not the newlines just inserted
    // for block boundaries.
    const line = raw.replace(/[^\S\n]+/g, " ").trim();
    if (!line) continue;
    const room = MAX_PROSE_CHARS - total;
    if (room <= 12) break;
    lines.push(clip(line, room));
    total += line.length;
    if (lines.length >= MAX_LINES) break;
  }
  return lines.length ? { lines, mode: "prose" } : null;
}

/**
 * Markdown reads as plain text by design, but its syntax is punctuation for a
 * parser, not content for a reader: a card that opens with a literal `#` is
 * showing the reader the machinery. Headings lose their hashes, bullets become
 * bullets, emphasis and link syntax fall away, and the hard-wrapped lines of a
 * paragraph rejoin so the card wraps them to its own width instead of the
 * author's editor width.
 */
function markdownInline(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")   // images → alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")    // links → label
    .replace(/`{1,3}([^`]+)`{1,3}/g, "$1")      // inline code → the code
    .replace(/(\*\*|__)(.+?)\1/g, "$2")         // bold
    .replace(/(?<![\w*])(\*|_)(?!\s)(.+?)(?<!\s)\1(?![\w*])/g, "$2") // emphasis
    .replace(/^\s*>\s?/, "")                    // blockquote marker
    .trim();
}

function fromMarkdown(text: string): CardPreview | null {
  const lines: string[] = [];
  const heads: number[] = [];
  let inFence = false;
  let paragraph = "";

  const flush = () => {
    if (paragraph) { lines.push(clip(paragraph, MAX_PROSE_CHARS)); paragraph = ""; }
  };

  for (const raw of stripControls(text).split(/\r?\n/)) {
    if (lines.length >= MAX_LINES) break;
    const line = raw.replace(/\s+$/, "");
    if (/^\s*(```|~~~)/.test(line)) { flush(); inFence = !inFence; continue; }
    if (inFence) {
      const code = line.trim();
      if (code) lines.push(clip(code, MAX_CODE_CHARS));
      continue;
    }
    const trimmed = line.trim();
    // A blank line ends a paragraph; a setext/thematic rule is pure punctuation.
    if (!trimmed || /^(-{3,}|={3,}|\*{3,}|_{3,})$/.test(trimmed)) { flush(); continue; }

    const heading = /^#{1,6}\s+(.*)$/.exec(trimmed);
    if (heading) { flush(); heads.push(lines.length); lines.push(clip(markdownInline(heading[1]), MAX_CODE_CHARS)); continue; }

    const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
    if (bullet) { flush(); lines.push(clip("• " + markdownInline(bullet[1]), MAX_CODE_CHARS)); continue; }

    const numbered = /^(\d+)[.)]\s+(.*)$/.exec(trimmed);
    if (numbered) { flush(); lines.push(clip(`${numbered[1]}. ` + markdownInline(numbered[2]), MAX_CODE_CHARS)); continue; }

    // Ordinary prose: rejoin the author's hard wraps into one paragraph.
    const piece = markdownInline(trimmed);
    if (!piece) continue;
    paragraph = paragraph ? `${paragraph} ${piece}` : piece;
    if (paragraph.length >= MAX_PROSE_CHARS) flush();
  }
  flush();
  if (!lines.length) return null;
  const kept = lines.slice(0, MAX_LINES);
  return { lines: kept, mode: "prose", heads: heads.filter((i) => i < kept.length) };
}

/** Text, logs, JSON and anything else textual: shown as written, in monospace. */
function fromPlain(text: string): CardPreview | null {
  const lines: string[] = [];
  for (const raw of stripControls(text).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim() && !lines.length) continue; // skip a leading blank run only
    lines.push(clip(line, MAX_CODE_CHARS));
    if (lines.length >= MAX_LINES) break;
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.length ? { lines, mode: "code" } : null;
}

export function extractPreview(text: string, mime: string): CardPreview | null {
  if (mime === "text/html") return fromHtml(text);
  if (mime === "text/markdown" || mime === "text/x-markdown") return fromMarkdown(text);
  return fromPlain(text);
}

/**
 * The preview for a card, or null when there is nothing readable to show
 * (an image, a binary, an unreadable path). Cheap enough to call per card on
 * every list: a cache hit is a stat, and a miss is one bounded read.
 */
export function previewForCard(
  db: Database.Database,
  card: { id: string; current_version_id?: string | null; artifact_mime?: string | null },
): CardPreview | null {
  const mime = card.artifact_mime || "";
  if (!isTextual(mime)) return null;
  if (!card.current_version_id) return null;

  let files;
  try { files = getArtifactFiles(db, card.current_version_id); } catch { return null; }
  if (!files.length) return null;
  const entry = files.find((f) => f.path === "index.html")
    || files.find((f) => isTextual(f.mime || mime))
    || files[0];
  if (!entry) return null;

  let stat: fs.Stats;
  try { stat = fs.statSync(entry.storage_path); } catch { return null; }
  const key = `${card.current_version_id}:${entry.path}:${stat.size}:${stat.mtimeMs}`;
  const cached = cacheGet(key);
  if (cached.hit) return cached.value;

  const head = readHead(entry.storage_path);
  const value = head ? extractPreview(head.text, entry.mime || mime) : null;
  cacheSet(key, value);
  return value;
}
