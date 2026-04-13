// Declarative widgets — server-side validation + shell HTML rendering.
//
// A widgets surface stores a JSON spec in `surfaces.spec` and a rendered
// shell in `surfaces.html`. The shell is the tiny HTML that loads the
// widget runtime and inlines the spec as JSON; all dynamic rendering and
// state updates happen client-side inside the iframe.
//
// On update, the PWA routes new specs through the bootloader's
// `surface/spec` channel so running state (timers, in-progress inputs) is
// preserved — we don't re-emit the whole iframe.

export type WidgetNode = {
  type: string;
  when?: unknown;
  props?: Record<string, unknown>;
  children?: WidgetNode[];
  // Legacy-friendly: components also accept top-level prop keys.
  [key: string]: unknown;
};

export interface WidgetSpec {
  version?: number;
  root: WidgetNode;
  state?: Record<string, unknown>;
  timers?: Array<{ every: number; while?: string; do: unknown[] }>;
  meta?: Record<string, unknown>;
}

// Component names the runtime knows about. Kept in sync with
// client/lib/surface-widgets.js CATALOG. Validation rejects unknown
// component types to keep agent output honest.
export const WIDGET_CATALOG = new Set([
  "Stack",
  "Card",
  "Text",
  "Button",
  "Input",
  "Checkbox",
  "Image",
  "ProgressBar",
  "ProgressRing",
  "List",
  "Spacer",
  "Box",
]);

export class SpecError extends Error {
  constructor(message: string, public pathStr: string) {
    super(`${message} at ${pathStr || "<root>"}`);
    this.name = "SpecError";
  }
}

export function validateSpec(spec: unknown): WidgetSpec {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new SpecError("spec must be an object", "");
  }
  const s = spec as Partial<WidgetSpec>;
  if (!s.root) throw new SpecError("missing root", "");
  validateNode(s.root, "root");
  if (s.state != null && (typeof s.state !== "object" || Array.isArray(s.state))) {
    throw new SpecError("state must be an object", "state");
  }
  if (s.timers != null) {
    if (!Array.isArray(s.timers)) throw new SpecError("timers must be an array", "timers");
    s.timers.forEach((t, i) => {
      const ctx = `timers[${i}]`;
      if (!t || typeof t !== "object") throw new SpecError("must be an object", ctx);
      if (typeof t.every !== "number" || t.every < 16) {
        throw new SpecError("every must be a number >= 16 (ms)", ctx);
      }
      if (!Array.isArray(t.do)) throw new SpecError("do must be an array of ops", ctx);
    });
  }
  return s as WidgetSpec;
}

function validateNode(node: unknown, path: string): void {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    throw new SpecError("node must be an object", path);
  }
  const n = node as WidgetNode;
  if (!n.type || typeof n.type !== "string") {
    throw new SpecError("node.type is required", path);
  }
  if (!WIDGET_CATALOG.has(n.type)) {
    throw new SpecError(`unknown widget type "${n.type}"`, path);
  }
  if (n.children != null) {
    if (!Array.isArray(n.children)) throw new SpecError("children must be an array", path);
    n.children.forEach((c, i) => validateNode(c, `${path}.children[${i}]`));
  }
}

function escape(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" } as any)[c]);
}

// JSON-in-<script type=application/json> is safe against XSS as long as we
// escape `</script`. There is no JS execution of this payload.
function jsonScriptSafe(s: string): string {
  return s.replace(/<\/(script)/gi, "<\\/$1");
}

export function renderSpecShell(spec: WidgetSpec, opts: { title?: string } = {}): string {
  const title = escape(opts.title || "Surface");
  const specJson = jsonScriptSafe(JSON.stringify(spec));
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; }
  body {
    background: #0a0a0a;
    color: #fff;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    font-size: 14px;
    line-height: 1.4;
    display: flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    padding: 24px;
  }
  #root { width: 100%; max-width: 720px; }
  button { font-family: inherit; }
</style>
</head>
<body>
<div id="root"></div>
<script id="surface-spec" type="application/json">${specJson}</script>
<script src="/lib/surface-widgets.js"></script>
<script>
  (function () {
    try {
      var raw = document.getElementById("surface-spec").textContent;
      window.SurfaceWidgets.mount(JSON.parse(raw));
    } catch (err) { console.error("[widgets mount]", err); }
  })();
</script>
</body>
</html>`;
}
