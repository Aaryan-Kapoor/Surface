// Surface Widgets runtime — renders a declarative spec into real DOM inside
// a surface iframe. The spec is a trusted JSON document; agents can't inject
// arbitrary script, only compose primitives from this runtime's catalog.
//
// Contract with the bootloader:
//   - The shell HTML served for kind=widgets surfaces mounts an empty
//     <div id=root> and inlines the spec as a <script type=application/json>.
//   - This runtime exposes window.SurfaceWidgets.mount(spec) / applySpec(spec).
//   - Updates arrive on the bootloader's `surface/spec` channel: the runtime
//     diff-applies state + spec without remounting the DOM, preserving node
//     identity for inputs / canvas / focus just like the HTML morph path.
//
// The component catalog is intentionally small. It's meant to cover the 80%
// of surfaces that are really "a list, a form, a button, a progress meter" —
// everything more exotic stays on the HTML tier.

(function () {
  "use strict";
  if (window.SurfaceWidgets) return;

  // ── State path utils ──────────────────────────────────────────────────────
  function splitPath(p) {
    return String(p).replace(/^\$\.?/, "").split(".").filter(Boolean);
  }
  function readPath(obj, path) {
    const parts = splitPath(path);
    let cur = obj;
    for (const k of parts) {
      if (cur == null) return undefined;
      cur = cur[k];
    }
    return cur;
  }
  function writePath(obj, path, value) {
    const parts = splitPath(path);
    if (parts.length === 0) return;
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i];
      if (cur[k] == null || typeof cur[k] !== "object") cur[k] = {};
      cur = cur[k];
    }
    cur[parts[parts.length - 1]] = value;
  }

  // ── Binding resolution ────────────────────────────────────────────────────
  // A string like "$counter" or "$.user.name" resolves against state.
  // Non-string values pass through unchanged. To escape a literal starting
  // with $, write "$$".
  function resolveValue(v, state) {
    if (typeof v !== "string") return v;
    if (v.startsWith("$$")) return v.slice(1);
    if (v.startsWith("$")) return readPath(state, v);
    return v;
  }
  function resolveProps(props, state) {
    if (!props || typeof props !== "object") return {};
    const out = {};
    for (const k of Object.keys(props)) out[k] = resolveValue(props[k], state);
    return out;
  }

  // ── Ops (declarative state mutations) ─────────────────────────────────────
  // Each op is { op: <name>, ... }. Scripts are never executed — the spec
  // composes primitives only.
  function applyOps(ops, state, ctx) {
    if (!Array.isArray(ops)) return false;
    let dirty = false;
    for (const raw of ops) {
      const op = { ...raw };
      // Resolve any bindings in op arguments (but not in `path`).
      if ("value" in op) op.value = resolveValue(op.value, state);
      switch (op.op) {
        case "set":
          writePath(state, op.path, op.value);
          dirty = true;
          break;
        case "inc": {
          const cur = Number(readPath(state, op.path) || 0);
          const next = cur + (Number(op.by) || 1);
          const clamped =
            op.min != null ? Math.max(Number(op.min), next) :
            op.max != null ? Math.min(Number(op.max), next) : next;
          writePath(state, op.path, clamped);
          dirty = true;
          break;
        }
        case "dec": {
          const cur = Number(readPath(state, op.path) || 0);
          const next = cur - (Number(op.by) || 1);
          const clamped = op.min != null ? Math.max(Number(op.min), next) : next;
          writePath(state, op.path, clamped);
          dirty = true;
          break;
        }
        case "toggle":
          writePath(state, op.path, !readPath(state, op.path));
          dirty = true;
          break;
        case "push": {
          const arr = readPath(state, op.path);
          if (Array.isArray(arr)) { arr.push(op.value); dirty = true; }
          else { writePath(state, op.path, [op.value]); dirty = true; }
          break;
        }
        case "remove": {
          const arr = readPath(state, op.path);
          if (Array.isArray(arr)) {
            const idx = typeof op.index === "number" ? op.index : arr.indexOf(op.value);
            if (idx >= 0) { arr.splice(idx, 1); dirty = true; }
          }
          break;
        }
        case "post": {
          // Route a user-facing action back to the agent via the same
          // surface_action channel HTML surfaces use.
          if (window.parent && window.parent !== window) {
            window.parent.postMessage({
              type: "surface_action",
              action: op.action || "widget_action",
              data: op.data != null ? resolveValue(op.data, state) : {},
            }, "*");
          }
          break;
        }
        default:
          // Unknown ops are ignored rather than thrown — keeps forward-compat
          // when an older client meets a newer spec.
          break;
      }
    }
    return dirty;
  }

  // ── Component catalog ─────────────────────────────────────────────────────
  //
  // Each component: { render(props, children, ctx) => HTMLElement } where
  // `children` is already an array of rendered DOM nodes. The catalog is
  // small; everything else should be composable from these.

  const CATALOG = {
    Stack(props, children) {
      const el = document.createElement("div");
      const dir = props.direction === "horizontal" ? "row" : "column";
      el.style.cssText =
        `display:flex;flex-direction:${dir};` +
        `gap:${num(props.gap, 12)}px;` +
        `align-items:${mapAlign(props.align)};` +
        `justify-content:${mapJustify(props.justify)};` +
        `padding:${num(props.padding, 0)}px;`;
      if (props.style) el.style.cssText += ";" + props.style;
      children.forEach((c) => el.appendChild(c));
      return el;
    },
    Card(props, children) {
      const el = document.createElement("div");
      el.style.cssText =
        "background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);" +
        `border-radius:${num(props.radius, 16)}px;` +
        `padding:${num(props.padding, 20)}px;` +
        "color:inherit;";
      if (props.style) el.style.cssText += ";" + props.style;
      children.forEach((c) => el.appendChild(c));
      return el;
    },
    Text(props) {
      const tag = props.as || "div";
      const el = document.createElement(tag);
      el.textContent = props.value == null ? "" : String(props.value);
      el.style.cssText =
        `font-size:${fontSize(props.size)};` +
        `font-weight:${fontWeight(props.weight)};` +
        `color:${props.muted ? "rgba(255,255,255,0.5)" : props.color || "inherit"};` +
        `letter-spacing:${props.tracking || "normal"};` +
        `text-align:${props.align || "left"};`;
      if (props.style) el.style.cssText += ";" + props.style;
      return el;
    },
    Button(props, _children, ctx) {
      const el = document.createElement("button");
      el.textContent = props.label || "";
      el.disabled = !!props.disabled;
      const variant = props.variant || "solid";
      el.style.cssText =
        "font-family:inherit;font-size:14px;cursor:pointer;" +
        "padding:10px 18px;border-radius:10px;transition:all 0.15s;" +
        (variant === "ghost"
          ? "background:transparent;border:1px solid rgba(255,255,255,0.12);color:inherit;"
          : variant === "accent"
          ? `background:${props.color || "#ff6b6b"};border:none;color:#fff;`
          : "background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);color:inherit;");
      if (props.style) el.style.cssText += ";" + props.style;
      el.addEventListener("click", () => {
        const handled = applyOps(props.onClick || props.on_click, ctx.state, ctx);
        if (handled) ctx.rerender();
      });
      return el;
    },
    Input(props, _children, ctx) {
      const el = document.createElement("input");
      el.type = props.type || "text";
      if (props.placeholder) el.placeholder = props.placeholder;
      const v = props.value == null ? "" : String(props.value);
      // Only overwrite .value if the element isn't focused — otherwise the
      // user's active typing gets clobbered every re-render.
      if (document.activeElement !== el) el.value = v;
      el.style.cssText =
        "font-family:inherit;font-size:14px;padding:10px 14px;" +
        "background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.12);" +
        "border-radius:10px;color:inherit;outline:none;";
      if (props.style) el.style.cssText += ";" + props.style;
      const bindTo = props.bind;
      if (bindTo) {
        el.addEventListener("input", () => {
          writePath(ctx.state, bindTo, el.value);
          ctx.rerender();
        });
      }
      if (props.onSubmit || props.on_submit) {
        el.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            const handled = applyOps(props.onSubmit || props.on_submit, ctx.state, ctx);
            if (handled) ctx.rerender();
          }
        });
      }
      return el;
    },
    Checkbox(props, _children, ctx) {
      const wrap = document.createElement("label");
      wrap.style.cssText = "display:inline-flex;align-items:center;gap:8px;cursor:pointer;";
      const el = document.createElement("input");
      el.type = "checkbox";
      el.checked = !!props.value;
      const bindTo = props.bind;
      if (bindTo) {
        el.addEventListener("change", () => {
          writePath(ctx.state, bindTo, el.checked);
          ctx.rerender();
        });
      }
      wrap.appendChild(el);
      if (props.label) {
        const span = document.createElement("span");
        span.textContent = props.label;
        wrap.appendChild(span);
      }
      return wrap;
    },
    Image(props) {
      const el = document.createElement("img");
      if (props.src) el.src = props.src;
      if (props.alt) el.alt = props.alt;
      el.style.cssText =
        `width:${props.width ? props.width + "px" : "auto"};` +
        `height:${props.height ? props.height + "px" : "auto"};` +
        `max-width:100%;object-fit:${props.fit || "cover"};` +
        `border-radius:${num(props.radius, 0)}px;`;
      return el;
    },
    ProgressBar(props) {
      const el = document.createElement("div");
      const value = num(props.value, 0);
      const max = num(props.max, 100);
      const pct = Math.max(0, Math.min(100, (value / (max || 1)) * 100));
      el.style.cssText =
        `height:${num(props.thickness, 8)}px;width:100%;` +
        "background:rgba(255,255,255,0.08);border-radius:999px;overflow:hidden;";
      const fill = document.createElement("div");
      fill.style.cssText =
        `width:${pct}%;height:100%;` +
        `background:${props.color || "#ff6b6b"};transition:width 0.3s ease;`;
      el.appendChild(fill);
      return el;
    },
    ProgressRing(props) {
      const size = num(props.size, 220);
      const stroke = num(props.thickness, 6);
      const value = num(props.value, 0);
      const max = num(props.max, 100);
      const pct = Math.max(0, Math.min(1, value / (max || 1)));
      const r = size / 2 - stroke;
      const C = 2 * Math.PI * r;
      const wrap = document.createElement("div");
      wrap.style.cssText = `position:relative;width:${size}px;height:${size}px;`;
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
      svg.style.cssText = "width:100%;height:100%;transform:rotate(-90deg);";
      const bg = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      bg.setAttribute("cx", String(size / 2));
      bg.setAttribute("cy", String(size / 2));
      bg.setAttribute("r", String(r));
      bg.setAttribute("fill", "none");
      bg.setAttribute("stroke", "rgba(255,255,255,0.08)");
      bg.setAttribute("stroke-width", String(stroke));
      const fg = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      fg.setAttribute("cx", String(size / 2));
      fg.setAttribute("cy", String(size / 2));
      fg.setAttribute("r", String(r));
      fg.setAttribute("fill", "none");
      fg.setAttribute("stroke", props.color || "#ff6b6b");
      fg.setAttribute("stroke-width", String(stroke));
      fg.setAttribute("stroke-linecap", "round");
      fg.setAttribute("stroke-dasharray", String(C));
      fg.setAttribute("stroke-dashoffset", String(C * (1 - pct)));
      fg.setAttribute("style", "transition: stroke-dashoffset 0.3s ease;");
      svg.appendChild(bg);
      svg.appendChild(fg);
      wrap.appendChild(svg);
      if (props.label) {
        const label = document.createElement("div");
        label.style.cssText =
          "position:absolute;inset:0;display:flex;align-items:center;" +
          "justify-content:center;font-size:44px;font-weight:200;letter-spacing:2px;";
        label.textContent = String(props.label);
        wrap.appendChild(label);
      }
      return wrap;
    },
    List(props, _children, ctx) {
      const el = document.createElement("div");
      el.style.cssText = "display:flex;flex-direction:column;gap:" + num(props.gap, 8) + "px;";
      const items = Array.isArray(props.items) ? props.items : [];
      const template = props.item || { type: "Text", value: "$." };
      items.forEach((item, i) => {
        // Create a sub-context so bindings inside the template resolve
        // against the item via "$item.*" and still see top-level state.
        const subState = Object.assign(Object.create(ctx.state), { item, index: i });
        const sub = {
          ...ctx,
          state: subState,
          rerender: ctx.rerender,
        };
        const node = renderNode(template, sub);
        if (node) el.appendChild(node);
      });
      return el;
    },
    Spacer(props) {
      const el = document.createElement("div");
      const size = num(props.size, 12);
      el.style.cssText = `flex:${props.grow ? "1 1 auto" : "0 0 " + size + "px"};` +
        `width:${size}px;height:${size}px;`;
      return el;
    },
    Box(props, children) {
      const el = document.createElement("div");
      if (props.style) el.style.cssText = props.style;
      if (props.class) el.className = props.class;
      children.forEach((c) => el.appendChild(c));
      return el;
    },
  };

  // ── Helpers ──────────────────────────────────────────────────────────────
  function num(v, d) {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  }
  function mapAlign(a) {
    return ({ start: "flex-start", end: "flex-end", center: "center", stretch: "stretch" }[a]) || "stretch";
  }
  function mapJustify(a) {
    return (
      { start: "flex-start", end: "flex-end", center: "center",
        between: "space-between", around: "space-around", evenly: "space-evenly" }[a]
    ) || "flex-start";
  }
  function fontSize(s) {
    return ({ xs: "11px", sm: "13px", md: "16px", lg: "20px", xl: "28px", "2xl": "40px", "3xl": "56px" }[s]) ||
      (typeof s === "number" ? s + "px" : s || "inherit");
  }
  function fontWeight(w) {
    return typeof w === "number" ? w : ({ thin: 200, regular: 400, medium: 500, bold: 700 }[w] || "inherit");
  }

  // ── Render core ───────────────────────────────────────────────────────────
  function renderNode(node, ctx) {
    if (node == null) return null;
    if (typeof node === "string" || typeof node === "number") {
      const t = document.createTextNode(String(node));
      return t;
    }
    if (typeof node !== "object" || !node.type) return null;
    if (node.when != null) {
      const visible = !!resolveValue(node.when, ctx.state);
      if (!visible) return null;
    }
    const Comp = CATALOG[node.type];
    if (!Comp) {
      const warn = document.createElement("div");
      warn.style.cssText = "color:#ff6b6b;font-family:monospace;padding:8px;" +
        "border:1px dashed rgba(255,107,107,0.5);border-radius:6px;font-size:12px;";
      warn.textContent = `Unknown widget: ${node.type}`;
      return warn;
    }
    const resolved = resolveProps(node.props || node, ctx.state);
    // Don't leak internal meta into component props:
    delete resolved.type; delete resolved.children; delete resolved.when;
    const children = Array.isArray(node.children) ? node.children : [];
    const renderedChildren = children.map((c) => renderNode(c, ctx)).filter(Boolean);
    return Comp(resolved, renderedChildren, ctx);
  }

  // ── Mount / update loop ───────────────────────────────────────────────────
  const timers = [];

  function clearTimers() {
    while (timers.length) clearInterval(timers.pop());
  }

  function installTimers(spec, ctx) {
    clearTimers();
    const list = Array.isArray(spec.timers) ? spec.timers : [];
    for (const t of list) {
      const every = Number(t.every) || 0;
      if (every < 16) continue; // avoid runaways
      const id = setInterval(() => {
        if (t.while && !readPath(ctx.state, t.while)) return;
        const dirty = applyOps(t.do, ctx.state, ctx);
        if (dirty) ctx.rerender();
      }, every);
      timers.push(id);
    }
  }

  let mounted = null;

  function rerender() {
    if (!mounted) return;
    const { root, spec, state } = mounted;
    const ctx = { state, spec, rerender };
    const node = renderNode(spec.root, ctx) || document.createElement("div");
    // Simple re-render: swap children. The bootloader-level morph kicks in
    // for cross-update identity; within a single widgets session we keep it
    // simple and rebuild the tree on state change.
    root.innerHTML = "";
    root.appendChild(node);
  }

  function mount(spec, opts) {
    const rootId = (opts && opts.rootId) || "root";
    const root = document.getElementById(rootId) || document.body;
    const state = spec.state && typeof spec.state === "object"
      ? JSON.parse(JSON.stringify(spec.state))
      : {};
    mounted = { root, spec, state };
    const ctx = { state, spec, rerender };
    installTimers(spec, ctx);
    rerender();
    return mounted;
  }

  function applySpec(spec) {
    if (!mounted) return mount(spec);
    mounted.spec = spec;
    // Only seed state keys that don't exist yet — preserves running values
    // like a mid-countdown timer across agent-pushed spec updates.
    if (spec.state && typeof spec.state === "object") {
      for (const k of Object.keys(spec.state)) {
        if (!(k in mounted.state)) mounted.state[k] = spec.state[k];
      }
    }
    installTimers(spec, { state: mounted.state, spec, rerender });
    rerender();
    return mounted;
  }

  // Listen for spec updates from the parent (mirrors the morph/edits channels).
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || typeof d !== "object" || d.type !== "surface/spec") return;
    try { applySpec(d.spec); } catch (err) { console.error("[widgets applySpec]", err); }
  });

  window.SurfaceWidgets = {
    mount,
    applySpec,
    // Exposed for tests.
    _internals: { renderNode, applyOps, readPath, writePath, resolveValue, CATALOG },
  };
})();
