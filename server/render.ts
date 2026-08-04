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
  const fileUrl = escapeHtml(params.fileUrl);
  const mime = escapeHtml(params.mime);
  const filePath = escapeHtml(params.filePath);
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
    .bar {
      display: ${params.preview ? "none" : "flex"};
      align-items: center;
      gap: 14px;
      padding: 14px 22px;
      border-bottom: 1px solid var(--hairline);
      background: rgba(10, 10, 10, 0.78);
      backdrop-filter: blur(20px) saturate(140%);
      -webkit-backdrop-filter: blur(20px) saturate(140%);
      flex-shrink: 0;
      position: relative;
    }
    .bar::after {
      content: ""; position: absolute; left: 8%; right: 8%; bottom: -1px; height: 1px;
      background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.35), rgba(255, 255, 255, 0.18), transparent);
      opacity: 0.55;
    }
    .bar-marker {
      width: 8px;
      height: 8px;
      border-radius: 2px;
      background: linear-gradient(135deg, #ffffff 0%, #c8c8c6 100%);
      box-shadow:
        inset 0 0.5px 0 rgba(255, 255, 255, 0.6),
        0 0 10px rgba(255, 255, 255, 0.55),
        0 0 22px rgba(255, 255, 255, 0.18);
      flex-shrink: 0;
      animation: bar-breathe 4.2s ease-in-out infinite;
    }
    @keyframes bar-breathe {
      0%, 100% { opacity: 0.7; transform: scale(1);   }
      50%      { opacity: 1;   transform: scale(1.15); }
    }
    .bar-titlewrap { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .bar-title {
      font-family: var(--font);
      font-weight: 700;
      font-size: 14px;
      letter-spacing: -0.2px;
      color: var(--text-primary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .bar-meta {
      font-family: var(--font);
      font-size: 9px;
      font-weight: 800;
      letter-spacing: 2.4px;
      text-transform: uppercase;
      color: var(--text-ghost);
      display: flex;
      gap: 10px;
      align-items: center;
      overflow: hidden;
    }
    .bar-meta-dot {
      display: inline-block;
      width: 1px;
      height: 8px;
      background: var(--text-ghost);
      flex-shrink: 0;
    }
    .bar-path {
      font-family: var(--font);
      font-size: 9.5px;
      font-weight: 600;
      letter-spacing: 0.2px;
      color: var(--text-ghost);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 50%;
      direction: rtl;
      text-align: right;
    }
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
  <div class="bar">
    <span class="bar-marker" aria-hidden="true"></span>
    <div class="bar-titlewrap">
      <div class="bar-title">${title}</div>
      <div class="bar-meta"><span>${mime}</span></div>
    </div>
    <div class="bar-path" title="${filePath}">${filePath}</div>
  </div>
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
  if (mime === "text/markdown") return "MD";
  if (mime.startsWith("image/")) return "IMAGE";
  if (mime.startsWith("text/")) return "TEXT";
  return "FILE";
}

// Greedy wrap to at most `maxLines` lines of `max` characters. The final line
// is ellipsised rather than dropped, so a long title still reads as a truncated
// sentence instead of stopping mid-thought.
function wrapForThumb(text: string, max: number, maxLines = 3): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [""];
  if (trimmed.length <= max) return [trimmed];
  const words = trimmed.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  let truncated = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const candidate = current ? current + " " + w : w;
    if (candidate.length <= max) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    if (lines.length === maxLines) { truncated = true; current = ""; break; }
    // A single word longer than the line: hard-cut it rather than overflow.
    current = w.length > max ? w.slice(0, max - 1) + "…" : w;
  }
  if (current && lines.length < maxLines) lines.push(current);
  else if (current) truncated = true;
  if (truncated && lines.length) {
    const last = lines.length - 1;
    lines[last] = lines[last].replace(/[.,;:]?$/, "") + "…";
  }
  return lines.slice(0, maxLines);
}

// Deterministic hue per surface, so a placeholder is stable across reloads and
// two neighbouring cards rarely land on the same colour. Mirrors `hueForId` in
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
export function renderThumbPlaceholder(params: { id?: string; title: string; mime: string }): string {
  const label = escapeHtml(thumbLabelForMime(params.mime));
  const lines = wrapForThumb(params.title, 16).map(escapeHtml);
  const hue = hueForSeed(params.id || params.title || "surface");
  const top = `hsl(${hue}, 52%, 33%)`;
  const bottom = `hsl(${(hue + 40) % 360}, 44%, 14%)`;
  // Top-anchored on purpose. The dashboard crops a 600x600 cover to 16:10 from
  // the top edge, so anything below ~375px is off the card.
  const LABEL_Y = 116;
  const FIRST_LINE_Y = 186;
  const LINE_H = 56;
  const titleLines = lines.map((line, i) =>
    `<text x="52" y="${FIRST_LINE_Y + i * LINE_H}" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif" font-size="45" font-weight="600" fill="#ffffff" fill-opacity="0.97" letter-spacing="-1.2">${line}</text>`
  ).join("");
  // Gradient ids are namespaced per cover. Two placeholders inlined into one
  // document would otherwise share the first one's `id="field"`, and every card
  // after the first would wear the first card's colour.
  const ns = `t${hue}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600" width="600" height="600" role="img" aria-label="${escapeHtml(params.title)}">
    <defs>
      <linearGradient id="${ns}-field" x1="0" y1="0" x2="0.5" y2="1">
        <stop offset="0%" stop-color="${top}"/>
        <stop offset="70%" stop-color="${bottom}"/>
        <stop offset="100%" stop-color="${bottom}"/>
      </linearGradient>
      <radialGradient id="${ns}-sheen" cx="22%" cy="0%" r="70%">
        <stop offset="0%" stop-color="#ffffff" stop-opacity="0.26"/>
        <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="600" height="600" fill="url(#${ns}-field)"/>
    <rect width="600" height="600" fill="url(#${ns}-sheen)"/>
    <g fill="none" stroke="#ffffff" stroke-opacity="0.09" stroke-width="1.5">
      <circle cx="548" cy="86" r="186"/>
      <circle cx="548" cy="86" r="124"/>
      <circle cx="548" cy="86" r="62"/>
    </g>
    <text x="52" y="${LABEL_Y}" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="19" font-weight="500" fill="#ffffff" fill-opacity="0.62" letter-spacing="3.4">${label}</text>
    ${titleLines}
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
