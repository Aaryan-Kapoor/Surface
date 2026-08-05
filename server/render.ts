// HTML the server renders itself: the non-HTML artifact viewer shell and the
// SVG thumbnail placeholder. Pure functions, no DB access.

export function defaultPathForMime(mime?: string): string {
  if (mime === "text/markdown") return "document.md";
  if (mime === "application/pdf") return "document.pdf";
  if (mime === "image/svg+xml") return "image.svg";
  if (mime?.startsWith("image/")) return "image";
  if (mime?.startsWith("video/")) return "video";
  if (mime?.startsWith("audio/")) return "audio";
  if (mime === "application/vnd.mermaid") return "diagram.mmd";
  return "index.html";
}

export function pickRenderableFile(files: Array<{ path: string; mime: string | null }>, artifactMime: string | null) {
  if (files.length === 0) return undefined;
  const preferredMime = artifactMime || files[0].mime;
  return (
    files.find((file) => file.path === "index.html") ||
    files.find((file) => file.mime === preferredMime) ||
    files[0]
  );
}

export function renderArtifactShell(params: {
  artifactId: string;
  title: string;
  mime: string;
  filePath: string;
  fileUrl: string;
  preview: boolean;
}): string {
  const title = escapeHtml(params.title);
  const previewClass = params.preview ? " preview" : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    * { box-sizing: border-box; }
    :root {
      --void: #0a0a0a;
      --hairline: rgba(255, 255, 255, 0.08);
      --text-primary: #ededec;
      --text-secondary: rgba(237, 237, 236, 0.52);
      --text-ghost: rgba(237, 237, 236, 0.22);
      --accent: #ffffff;
      --font: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    }
    /* No web-font load: surfaces must render identically offline and inside the
       headless thumbnailer, which has no network. The stack above resolves to
       the platform UI face everywhere. */
    html, body { margin: 0; width: 100%; height: 100%; background: var(--void); color: var(--text-primary); font-family: var(--font); -webkit-font-smoothing: antialiased; }
    body { display: flex; flex-direction: column; overflow: hidden; }
    /* The presented document used to carry its own title bar. In the app it was
       the second of three labels for the same file — the surface bar above it
       already gives title, kind and age, and a PDF adds the browser's own
       filename toolbar below. The viewer shows the document. */
    .viewer { flex: 1; min-height: 0; display: flex; align-items: stretch; justify-content: stretch; overflow: auto; }
    .viewer.preview { overflow: hidden; }
    img, video { display: block; max-width: 100%; max-height: 100%; margin: auto; }
    /* Thumbnail capture: fill the square instead of letterboxing, so an image
       surface reads as the image and not as a picture floating in a black box. */
    .viewer.preview img { width: 100%; height: 100%; max-width: none; max-height: none; object-fit: cover; object-position: center; }
    /* A 600x600 capture ends up ~320px wide on a card. Body-copy sizing there is
       a grey smudge, so plain-text surfaces are set larger for the preview. */
    .viewer.preview pre { font-size: 20px; line-height: 1.55; padding: 40px 44px; }
    audio { margin: auto; width: min(720px, 90vw); }
    iframe { width: 100%; height: 100%; border: 0; background: white; }
    pre {
      width: 100%;
      margin: 0;
      padding: 28px 32px;
      white-space: pre-wrap;
      overflow: auto;
      line-height: 1.65;
      font: 600 13px/1.65 var(--font);
      color: rgba(255, 255, 255, 0.82);
    }
    .markdown {
      width: min(720px, calc(100% - 48px));
      margin: 0 auto;
      padding: 48px 0 64px;
      line-height: 1.7;
      color: rgba(255, 255, 255, 0.86);
      font-size: 15px;
      font-weight: 500;
    }
    .markdown h1 { font-family: var(--font); font-weight: 900; color: #ffffff; font-size: 36px; line-height: 1.05; margin: 0 0 24px; letter-spacing: -1.5px; }
    .markdown h2 { font-family: var(--font); font-weight: 800; color: #ffffff; font-size: 24px; line-height: 1.15; margin: 36px 0 16px; letter-spacing: -0.6px; }
    .markdown h3 { font-family: var(--font); font-weight: 700; color: #ffffff; font-size: 16px; line-height: 1.3; margin: 28px 0 12px; letter-spacing: -0.2px; }
    .markdown p { margin: 0 0 16px; }
    .markdown code { background: rgba(255, 255, 255, 0.06); padding: 1px 6px; border-radius: 3px; font-family: var(--font); font-weight: 700; font-size: 0.88em; color: #ffffff; }
    .markdown pre code { background: transparent; padding: 0; }
    .markdown strong { color: #ffffff; font-weight: 800; }
    .markdown a { color: var(--accent); text-decoration: none; border-bottom: 1px solid rgba(255, 255, 255, 0.32); }
    .markdown a:hover { border-bottom-color: var(--accent); }
  </style>
</head>
<body>
  <main id="viewer" class="viewer${previewClass}"></main>
  <script>
    const mime = ${safeJsonForScript(params.mime)};
    const fileUrl = ${safeJsonForScript(params.fileUrl)};
    const viewer = document.getElementById("viewer");
    window.parent && window.parent.postMessage({ surfaceProtocol: 1, artifactId: ${safeJsonForScript(params.artifactId)}, type: "READY" }, "*");

    const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
    const markdownToHtml = (text) => {
      let escaped = escapeHtml(text);
      escaped = escaped.replace(/^### (.*)$/gm, "<h3>$1</h3>")
        .replace(/^## (.*)$/gm, "<h2>$1</h2>")
        .replace(/^# (.*)$/gm, "<h1>$1</h1>")
        .replace(/\\*\\*(.*?)\\*\\*/g, "<strong>$1</strong>")
        .replace(/\\\`([^\\\`]+)\\\`/g, "<code>$1</code>")
        .replace(/\\n\\n/g, "</p><p>")
        .replace(/\\n/g, "<br>");
      return "<p>" + escaped + "</p>";
    };

    async function render() {
      if (mime.startsWith("image/")) {
        const img = document.createElement("img");
        img.src = fileUrl;
        viewer.appendChild(img);
        return;
      }
      if (mime.startsWith("video/")) {
        const video = document.createElement("video");
        video.src = fileUrl;
        video.controls = true;
        viewer.appendChild(video);
        return;
      }
      if (mime.startsWith("audio/")) {
        const audio = document.createElement("audio");
        audio.src = fileUrl;
        audio.controls = true;
        viewer.appendChild(audio);
        return;
      }
      if (mime === "application/pdf") {
        const frame = document.createElement("iframe");
        frame.src = fileUrl;
        viewer.appendChild(frame);
        return;
      }
      const text = await fetch(fileUrl).then((r) => r.text());
      if (mime === "text/markdown") {
        const div = document.createElement("article");
        div.className = "markdown";
        div.innerHTML = markdownToHtml(text);
        viewer.appendChild(div);
        return;
      }
      const pre = document.createElement("pre");
      pre.textContent = text;
      viewer.appendChild(pre);
    }
    render().catch((err) => {
      viewer.textContent = err.message;
      window.parent && window.parent.postMessage({ surfaceProtocol: 1, artifactId: ${safeJsonForScript(params.artifactId)}, type: "ERROR", message: err.message }, "*");
    });
  </script>
</body>
</html>`;
}

function thumbLabelForMime(mime: string): string {
  if (mime === "text/html") return "HTML";
  if (mime.startsWith("video/")) return "VIDEO";
  if (mime.startsWith("audio/")) return "AUDIO";
  if (mime === "application/pdf") return "PDF";
  if (mime === "text/markdown") return "MARKDOWN";
  if (mime.startsWith("image/")) return "IMAGE";
  if (mime.startsWith("text/")) return "TEXT";
  return "SURFACE";
}

// Deterministic hue per surface, so a cover's tint is stable across reloads and
// two neighbouring cards rarely land on the same one. Mirrors `hueForId` in
// client/app.js — the two covers must be the same picture.
function hueForSeed(seed: string): number {
  // FNV-1a: a multiply-by-31 hash walks the hue wheel in lockstep with the
  // input, so ids that differ by one character land on neighbouring colours.
  // FNV avalanches, so adjacent surfaces get unrelated hues.
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 360;
}

// The cover a surface wears until a real capture exists. This is the picture the
// grid shows first, so it is a designed object rather than a file-extension
// chip: a tinted field keyed to the surface, the title set large enough to read
// at card size, and the kind as a quiet caption.
export function renderThumbPlaceholder(params: {
  id?: string;
  title: string;
  mime: string;
  preview?: { lines: string[]; mode: "prose" | "code"; heads?: number[] } | null;
}): string {
  const excerpt = params.preview && params.preview.lines.length
    ? renderExcerptCover(params)
    : null;
  if (excerpt) return excerpt;
  return renderTitleCover(params);
}

/**
 * The same picture the dashboard card paints for itself (`.card-fallback` in
 * client/style.css): the surface's opening lines on the app's own paper. The
 * two must agree — this SVG is what any *other* client gets from /thumb, and a
 * grid that mixed the two looks broken.
 */
function renderExcerptCover(params: {
  id?: string;
  title: string;
  preview?: { lines: string[]; mode: "prose" | "code"; heads?: number[] } | null;
}): string | null {
  const preview = params.preview;
  if (!preview) return null;
  const hue = hueForSeed(params.id || params.title || "surface");
  const code = preview.mode === "code";
  const heads = new Set(preview.heads || []);
  // The dashboard crops a 600x600 cover to 16:10 from the top edge, so
  // everything has to land above y=375.
  const PAD_X = 46;
  const TOP = 74;
  const leadSize = code ? 25 : 42;
  const bodySize = code ? 25 : 29;
  const lineH = code ? 40 : 42;
  const family = code
    ? "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace"
    : "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
  // SVG has no text layout, so the line length is estimated: the mono face is
  // exactly 0.6em per glyph, and the proportional one averages a shade over
  // half an em. A line past the estimate is ellipsised rather than hard-cut, so
  // it reads as truncated instead of as a rendering fault.
  const EM_RATIO = code ? 0.6 : 0.505;
  const fit = (text: string, size: number) => {
    const max = Math.max(8, Math.floor((600 - PAD_X * 2) / (size * EM_RATIO)));
    return text.length <= max ? text : text.slice(0, max - 1).trimEnd() + "…";
  };

  const rows: string[] = [];
  let y = TOP;
  const lines = preview.lines.slice(0, code ? 9 : 6);
  for (let i = 0; i < lines.length; i++) {
    const lead = !code && i === 0;
    const size = lead ? leadSize : bodySize;
    if (lead) y += 10;
    const text = escapeHtml(fit(xmlSafeText(lines[i]), size));
    const weight = lead || heads.has(i) ? 600 : 400;
    // A log's opening line carries the same emphasis it gets in the dashboard
    // card, where `.card-fallback--code .card-fallback-line:first-child` is set
    // in full ink.
    const opacity = lead || (code && i === 0) ? 0.97 : heads.has(i) ? 0.72 : 0.5;
    rows.push(
      `<text x="${PAD_X}" y="${y + size * 0.8}" font-family="${family}" font-size="${size}" font-weight="${weight}" fill="var(--ink)" fill-opacity="${opacity}" letter-spacing="${lead ? -0.9 : 0}">${text}</text>`,
    );
    y += lead ? size * 1.26 + 16 : lineH;
    if (y > 360) break;
  }
  if (!rows.length) return null;

  const ns = `p${hue}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600" width="600" height="600" role="img" aria-label="${escapeHtml(xmlSafeText(params.title))}">
    <style>
      :root { --paper: #121212; --ink: #ffffff; }
      @media (prefers-color-scheme: light) { :root { --paper: #ffffff; --ink: #0b0c0e; } }
    </style>
    <defs>
      <radialGradient id="${ns}-tint" cx="0%" cy="0%" r="95%">
        <stop offset="0%" stop-color="hsl(${hue}, 62%, 52%)" stop-opacity="0.14"/>
        <stop offset="100%" stop-color="hsl(${hue}, 62%, 52%)" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="${ns}-scrim" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--paper)" stop-opacity="0"/>
        <stop offset="100%" stop-color="var(--paper)" stop-opacity="1"/>
      </linearGradient>
    </defs>
    <rect width="600" height="600" fill="var(--paper)"/>
    <rect width="600" height="600" fill="url(#${ns}-tint)"/>
    ${rows.join("")}
    <rect x="0" y="262" width="600" height="113" fill="url(#${ns}-scrim)"/>
  </svg>`;
}

/**
 * Nothing readable to excerpt — an image mid-capture, a binary, an unreadable
 * path. The card in the dashboard says the kind once, quietly, and stops
 * (`.card-fallback--bare`); this is the same picture. The old cover printed the
 * title in 45px over a saturated field, directly above a caption that already
 * carried it.
 */
function renderTitleCover(params: { id?: string; title: string; mime: string }): string {
  // This SVG is served as `image/svg+xml`, which a browser renders as a
  // *document* — so escaping is a trust boundary, not cosmetics (escapeHtml
  // covers & < > " ', i.e. both text nodes and quoted attributes). Control
  // characters are stripped rather than escaped: XML 1.0 forbids most of C0
  // outright, and one in a title would turn the whole cover into a parse error
  // — a blank card instead of a picture.
  const title = xmlSafeText(params.title);
  const label = escapeHtml(thumbLabelForMime(params.mime));
  const hue = hueForSeed(params.id || params.title || "surface");
  // Gradient ids are namespaced per cover. Two placeholders inlined into one
  // document would otherwise share the first one's id, and every cover after
  // the first would wear the first one's colour.
  const ns = `t${hue}`;
  // The dashboard crops this 600x600 cover to 16:10 from the top edge, so the
  // visible band is 0..375 and its centre is y=187.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600" width="600" height="600" role="img" aria-label="${escapeHtml(title)}">
    <style>
      :root { --paper: #121212; --ink: #ffffff; }
      @media (prefers-color-scheme: light) { :root { --paper: #ffffff; --ink: #0b0c0e; } }
    </style>
    <defs>
      <radialGradient id="${ns}-tint" cx="0%" cy="0%" r="95%">
        <stop offset="0%" stop-color="hsl(${hue}, 62%, 52%)" stop-opacity="0.14"/>
        <stop offset="100%" stop-color="hsl(${hue}, 62%, 52%)" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="600" height="600" fill="var(--paper)"/>
    <rect width="600" height="600" fill="url(#${ns}-tint)"/>
    <text x="300" y="196" text-anchor="middle" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="22" font-weight="500" fill="var(--ink)" fill-opacity="0.22" letter-spacing="4">${label}</text>
  </svg>`;
}

// Inject the surface.js runtime into surface HTML as it is served, so every
// surface gets data-surface-bind / Surface.action() with no build step. The
// tag goes just before </body> (or at the end), keeping byte offsets of the
// author's own markup untouched.
export function injectSurfaceRuntime(html: Buffer, artifactId: string): Buffer {
  const tag = `<script src="/surface.js?id=${encodeURIComponent(artifactId)}&v=64"></script>`;
  const text = html.toString("utf8");
  if (text.includes('src="/surface.js')) return html;
  const idx = text.toLowerCase().lastIndexOf("</body>");
  const out = idx === -1
    ? `${text}\n${tag}\n`
    : `${text.slice(0, idx)}${tag}\n${text.slice(idx)}`;
  return Buffer.from(out, "utf8");
}

// XML 1.0 permits only tab, newline and carriage return out of the C0 range,
// and no C1 controls at all. Anything else in a title makes an SVG the browser
// refuses to parse, so drop it before escaping.
function xmlSafeText(value: string): string {
  // eslint-disable-next-line no-control-regex
  return String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return char;
    }
  });
}

// JSON for embedding inside an inline <script> block. Plain JSON.stringify is
// NOT safe there: a value containing `</script>` (or the U+2028/U+2029 line
// terminators, which are invalid in JS string literals) breaks out of the
// script. Escape `<` and the line separators so agent/device-authored strings
// can never execute.
export function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
