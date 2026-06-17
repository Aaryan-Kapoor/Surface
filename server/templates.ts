import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getDataDir } from "./paths.js";
import { renderMarkdown } from "./markdown.js";
import type { ArtifactInputFile } from "./artifacts.js";
import { inferMime } from "./artifacts.js";

// Template engine (docs/templates/overview.md). A template is a directory:
//   <name>/template.json   the contract: params, state vars, actions emitted
//   <name>/index.html      markup with {{param}} slots and data-surface-bind hooks
//   <name>/assets/         optional css/js/img, copied into the instantiated artifact
//
// Resolution order: project .surface/templates → ~/.surface/templates →
// built-in templates/ in the repo. First match wins.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILTIN_DIR = path.resolve(__dirname, "..", "templates");

export type TemplateParamType = "string" | "number" | "boolean" | "markdown" | "url" | "list";

export interface TemplateParamSpec {
  type: TemplateParamType;
  required?: boolean;
  default?: unknown;
  description?: string;
}

export interface TemplateContract {
  name: string;
  description?: string;
  params?: Record<string, TemplateParamSpec>;
  state?: Record<string, { type?: string; default?: unknown } | string>;
  actions?: string[];
}

export type TemplateSource = "project" | "user" | "built-in";

export interface ResolvedTemplate {
  name: string;
  source: TemplateSource;
  dir: string;
  contract: TemplateContract;
  html: string;
}

function userTemplatesDir(): string {
  return path.join(getDataDir(), "templates");
}

function candidateDirs(projectRoot?: string): Array<{ source: TemplateSource; dir: string }> {
  const dirs: Array<{ source: TemplateSource; dir: string }> = [];
  if (projectRoot) dirs.push({ source: "project", dir: path.join(projectRoot, ".surface", "templates") });
  dirs.push({ source: "user", dir: userTemplatesDir() });
  dirs.push({ source: "built-in", dir: BUILTIN_DIR });
  return dirs;
}

function loadFrom(source: TemplateSource, base: string, name: string): ResolvedTemplate | null {
  // Template names are directory names — never path fragments.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return null;
  const dir = path.join(base, name);
  const contractPath = path.join(dir, "template.json");
  const htmlPath = path.join(dir, "index.html");
  if (!fs.existsSync(contractPath) || !fs.existsSync(htmlPath)) return null;
  let contract: TemplateContract;
  try {
    contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
  } catch (err: any) {
    throw new Error(`Template ${name} has invalid template.json: ${err.message}`);
  }
  return {
    name,
    source,
    dir,
    contract: { ...contract, name },
    html: fs.readFileSync(htmlPath, "utf8"),
  };
}

export function resolveTemplate(name: string, projectRoot?: string): ResolvedTemplate {
  for (const { source, dir } of candidateDirs(projectRoot)) {
    const found = loadFrom(source, dir, name);
    if (found) return found;
  }
  throw new Error(`Unknown template: ${name}`);
}

export function listTemplates(projectRoot?: string): Array<{ name: string; source: TemplateSource; description: string }> {
  const seen = new Map<string, { name: string; source: TemplateSource; description: string }>();
  for (const { source, dir } of candidateDirs(projectRoot)) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || seen.has(entry.name)) continue;
      try {
        const tpl = loadFrom(source, dir, entry.name);
        if (tpl) seen.set(entry.name, { name: entry.name, source, description: tpl.contract.description || "" });
      } catch {
        seen.set(entry.name, { name: entry.name, source, description: "(invalid template.json)" });
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function coerceParam(name: string, spec: TemplateParamSpec, raw: unknown): unknown {
  if (raw === undefined || raw === null || raw === "") {
    if (spec.required) throw new Error(`Template param "${name}" is required`);
    return spec.default;
  }
  switch (spec.type) {
    case "number": {
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(n)) throw new Error(`Template param "${name}" must be a number`);
      return n;
    }
    case "boolean":
      if (typeof raw === "boolean") return raw;
      return !["0", "false", "no", "off", ""].includes(String(raw).toLowerCase());
    case "url": {
      const s = String(raw);
      try {
        const u = new URL(s);
        if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("non-http");
      } catch {
        throw new Error(`Template param "${name}" must be an http(s) URL`);
      }
      return s;
    }
    case "list":
      if (Array.isArray(raw)) return raw.map(String);
      return String(raw).split(",").map((s) => s.trim()).filter(Boolean);
    case "markdown":
    case "string":
    default:
      return Array.isArray(raw) || typeof raw === "object" ? raw : String(raw);
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] as string
  ));
}

function displayString(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export interface RenderedTemplate {
  html: string;
  // Validated/coerced params — what the instance was actually rendered with.
  params: Record<string, unknown>;
  stateDefaults: Record<string, unknown>;
}

// Interpolate the template: {{{param}}} raw, {{param}} HTML-escaped, markdown
// params pre-rendered to HTML. The full validated param object is also
// injected as window.__TEMPLATE_PARAMS so template JS gets typed values
// (arrays, booleans) without parsing the markup.
export function renderTemplate(
  tpl: ResolvedTemplate,
  rawParams: Record<string, unknown>,
  implicit: Record<string, unknown> = {},
): RenderedTemplate {
  const specs = tpl.contract.params || {};
  const params: Record<string, unknown> = { ...implicit };
  for (const [name, spec] of Object.entries(specs)) {
    params[name] = coerceParam(name, spec, rawParams[name] ?? implicit[name]);
  }
  // Unknown extra params pass through untyped (schema-less keys stay cheap).
  for (const [name, value] of Object.entries(rawParams)) {
    if (!(name in params)) params[name] = value;
  }

  const rendered: Record<string, unknown> = { ...params };
  for (const [name, spec] of Object.entries(specs)) {
    if (spec.type === "markdown") {
      rendered[name] = renderMarkdown(String(params[name] ?? ""));
    }
  }

  let html = tpl.html;
  html = html.replace(/\{\{\{(\s*[\w.]+\s*)\}\}\}/g, (_, key) => displayString(rendered[key.trim()]));
  html = html.replace(/\{\{(\s*[\w.]+\s*)\}\}/g, (_, key) => escapeHtml(displayString(rendered[key.trim()])));

  const paramsScript = `<script>window.__TEMPLATE_PARAMS = ${JSON.stringify(params).replace(/</g, "\\u003c")};</script>`;
  const headIdx = html.toLowerCase().indexOf("<head>");
  html = headIdx !== -1
    ? `${html.slice(0, headIdx + 6)}\n${paramsScript}${html.slice(headIdx + 6)}`
    : `${paramsScript}\n${html}`;

  const stateDefaults: Record<string, unknown> = {};
  for (const [key, decl] of Object.entries(tpl.contract.state || {})) {
    if (typeof decl === "object" && decl !== null && "default" in decl && decl.default !== undefined) {
      stateDefaults[key] = decl.default;
    }
  }

  return { html, params, stateDefaults };
}

// All files under <template>/assets/, as artifact input files keeping their
// assets/… relative paths so the instantiated markup can reference them.
export function templateAssetFiles(tpl: ResolvedTemplate): ArtifactInputFile[] {
  const assetsDir = path.join(tpl.dir, "assets");
  if (!fs.existsSync(assetsDir)) return [];
  const files: ArtifactInputFile[] = [];
  const walk = (dir: string, rel: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, relPath);
      else if (entry.isFile()) {
        files.push({ path: `assets/${relPath}`, content: fs.readFileSync(abs), mime: inferMime(abs) });
      }
    }
  };
  walk(assetsDir, "");
  return files;
}
