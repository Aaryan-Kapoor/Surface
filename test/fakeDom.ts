// A DOM small enough to read in one sitting and faithful enough to run
// client/app.js unmodified in Node.
//
// Why this exists: the dashboard is where a device-authored surface title is
// rendered, so "is the title escaped?" can only be answered honestly by
// running the real render path and looking at the tree it produced. The repo
// has no jsdom (and no browser in CI), so this module supplies the pieces
// app.js actually touches: elements with attributes, a text/attribute-correct
// serializer, and — the important part — an innerHTML *parser*, so markup the
// app builds from a template literal turns into real attributes. An injected
// `onmouseover=` therefore shows up as an attribute, exactly as it would in a
// browser, instead of hiding inside an opaque string.
//
// It is deliberately not a spec implementation: no layout, no event dispatch,
// no CSS. Anything app.js reads for geometry answers 0.

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

export function escapeTextValue(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeAttrValue(value: string): string {
  return escapeTextValue(value).replace(/"/g, "&quot;");
}

export function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export class FakeText {
  nodeType = 3;
  parentNode: FakeElement | null = null;
  constructor(public data: string) {}
}

export type FakeNode = FakeElement | FakeText;

interface StyleDecl {
  [key: string]: any;
  setProperty(name: string, value: string): void;
  removeProperty(name: string): void;
  getPropertyValue(name: string): string;
}

function makeStyle(): StyleDecl {
  const props: Record<string, string> = {};
  return {
    _props: props,
    setProperty(name: string, value: string) { props[name] = String(value); },
    removeProperty(name: string) { delete props[name]; },
    getPropertyValue(name: string) { return props[name] ?? ""; },
  } as StyleDecl;
}

// Attributes that browsers reflect as IDL properties. app.js sets several of
// these directly (`img.alt = …`, `input.value = …`); reflecting them keeps the
// serialized tree honest about what the app produced.
const REFLECTED: Record<string, string> = {
  id: "id",
  className: "class",
  title: "title",
  src: "src",
  alt: "alt",
  value: "value",
  content: "content", // <meta content="…">, which applyTheme() writes
  media: "media",
  type: "type",
  loading: "loading",
  decoding: "decoding",
  tabIndex: "tabindex",
  maxLength: "maxlength",
};

export class FakeElement {
  nodeType = 1;
  tagName: string;
  attributes = new Map<string, string>();
  childNodes: FakeNode[] = [];
  parentNode: FakeElement | null = null;
  ownerDocument: FakeDocument | null = null;
  style = makeStyle();
  listeners = new Map<string, Function[]>();
  [key: string]: any;

  constructor(tagName: string, ownerDocument: FakeDocument | null = null) {
    this.tagName = tagName.toLowerCase();
    this.ownerDocument = ownerDocument;
    for (const [prop, attr] of Object.entries(REFLECTED)) {
      Object.defineProperty(this, prop, {
        get: () => this.attributes.get(attr) ?? "",
        set: (v: unknown) => this.setAttribute(attr, v === null || v === undefined ? "" : String(v)),
        configurable: true,
        enumerable: false,
      });
    }
    Object.defineProperty(this, "hidden", {
      get: () => this.attributes.has("hidden"),
      set: (v: unknown) => { if (v) this.setAttribute("hidden", ""); else this.removeAttribute("hidden"); },
      configurable: true,
      enumerable: false,
    });
    Object.defineProperty(this, "dataset", {
      value: new Proxy({} as Record<string, string>, {
        get: (_t, key: string) => this.attributes.get(`data-${camelToDash(key)}`),
        set: (_t, key: string, value: any) => {
          this.setAttribute(`data-${camelToDash(key)}`, String(value));
          return true;
        },
        has: (_t, key: string) => this.attributes.has(`data-${camelToDash(key)}`),
        deleteProperty: (_t, key: string) => { this.removeAttribute(`data-${camelToDash(key)}`); return true; },
      }),
      configurable: true,
    });
  }

  // ── attributes ──

  setAttribute(name: string, value: string): void { this.attributes.set(name.toLowerCase(), String(value)); }
  getAttribute(name: string): string | null { return this.attributes.has(name.toLowerCase()) ? this.attributes.get(name.toLowerCase())! : null; }
  removeAttribute(name: string): void { this.attributes.delete(name.toLowerCase()); }
  hasAttribute(name: string): boolean { return this.attributes.has(name.toLowerCase()); }

  get classList() {
    const read = () => (this.attributes.get("class") || "").split(/\s+/).filter(Boolean);
    const write = (list: string[]) => this.setAttribute("class", list.join(" "));
    return {
      add: (...names: string[]) => { const l = read(); for (const n of names) if (!l.includes(n)) l.push(n); write(l); },
      remove: (...names: string[]) => write(read().filter((c) => !names.includes(c))),
      contains: (name: string) => read().includes(name),
      toggle: (name: string, force?: boolean) => {
        const has = read().includes(name);
        const on = force === undefined ? !has : !!force;
        if (on && !has) write([...read(), name]);
        if (!on && has) write(read().filter((c) => c !== name));
        return on;
      },
    };
  }

  // ── tree ──

  get children(): FakeElement[] { return this.childNodes.filter(isElement); }
  get firstChild(): FakeNode | null { return this.childNodes[0] ?? null; }
  get isConnected(): boolean {
    let node: FakeElement | null = this;
    while (node) {
      if (node.tagName === "html") return true;
      node = node.parentNode;
    }
    return false;
  }

  appendChild<T extends FakeNode | FakeFragment>(node: T): T {
    if (node instanceof FakeFragment) {
      for (const child of [...node.childNodes]) this.appendChild(child);
      node.childNodes = [];
      return node;
    }
    detach(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  append(...nodes: Array<FakeNode | FakeFragment | string>): void {
    for (const node of nodes) {
      if (typeof node === "string") this.appendChild(new FakeText(node));
      else this.appendChild(node);
    }
  }

  prepend(...nodes: Array<FakeNode | string>): void {
    const resolved = nodes.map((n) => (typeof n === "string" ? new FakeText(n) : n));
    for (const node of resolved) detach(node);
    for (const node of resolved) node.parentNode = this;
    this.childNodes.unshift(...resolved);
  }

  insertBefore<T extends FakeNode>(node: T, ref: FakeNode | null): T {
    detach(node);
    node.parentNode = this;
    const idx = ref ? this.childNodes.indexOf(ref) : -1;
    if (idx === -1) this.childNodes.push(node);
    else this.childNodes.splice(idx, 0, node);
    return node;
  }

  removeChild<T extends FakeNode>(node: T): T { detach(node); return node; }

  remove(): void { detach(this); }

  replaceWith(node: FakeNode): void {
    const parent = this.parentNode;
    if (!parent) return;
    const idx = parent.childNodes.indexOf(this);
    detach(node);
    node.parentNode = parent;
    parent.childNodes.splice(idx, 1, node);
    this.parentNode = null;
  }

  replaceChildren(...nodes: Array<FakeNode | string>): void {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }

  contains(node: FakeNode | null): boolean {
    let cur: FakeElement | null = node && (node as FakeNode).parentNode;
    if (node === (this as unknown as FakeNode)) return true;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentNode;
    }
    return false;
  }

  // ── content ──

  get textContent(): string {
    return this.childNodes.map((n) => (isElement(n) ? n.textContent : n.data)).join("");
  }

  set textContent(value: unknown) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    const text = value === null || value === undefined ? "" : String(value);
    if (text !== "") this.appendChild(new FakeText(text));
  }

  get innerHTML(): string { return this.childNodes.map(serializeNode).join(""); }

  set innerHTML(html: unknown) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    const parsed = parseHTML(String(html ?? ""), this.ownerDocument);
    for (const node of parsed) this.appendChild(node);
  }

  get outerHTML(): string { return serializeNode(this); }

  // ── selectors ──

  querySelector(selector: string): FakeElement | null { return this.querySelectorAll(selector)[0] ?? null; }

  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = [];
    for (const group of selector.split(",")) {
      for (const el of matchDescendants(this, group.trim())) if (!out.includes(el)) out.push(el);
    }
    return out;
  }

  closest(selector: string): FakeElement | null {
    let node: FakeElement | null = this;
    while (node) {
      if (matchesCompound(node, selector.trim())) return node;
      node = node.parentNode;
    }
    return null;
  }

  // ── inert stubs (app.js reads these; none of them affect the assertions) ──

  addEventListener(type: string, fn: Function): void {
    const list = this.listeners.get(type) || [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, fn: Function): void {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((f) => f !== fn));
  }
  dispatch(type: string, event: any = {}): void {
    for (const fn of [...(this.listeners.get(type) || [])]) fn.call(this, event);
  }
  focus(): void {}
  blur(): void {}
  select(): void {}
  setSelectionRange(): void {}
  scrollIntoView(): void {}
  setPointerCapture(): void {}
  releasePointerCapture(): void {}
  getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 }; }
  get offsetHeight(): number { return 0; }
  get offsetWidth(): number { return 0; }
  get scrollHeight(): number { return 0; }
  get scrollTop(): number { return 0; }
}

export class FakeFragment extends FakeElement {
  constructor(ownerDocument: FakeDocument | null = null) { super("#fragment", ownerDocument); }
}

function camelToDash(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

function isElement(node: FakeNode): node is FakeElement { return node.nodeType === 1; }

function detach(node: FakeNode): void {
  const parent = node.parentNode;
  if (!parent) return;
  const idx = parent.childNodes.indexOf(node);
  if (idx !== -1) parent.childNodes.splice(idx, 1);
  node.parentNode = null;
}

// ── serialization (browser-equivalent escaping) ──

export function serializeNode(node: FakeNode): string {
  if (!isElement(node)) return escapeTextValue(node.data);
  const attrs = [...node.attributes.entries()]
    .map(([name, value]) => (value === "" ? ` ${name}=""` : ` ${name}="${escapeAttrValue(value)}"`))
    .join("");
  if (node.tagName === "#fragment") return node.childNodes.map(serializeNode).join("");
  if (VOID_TAGS.has(node.tagName)) return `<${node.tagName}${attrs}>`;
  return `<${node.tagName}${attrs}>${node.childNodes.map(serializeNode).join("")}</${node.tagName}>`;
}

// ── the parser ──
//
// Handles exactly the shape of markup app.js produces: well-formed tags,
// quoted or bare attribute values, self-closing SVG children, and text. It is
// intentionally forgiving in the same direction a browser is — an attribute
// that appears after a broken-out quote parses as an attribute, which is the
// whole point of the harness.

export function parseHTML(html: string, doc: FakeDocument | null): FakeNode[] {
  const root = new FakeElement("#root", doc);
  let cursor: FakeElement = root;
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      addText(cursor, html.slice(i));
      break;
    }
    if (lt > i) addText(cursor, html.slice(i, lt));
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html[lt + 1] === "/") {
      const end = html.indexOf(">", lt);
      const name = html.slice(lt + 2, end === -1 ? html.length : end).trim().toLowerCase();
      let node: FakeElement | null = cursor;
      while (node && node !== root && node.tagName !== name) node = node.parentNode;
      if (node && node !== root) cursor = node.parentNode || root;
      i = end === -1 ? html.length : end + 1;
      continue;
    }
    const tagMatch = /^<([A-Za-z][^\s/>]*)/.exec(html.slice(lt));
    if (!tagMatch) {
      addText(cursor, "<");
      i = lt + 1;
      continue;
    }
    const name = tagMatch[1].toLowerCase();
    let j = lt + tagMatch[0].length;
    const el = new FakeElement(name, doc);
    let selfClosing = false;
    while (j < html.length) {
      while (j < html.length && /\s/.test(html[j])) j++;
      if (html[j] === ">") { j++; break; }
      if (html[j] === "/" && html[j + 1] === ">") { selfClosing = true; j += 2; break; }
      const attrMatch = /^([^\s=/>]+)/.exec(html.slice(j));
      if (!attrMatch) { j++; continue; }
      const attrName = attrMatch[1];
      j += attrMatch[0].length;
      while (j < html.length && /\s/.test(html[j])) j++;
      let value = "";
      if (html[j] === "=") {
        j++;
        while (j < html.length && /\s/.test(html[j])) j++;
        const quote = html[j];
        if (quote === '"' || quote === "'") {
          const end = html.indexOf(quote, j + 1);
          value = html.slice(j + 1, end === -1 ? html.length : end);
          j = end === -1 ? html.length : end + 1;
        } else {
          const bare = /^[^\s>]*/.exec(html.slice(j))![0];
          value = bare;
          j += bare.length;
        }
      }
      el.setAttribute(attrName, decodeEntities(value));
    }
    cursor.appendChild(el);
    if (!selfClosing && !VOID_TAGS.has(name)) cursor = el;
    i = j;
  }
  const nodes = [...root.childNodes];
  for (const node of nodes) node.parentNode = null;
  root.childNodes = [];
  return nodes;
}

function addText(parent: FakeElement, raw: string): void {
  if (raw === "") return;
  parent.appendChild(new FakeText(decodeEntities(raw)));
}

// ── selector matching (compound + descendant, which is all app.js uses) ──

function matchesCompound(el: FakeElement, compound: string): boolean {
  if (!compound || compound === "*") return true;
  const tokens = compound.match(/(^[A-Za-z][\w-]*)|(\.[^.#\[\]]+)|(#[^.#\[\]]+)|(\[[^\]]+\])/g);
  if (!tokens) return false;
  for (const token of tokens) {
    if (token.startsWith(".")) {
      if (!el.classList.contains(token.slice(1))) return false;
    } else if (token.startsWith("#")) {
      if (el.getAttribute("id") !== token.slice(1)) return false;
    } else if (token.startsWith("[")) {
      const m = /^\[([^\]=~|^$*]+)(?:([~|^$*]?=)"?([^"\]]*)"?)?\]$/.exec(token);
      if (!m) return false;
      const value = el.getAttribute(m[1]);
      if (value === null) return false;
      if (m[2] && value !== m[3]) return false;
    } else if (el.tagName !== token.toLowerCase()) {
      return false;
    }
  }
  return true;
}

function matchDescendants(root: FakeElement, selector: string): FakeElement[] {
  const parts = selector.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return [];
  let candidates = descendantsOf(root);
  for (let depth = 0; depth < parts.length; depth++) {
    const part = parts[depth];
    const matched = candidates.filter((el) => matchesCompound(el, part));
    if (depth === parts.length - 1) return matched;
    candidates = matched.flatMap(descendantsOf);
  }
  return [];
}

function descendantsOf(el: FakeElement): FakeElement[] {
  const out: FakeElement[] = [];
  const walk = (node: FakeElement) => {
    for (const child of node.childNodes) {
      if (!isElement(child)) continue;
      out.push(child);
      walk(child);
    }
  };
  walk(el);
  return out;
}

// ── document ──

export class FakeDocument {
  documentElement: FakeElement;
  head: FakeElement;
  body: FakeElement;
  activeElement: FakeElement | null = null;
  listeners = new Map<string, Function[]>();

  constructor() {
    this.documentElement = new FakeElement("html", this);
    this.head = new FakeElement("head", this);
    this.body = new FakeElement("body", this);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
  }

  createElement(tag: string): FakeElement { return new FakeElement(tag, this); }
  createDocumentFragment(): FakeFragment { return new FakeFragment(this); }
  createTextNode(text: string): FakeText { return new FakeText(text); }
  getElementById(id: string): FakeElement | null { return this.documentElement.querySelector(`#${id}`); }
  querySelector(selector: string): FakeElement | null { return this.documentElement.querySelector(selector); }
  querySelectorAll(selector: string): FakeElement[] { return this.documentElement.querySelectorAll(selector); }
  addEventListener(type: string, fn: Function): void {
    this.listeners.set(type, [...(this.listeners.get(type) || []), fn]);
  }
  removeEventListener(type: string, fn: Function): void {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((f) => f !== fn));
  }
  execCommand(): boolean { return false; }
}

/** Every attribute in the tree, as `[element, name, value]` triples. */
export function allAttributes(root: FakeElement): Array<{ el: FakeElement; name: string; value: string }> {
  const out: Array<{ el: FakeElement; name: string; value: string }> = [];
  const walk = (node: FakeElement) => {
    for (const [name, value] of node.attributes) out.push({ el: node, name, value });
    for (const child of node.childNodes) if (isElement(child)) walk(child);
  };
  walk(root);
  return out;
}
