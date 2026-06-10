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
    @import url("https://fonts.googleapis.com/css2?family=Inter:wght@500;600;700;800;900&display=swap");
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
    const mime = ${JSON.stringify(params.mime)};
    const fileUrl = ${JSON.stringify(params.fileUrl)};
    const viewer = document.getElementById("viewer");
    window.parent && window.parent.postMessage({ surfaceProtocol: 1, artifactId: ${JSON.stringify(params.artifactId)}, type: "READY" }, "*");

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
      window.parent && window.parent.postMessage({ surfaceProtocol: 1, artifactId: ${JSON.stringify(params.artifactId)}, type: "ERROR", message: err.message }, "*");
    });
  </script>
</body>
</html>`;
}

function paletteForMime(mime: string) {
  if (mime === "text/html") return { accent: "#ff5c3a", bg: "#fff5f1", text: "#1a1a1a", label: "HTML" };
  if (mime.startsWith("video/")) return { accent: "#3b5bd9", bg: "#eef2fb", text: "#0f1c47", label: "VIDEO" };
  if (mime.startsWith("audio/")) return { accent: "#0aaf52", bg: "#eefbf3", text: "#0a3b1f", label: "AUDIO" };
  if (mime === "application/pdf") return { accent: "#c81e1e", bg: "#fdeeee", text: "#3b0a0a", label: "PDF" };
  if (mime === "text/markdown") return { accent: "#4a4a4a", bg: "#f4f4f4", text: "#111", label: "MD" };
  if (mime.startsWith("image/")) return { accent: "#6d28d9", bg: "#f3eefb", text: "#1e0a47", label: "IMAGE" };
  if (mime.startsWith("text/")) return { accent: "#444", bg: "#f4f4f4", text: "#111", label: "TEXT" };
  return { accent: "#666", bg: "#f4f4f4", text: "#111", label: "FILE" };
}

function wrapForThumb(text: string, max: number): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= max) return [trimmed];
  const words = trimmed.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    const candidate = current ? current + " " + w : w;
    if (candidate.length <= max) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = w;
      if (lines.length === 2) break;
    }
  }
  if (current && lines.length < 2) lines.push(current);
  if (lines.length === 2 && lines[1].length > max) {
    lines[1] = lines[1].slice(0, max - 1) + "…";
  }
  return lines.slice(0, 2);
}

export function renderThumbPlaceholder(params: { title: string; mime: string }): string {
  const palette = paletteForMime(params.mime);
  const lines = wrapForThumb(params.title, 18).map(escapeHtml);
  const label = escapeHtml(palette.label);
  const titleY = lines.length === 1 ? 360 : 340;
  const titleLines = lines.map((line, i) =>
    `<text x="300" y="${titleY + i * 48}" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif" font-size="38" font-weight="500" fill="${palette.text}" letter-spacing="-0.5">${line}</text>`
  ).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600" width="600" height="600">
    <rect width="600" height="600" fill="${palette.bg}"/>
    <circle cx="300" cy="210" r="56" fill="${palette.accent}"/>
    <text x="300" y="222" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif" font-size="22" font-weight="600" fill="#fff" letter-spacing="2">${label}</text>
    ${titleLines}
  </svg>`;
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
