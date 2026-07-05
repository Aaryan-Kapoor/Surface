import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildHostedPairingUrl, buildPairingUrl, renderTerminalQrCode } from "../server/startupAccess.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE = (process.env.SURFACE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
// Loopback callers need no credential. A remote agent (SSH box, container)
// carries a system bearer minted from the system plane:
//   surface auth session issue --role system --label devbox
const TOKEN = process.env.SURFACE_SESSION || "";

const HELP = `surface — universal display CLI

Usage:
  surface <command> [args] [options]

Commands:
  list                       List surface cards (--project <root> --agent <label> filters)
  read <id>                  Read artifact (metadata + version + files)
  create <title>             Create workspace artifact
  update <id>                Update workspace artifact (new version)
  link <abs-path>            Register linked artifact (file or directory)
  touch <id>                 Broadcast reload for linked artifact
  present <abs-path>         One-shot file presentation (copy)
  set <id> <key> <value>     Set one state key (dotted paths ok, value parsed as JSON)
  patch <id> <json|->        Deep-merge a JSON patch into surface state
  state <id>                 Read surface state
  ask <question>             Context-full question on every display (--wait blocks for the answer)
  append <id> [text|-]       Append to a stream surface (pipe with -)
  video <url>                Embed a YouTube/web video (one line)
  doc <path>                 Render a repo markdown file, hot-reloading
  template [list|show|create] Manage templates (create --from promotes a surface)
  init                       Scaffold .surface/ + SURFACE.md in the current project
  sync                       Reconcile .surface/ manifests with the running service
  bind <id>                  Register a command/webhook to fire on actions (wake-me binding)
  bindings [<id>]            List bindings (status, last run)
  unbind <binding-id>        Remove a binding
  versions <id>              List artifact versions
  rollback <id> <version>    Restore artifact version
  delete <id>                Delete artifact
  open [<id>]                Navigate display to artifact, or grid if omitted
  exec <id>                  Run JS in surface iframe
  actions [<id>]             List pending user actions
  ack <action-id>            Acknowledge action
  reply <id> <text>          Send toast to surface
  notify <text>              Display ephemeral notification
  theme [<json>|-|reset]     Get / set / reset display theme
  slot [<role> <id>|--clear] Show or assign display slots (renderer|home|overlay)
  status                     Get display state
  stream [--id <id>]         Tail SSE events as JSONL until interrupted
  wait [--id <id>]           Block until a matching surface action, then exit 0
                             (--follow: never exit; print one JSON line per action)
  pair                       Create a one-time pairing URL for a new device
  devices [revoke <name>]    List paired displays / revoke one by name
  auth <pairing|session> ... Manage pairing tokens and durable sessions
  seed-demos                 Link every example demo as a tutorial surface (idempotent)
  clear-demos                Hide every surface tagged metadata.demo === true (seed-demos revives them)

Run "surface <command> --help" for command-specific options.

Environment:
  SURFACE_URL      base URL (default: http://127.0.0.1:3000)
  SURFACE_SESSION  session bearer for non-loopback access
                   (mint with: surface auth session issue --role system)
`;

type FlagKind = "string" | "boolean" | "number" | "duration" | "multi";
type FlagSpecs = Record<string, FlagKind>;
interface CommandContext {
  cmd: string;
  positional: string[];
  flags: Record<string, string | boolean>;
  multi: Record<string, string[]>;
}
interface CommandSpec {
  help: string;
  flags: FlagSpecs;
  run: (ctx: CommandContext) => Promise<void>;
}

const STR = "string";
const BOOL = "boolean";
const NUM = "number";
const DUR = "duration";
const MULTI = "multi";
const command = (help: string, flags: FlagSpecs = {}): CommandSpec => ({ help, flags, run: runCommand });

const COMMANDS: Record<string, CommandSpec> = {
  list: command("surface list [--project <root>] [--agent <label>] [--include-hidden]", { project: STR, agent: STR, "include-hidden": BOOL }),
  read: command("surface read <id>"),
  create: command("surface create <title> [--mime <type>] [--file <path>|--content <s>|--content -] [--template <name> --param k=v ...] [--id <id>] [--agent <label>] [--metadata <json>]", { mime: STR, file: STR, content: STR, template: STR, param: MULTI, id: STR, agent: STR, metadata: STR }),
  update: command("surface update <id> [--title <t>] [--mime <type>] [--file <path>|--content <s>|--content -] [--metadata <json>]", { title: STR, mime: STR, file: STR, content: STR, metadata: STR }),
  link: command("surface link <abs-path> [--entry <relpath>] [--title <t>] [--agent <label>] [--metadata <json>] [--no-open]", { entry: STR, title: STR, agent: STR, metadata: STR, "no-open": BOOL }),
  touch: command("surface touch <id>"),
  present: command("surface present <abs-path> [--title <t>] [--agent <label>] [--metadata <json>]", { title: STR, agent: STR, metadata: STR }),
  set: command("surface set <id> <dotted.key> <value>   (value parsed as JSON, falls back to string; null deletes)"),
  patch: command("surface patch <id> <json|->"),
  state: command("surface state <id>"),
  ask: command("surface ask <question> [--options a,b,c] [--freetext] [--context -|<md>] [--context-file <p>] [--wait] [--timeout <s>] [--on <device>] [--id <id>] [--agent <l>] [--title <t>]", { options: STR, freetext: BOOL, context: STR, "context-file": STR, wait: BOOL, timeout: NUM, on: STR, id: STR, agent: STR, title: STR }),
  append: command("surface append <id> [<text>|-] [--md]   (- pipes stdin line by line)", { md: BOOL }),
  video: command("surface video <url> [--title <t>] [--start <s>] [--autoplay] [--loop] [--id <id>] [--agent <l>]", { title: STR, start: NUM, autoplay: BOOL, loop: BOOL, id: STR, agent: STR }),
  doc: command("surface doc <path> [--title <t>] [--toc] [--width narrow|default|wide] [--agent <l>] [--no-open]", { title: STR, toc: BOOL, width: STR, agent: STR, "no-open": BOOL }),
  template: command([
    "surface template list [--json]",
    "surface template show <name>",
    "surface template create <name> --from <artifact-id> [--user]   (--user -> ~/.surface/templates, else <project>/.surface/templates)",
  ].join("\n"), { json: BOOL, from: STR, user: BOOL }),
  bind: command("surface bind <id> [--action <name|a|b|*>] (--run '<command>' | --webhook <url>) [--cwd <dir>] [--timeout <s>]   (command is argv-tokenized, never shelled; the action batch arrives on stdin as JSON)", { action: STR, run: STR, webhook: STR, cwd: STR, timeout: NUM }),
  bindings: command("surface bindings [<id>] [--json]", { json: BOOL }),
  unbind: command("surface unbind <binding-id>"),
  init: command("surface init   (scaffolds .surface/{config.json,surfaces/,templates/} and SURFACE.md at the project root)"),
  sync: command([
    "surface sync                 reconcile every .surface/surfaces/*.json manifest (create missing, re-render drifted)",
    "surface sync --export <id>   write a manifest for an existing surface into .surface/surfaces/",
  ].join("\n"), { export: STR, agent: STR }),
  versions: command("surface versions <id>"),
  rollback: command("surface rollback <id> <version>"),
  delete: command("surface delete <id>"),
  open: command("surface open [<id>] [--on <device>]", { on: STR }),
  exec: command("surface exec <id> [--js <code>|--file <path>|--js -]   (best effort: only live same-origin iframes can execute JS)", { js: STR, file: STR }),
  actions: command("surface actions [<id>]"),
  ack: command("surface ack <action-id>"),
  reply: command("surface reply <id> <text>"),
  notify: command("surface notify <text> [--style info|success|warning|error] [--duration <ms>] [--on <device>]", { style: STR, duration: NUM, on: STR }),
  theme: command("surface theme [<json>|-|reset]"),
  slot: command([
    "surface slot                          show current slot assignments",
    "surface slot <renderer|home|overlay> <artifact-id>   make that artifact the slot",
    "surface slot <renderer|home|overlay> --clear         vacate the slot",
  ].join("\n"), { clear: BOOL }),
  status: command("surface status"),
  stream: command("surface stream [--id <surface-id>] [--timeout <seconds>]", { id: STR, timeout: NUM }),
  wait: command("surface wait [--id <surface-id>] [--action <name>] [--event <name>] [--timeout <seconds>] [--no-ack] [--follow] [--heartbeat <seconds>]   (--follow keeps listening forever: one compact JSON line per action, acked as delivered; --timeout becomes a lifetime cap)", { id: STR, action: STR, event: STR, timeout: NUM, "no-ack": BOOL, follow: BOOL, heartbeat: NUM }),
  pair: command("surface pair [--name <device-name>] [--base-url <url>] [--hosted-url <url>] [--ttl 5m] [--json] [--no-qr]", { name: STR, label: STR, "base-url": STR, "hosted-url": STR, ttl: DUR, json: BOOL, "no-qr": BOOL }),
  devices: command("surface devices [revoke <name-or-id>]", { json: BOOL }),
  auth: command([
    "surface auth pairing create [--ttl 5m] [--label <l>] [--base-url <url>]",
    "surface auth pairing list",
    "surface auth pairing revoke <id>",
    "surface auth session issue [--role system|device] [--ttl 30d] [--label <l>]",
    "surface auth session list",
    "surface auth session revoke <id>",
  ].join("\n"), { ttl: DUR, label: STR, "base-url": STR, role: STR }),
  "seed-demos": command("surface seed-demos"),
  "clear-demos": command("surface clear-demos"),
};

const CMD_HELP: Record<string, string> = Object.fromEntries(
  Object.entries(COMMANDS).map(([name, spec]) => [name, spec.help]),
);

// Hand-mapped titles for the bundled example demos. Filenames are derived from
// the file basename; everything else is the same human label the empty-state
// gallery uses, so the same prompts the agent reads in SKILL.md still apply.
const DEMO_TITLES: Record<string, string> = {
  "action-panel.html": "Action Panel",
  "ask-approval.html": "Ask Approval",
  "board-ops.html": "Agent Board",
  "live-link.html": "Linked File",
  "report-brief.html": "Report Brief",
  "state-gauge.html": "State Gauge",
  "stream-build.html": "Build Stream",
};

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
  multi: Record<string, string[]>;
}

// Flags that never take a value. Anything not listed here that's followed by a
// non-`--` token consumes that token as its value. Adding a flag here prevents
// it from silently swallowing the next positional argument.
const BOOLEAN_FLAGS = new Set([
  "help", "json", "no-ack", "no-open", "no-qr", "include-hidden",
  "freetext", "wait", "md", "toc", "autoplay", "loop", "user", "clear",
]);

// Flags that may repeat (--param a=1 --param b=2); collected in order.
const MULTI_FLAGS = new Set(["param"]);

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const multi: Record<string, string[]> = {};
  const record = (name: string, value: string | boolean) => {
    if (MULTI_FLAGS.has(name) && typeof value === "string") {
      (multi[name] = multi[name] || []).push(value);
    } else {
      flags[name] = value;
    }
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const eq = name.indexOf("=");
      if (eq !== -1) {
        record(name.slice(0, eq), name.slice(eq + 1));
      } else if (BOOLEAN_FLAGS.has(name)) {
        flags[name] = true;
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          record(name, next);
          i++;
        } else {
          flags[name] = true;
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags, multi };
}

function validateFlagValue(name: string, kind: FlagKind, value: string | boolean): void {
  if (kind === "boolean" && value !== true) usage(`--${name} is a boolean flag and does not take a value`);
  if (kind !== "boolean" && value === true) usage(`--${name} expects a value`);
  if (kind === "number" && typeof value === "string" && !Number.isFinite(Number(value))) {
    usage(`--${name} expects a number`);
  }
  if (kind === "duration" && typeof value === "string") {
    parseDurationSeconds(value);
  }
}

function validateFlags(spec: CommandSpec, flags: Record<string, string | boolean>, multi: Record<string, string[]>): void {
  const known = new Set([...Object.keys(spec.flags), "help"]);
  for (const name of Object.keys(flags)) {
    if (!known.has(name)) usage(`unknown flag --${name}`);
    const kind = spec.flags[name];
    if (kind) validateFlagValue(name, kind, flags[name]);
  }
  for (const name of Object.keys(multi)) {
    if (!known.has(name)) usage(`unknown flag --${name}`);
    if (spec.flags[name] !== "multi") usage(`--${name} cannot be repeated`);
  }
}

// --param k=v pairs → params object; a value of "-" reads stdin (one max).
async function collectParams(multi: Record<string, string[]>): Promise<Record<string, unknown> | undefined> {
  const pairs = multi.param || [];
  if (!pairs.length) return undefined;
  const params: Record<string, unknown> = {};
  let stdinUsed = false;
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq === -1) usage(`--param expects key=value (got "${pair}")`);
    const key = pair.slice(0, eq);
    let value: unknown = pair.slice(eq + 1);
    if (value === "-") {
      if (stdinUsed) usage("only one --param may read stdin");
      stdinUsed = true;
      value = await readStdin();
    }
    params[key] = value;
  }
  return params;
}

function parseMetadataField(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null;
  if (typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string") return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
  });
}

interface ContentInput {
  path?: string;
  content?: string;
  content_base64?: string;
}

async function readContentInput(flags: Record<string, string | boolean>): Promise<ContentInput | undefined> {
  if (typeof flags.file === "string") {
    const abs = path.resolve(flags.file);
    return {
      path: path.basename(abs),
      content_base64: fs.readFileSync(abs).toString("base64"),
    };
  }
  if (flags.content === "-") return { content: await readStdin() };
  if (typeof flags.content === "string") return { content: flags.content };
  return undefined;
}

// Parse a human duration like "5m", "30d", "1h", "90s", or a bare number of
// seconds into seconds. Returns undefined when the flag is absent.
function parseDurationSeconds(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !raw.trim()) usage(`invalid duration: ${String(raw)}`);
  const m = raw.trim().match(/^(\d+)\s*(s|m|h|d)?$/i);
  if (!m) usage(`invalid duration: ${raw} (use e.g. 90s, 5m, 1h, 30d)`);
  const n = Number(m![1]);
  const unit = (m![2] || "s").toLowerCase();
  const mult = unit === "d" ? 86400 : unit === "h" ? 3600 : unit === "m" ? 60 : 1;
  return n * mult;
}

function parseNumberFlag(flags: Record<string, string | boolean>, name: string): number | undefined {
  const raw = flags[name];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !raw.trim()) usage(`--${name} expects a number`);
  const n = Number(raw);
  if (!Number.isFinite(n)) usage(`--${name} expects a number`);
  return n;
}

function parseServerDate(value: unknown): Date | null {
  if (!value) return null;
  const raw = String(value);
  const parsed = Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(raw) ? raw : raw + "Z");
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

function installLifetimeGuards(timeoutSec?: number) {
  if (timeoutSec && timeoutSec > 0) {
    setTimeout(() => {
      console.error(JSON.stringify({ error: "timeout", timeout_seconds: timeoutSec }));
      process.exit(3);
    }, timeoutSec * 1000).unref();
  }
  setInterval(() => {
    if (process.ppid === 1) {
      console.error(JSON.stringify({ error: "parent process exited; stopping SSE follower" }));
      process.exit(0);
    }
  }, 5000).unref();
}

function parseMetadata(flags: Record<string, string | boolean>): Record<string, unknown> | undefined {
  if (typeof flags.metadata !== "string") return undefined;
  try {
    return JSON.parse(flags.metadata);
  } catch {
    usage("--metadata must be valid JSON");
  }
}

// Surfaces are owned by projects, not agents: every create/link/present stamps
// the git root of the caller's working directory (falling back to the cwd
// itself outside a repo). The agent label is self-reported attribution that
// rides in metadata.agent — a name tag, not a passport.
function resolveProjectRoot(): string {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();
    if (out) return out;
  } catch {}
  return process.cwd();
}

function attributionMetadata(flags: Record<string, string | boolean>): Record<string, unknown> | undefined {
  const metadata = parseMetadata(flags);
  if (typeof flags.agent === "string" && flags.agent) {
    return { ...(metadata || {}), agent: flags.agent };
  }
  return metadata;
}

async function call(method: string, pathname: string, body?: unknown): Promise<any> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (TOKEN) headers["Authorization"] = `Bearer ${TOKEN}`;
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: any;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const err: any = new Error(parsed?.error || `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

function out(value: unknown) {
  if (value === null || value === undefined) return;
  if (typeof value === "string") console.log(value);
  else console.log(JSON.stringify(value, null, 2));
}

function printPairingLink(token: any, options: { baseUrl: string; hostedUrl?: string; qr?: boolean }) {
  const directUrl = token?.pairingUrl || buildPairingUrl(options.baseUrl, token?.credential || "");
  const pairingUrl = options.hostedUrl && token?.credential
    ? buildHostedPairingUrl(options.hostedUrl, options.baseUrl, token.credential)
    : directUrl;
  console.log(
    [
      "Surface pairing link",
      "",
      "Open this URL on the device you want to pair:",
      pairingUrl,
      "",
      options.hostedUrl ? `Backend: ${options.baseUrl}` : "",
      `Token: ${token?.credential || ""}`,
      token?.expiresAt ? `Expires: ${token.expiresAt}` : "",
      "",
      options.qr === false ? "" : renderTerminalQrCode(pairingUrl),
      options.qr === false ? "" : "",
      "After pairing, the device keeps a session cookie. The one-time token cannot be reused.",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

function fail(err: any, code = 1): never {
  const payload: Record<string, unknown> = { error: err?.message || String(err) };
  if (err?.status) payload.status = err.status;
  if (err?.body && typeof err.body === "object") {
    for (const [key, value] of Object.entries(err.body)) {
      if (key !== "error") payload[key] = value;
    }
  }
  console.error(JSON.stringify(payload));
  process.exit(code);
}

function usage(message: string): never {
  console.error(JSON.stringify({ error: message }));
  process.exit(2);
}

// Block until a matching action arrives (the layer-1 live waiter of the
// delivery ladder). Resolves {action} on a match, {timedOut: true} when
// timeoutSec elapses first. Ack is implicit on delivery unless disabled.
async function waitForAction(opts: {
  surfaceId?: string;
  wantAction?: string;
  wantEvent?: string;
  timeoutSec?: number;
  autoAck?: boolean;
  // Follow mode: emit every matching action (one call per action) and keep
  // listening instead of resolving on the first match. The connection stays
  // registered as the layer-1 waiter the whole time.
  onAction?: (action: any) => void;
}): Promise<{ action?: any; timedOut?: boolean }> {
  const wantEvent = opts.wantEvent || "surface_action";
  const autoAck = opts.autoAck !== false;
  // With --no-ack handled actions stay in the pending inbox, so the
  // reconnect re-drain would emit them again without this.
  const seen = new Set<string>();

  const normalizeData = (d: unknown) => {
    if (typeof d === "string") {
      try { return JSON.parse(d); } catch { return d; }
    }
    return d;
  };

  const isMatch = (a: any): boolean => {
    if (!a || typeof a !== "object") return false;
    // surface_action payloads carry the surface as `surface_id`; state_patch /
    // stream_append payloads carry it as `id` (their `id` IS the surface id).
    const sid = a.surface_id !== undefined ? a.surface_id : a.id;
    if (opts.surfaceId && sid !== opts.surfaceId) return false;
    if (opts.wantAction && a.action !== opts.wantAction) return false;
    return true;
  };

  const finalize = async (action: any) => {
    if (autoAck && action.id && wantEvent === "surface_action") {
      try { await call("POST", `/actions/${encodeURIComponent(action.id)}/ack`); } catch {}
    }
    return {
      id: action.id,
      surface_id: action.surface_id,
      surface_title: action.surface_title,
      action: action.action,
      data: normalizeData(action.data),
      created_at: action.created_at,
    };
  };

  // Oldest-pending-first: drain the inbox before listening live, so an action
  // that arrived while no waiter was connected is never skipped.
  const pollPending = async (): Promise<any | null> => {
    if (wantEvent !== "surface_action") return null;
    try {
      const path = opts.surfaceId ? `/artifacts/${encodeURIComponent(opts.surfaceId)}/actions` : `/actions`;
      const pending = (await call("GET", path)) as any[];
      for (const a of pending) {
        if (!isMatch(a) || (a.id && seen.has(a.id))) continue;
        if (a.id) seen.add(a.id);
        if (opts.onAction) opts.onAction(await finalize(a));
        else return finalize(a);
      }
    } catch {}
    return null;
  };

  const work = (async () => {
    const pending = await pollPending();
    if (pending) return pending;
    let backoff = 1000;
    while (true) {
      // Always listen on the global stream — per-surface streams don't carry
      // surface_action events. Filtering happens in isMatch(). wait_for
      // registers this connection as a layer-1 waiter so bindings stay
      // suppressed while we're alive.
      const url = `${BASE}/stream?wait_for=${encodeURIComponent(opts.surfaceId || "*")}`;
      const headers: Record<string, string> = { Accept: "text/event-stream" };
      if (TOKEN) headers["Authorization"] = `Bearer ${TOKEN}`;
      let res: Response;
      try {
        res = await fetch(url, { headers });
      } catch {
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30000);
        continue;
      }
      if (!res.ok || !res.body) {
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30000);
        continue;
      }
      backoff = 1000;
      const justMissed = await pollPending();
      if (justMissed) return justMissed;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let evt = "message";
      let lines: string[] = [];
      let disconnected = false;
      while (!disconnected) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch {
          disconnected = true;
          break;
        }
        if (chunk.done) {
          disconnected = true;
          break;
        }
        buf += decoder.decode(chunk.value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).replace(/\r$/, "");
          buf = buf.slice(nl + 1);
          if (line === "") {
            if (lines.length > 0 && evt === wantEvent) {
              let parsed: any;
              try { parsed = JSON.parse(lines.join("\n")); } catch { parsed = lines.join("\n"); }
              if (wantEvent === "surface_action") {
                if (isMatch(parsed) && !(parsed?.id && seen.has(parsed.id))) {
                  if (parsed?.id) seen.add(parsed.id);
                  if (opts.onAction) opts.onAction(await finalize(parsed));
                  else return finalize(parsed);
                }
              } else if (isMatch(parsed)) {
                // Non-action events (state_patch, stream_append, …): the
                // payload is the event itself — no ack envelope, and no dedup
                // (their `id` is the surface id, which repeats every event).
                if (opts.onAction) opts.onAction(parsed);
                else return { ...parsed };
              }
            }
            evt = "message";
            lines = [];
          } else if (line.startsWith(":")) {
            // SSE comment / heartbeat
          } else if (line.startsWith("event:")) {
            evt = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            lines.push(line.slice(5).trim());
          }
        }
      }
      // Reconnect: re-poll pending actions to catch anything during the gap.
      const missed = await pollPending();
      if (missed) return missed;
    }
  })();

  if (opts.timeoutSec && opts.timeoutSec > 0) {
    let timer: NodeJS.Timeout;
    const timeoutP = new Promise<{ timedOut: true }>((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), opts.timeoutSec! * 1000);
    });
    const raced = await Promise.race([work.then((action) => ({ action })), timeoutP]);
    clearTimeout(timer!);
    return raced as { action?: any; timedOut?: boolean };
  }
  return { action: await work };
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return;
  }
  const spec = COMMANDS[cmd];
  if (!spec) {
    console.error(`Unknown command: ${cmd}\n\n${HELP}`);
    process.exit(2);
  }
  const { positional, flags, multi } = parseArgs(argv.slice(1));
  validateFlags(spec, flags, multi);
  if (flags.help) {
    console.log(spec.help);
    return;
  }
  await spec.run({ cmd, positional, flags, multi });
}

async function runCommand({ cmd, positional, flags, multi }: CommandContext): Promise<void> {
  switch (cmd) {
    case "list": {
      const params = new URLSearchParams();
      if (flags["include-hidden"] === true) params.set("include_hidden", "1");
      if (typeof flags.project === "string") params.set("project", flags.project);
      if (typeof flags.agent === "string") params.set("agent", flags.agent);
      const qs = params.toString();
      out(await call("GET", `/artifacts${qs ? `?${qs}` : ""}`));
      return;
    }

    case "read": {
      const id = positional[0];
      if (!id) usage("usage: " + CMD_HELP.read);
      out(await call("GET", `/artifacts/${encodeURIComponent(id)}`));
      return;
    }

    case "create": {
      const title = positional[0];
      if (!title) usage("usage: " + CMD_HELP.create);
      const body: Record<string, unknown> = { title, project_root: resolveProjectRoot() };
      if (typeof flags.id === "string") body.id = flags.id;
      if (typeof flags.template === "string") {
        body.template = flags.template;
        const params = await collectParams(multi);
        if (params) body.params = params;
      } else {
        const content = await readContentInput(flags);
        if (typeof flags.mime === "string") body.mime = flags.mime;
        if (content) Object.assign(body, content);
      }
      const metadata = attributionMetadata(flags);
      if (metadata) body.metadata = metadata;
      out(await call("POST", "/artifacts", body));
      return;
    }

    case "ask": {
      const question = positional[0];
      if (!question) usage("usage: " + CMD_HELP.ask);
      const timeoutSec = parseNumberFlag(flags, "timeout") || 0;
      let contextMd = "";
      if (flags.context === "-") contextMd = await readStdin();
      else if (typeof flags.context === "string") contextMd = flags.context;
      else if (typeof flags["context-file"] === "string") contextMd = fs.readFileSync(path.resolve(flags["context-file"]), "utf8");

      const params: Record<string, unknown> = { question };
      if (contextMd) params.context_md = contextMd;
      if (typeof flags.options === "string") params.options = flags.options;
      if (flags.freetext === true) params.freetext = true;
      if (timeoutSec > 0) params.expires_at = new Date(Date.now() + timeoutSec * 1000).toISOString();

      const body: Record<string, unknown> = {
        template: "ask",
        params,
        title: typeof flags.title === "string" ? flags.title : question,
        project_root: resolveProjectRoot(),
      };
      if (typeof flags.id === "string") body.id = flags.id;
      const metadata = attributionMetadata(flags);
      if (metadata) body.metadata = metadata;

      const created = await call("POST", "/artifacts", body);
      const surfaceId = created.artifact.id;

      if (typeof flags.on === "string") {
        await call("POST", "/display/navigate", { surface_id: surfaceId, device: flags.on });
      }

      if (flags.wait !== true) {
        out(created);
        return;
      }

      const result = await waitForAction({ surfaceId, wantAction: "answer", timeoutSec });
      if (result.timedOut) {
        // Expire the card so stale questions can't be answered later.
        try { await call("PATCH", `/artifacts/${encodeURIComponent(surfaceId)}/state`, { status: "expired" }); } catch {}
        console.error(JSON.stringify({ error: "timeout", timeout_seconds: timeoutSec, surface_id: surfaceId }));
        process.exit(3);
      }
      // The server stamps answered_at/device into state.answer when it flips
      // the card — prefer that record over the bare action payload.
      let answer: any = result.action?.data ?? {};
      try {
        const state = await call("GET", `/artifacts/${encodeURIComponent(surfaceId)}/state`);
        if (state?.state?.answer) answer = state.state.answer;
      } catch {}
      console.log(JSON.stringify({
        choice: answer.choice ?? null,
        text: answer.text ?? null,
        answered_at: answer.answered_at ?? result.action?.created_at ?? null,
        device: answer.device ?? null,
        surface_id: surfaceId,
      }, null, 2));
      process.exit(0);
    }

    case "append": {
      const id = positional[0];
      if (!id) usage("usage: " + CMD_HELP.append);
      const kind = flags.md === true ? "md" : "text";
      const inline = positional.slice(1).join(" ");

      if (inline && inline !== "-") {
        out(await call("POST", `/artifacts/${encodeURIComponent(id)}/append`, {
          chunks: [{ kind, content: inline }],
        }));
        return;
      }

      // Pipe mode: stream stdin line by line, batching so a chatty build log
      // doesn't become one HTTP request per line.
      let batch: Array<{ kind: string; content: string }> = [];
      let flushing = Promise.resolve();
      let firstFlushError: any = null;
      const flush = () => {
        if (!batch.length) return flushing;
        const chunks = batch;
        batch = [];
        flushing = flushing.then(() =>
          call("POST", `/artifacts/${encodeURIComponent(id)}/append`, { chunks }).catch((err) => {
            if (!firstFlushError) firstFlushError = err;
          }),
        );
        return flushing;
      };
      let timer: NodeJS.Timeout | null = null;
      const schedule = () => {
        if (timer) return;
        timer = setTimeout(() => { timer = null; flush(); }, 300);
      };

      await new Promise<void>((resolve) => {
        let buf = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (data: string) => {
          buf += data;
          let nl: number;
          while ((nl = buf.indexOf("\n")) !== -1) {
            batch.push({ kind, content: buf.slice(0, nl) });
            buf = buf.slice(nl + 1);
            if (batch.length >= 50) flush();
          }
          schedule();
        });
        process.stdin.on("end", () => {
          if (buf) batch.push({ kind, content: buf });
          resolve();
        });
      });
      if (timer) clearTimeout(timer);
      await flush();
      await flushing;
      if (firstFlushError) fail(firstFlushError);
      return;
    }

    case "video": {
      const url = positional[0];
      if (!url) usage("usage: " + CMD_HELP.video);
      if (!/^https?:\/\//.test(url)) {
        usage("video expects an http(s) URL — for local video files use: surface present <path>");
      }
      const params: Record<string, unknown> = { url };
      const start = parseNumberFlag(flags, "start");
      if (start !== undefined) params.start = start;
      if (flags.autoplay === true) params.autoplay = true;
      if (flags.loop === true) params.loop = true;
      if (typeof flags.title === "string") params.title = flags.title;
      const body: Record<string, unknown> = {
        template: "video",
        params,
        title: typeof flags.title === "string" ? flags.title : url,
        project_root: resolveProjectRoot(),
      };
      if (typeof flags.id === "string") body.id = flags.id;
      const metadata = attributionMetadata(flags);
      if (metadata) body.metadata = metadata;
      out(await call("POST", "/artifacts", body));
      return;
    }

    case "doc": {
      const docPath = positional[0];
      if (!docPath) usage("usage: " + CMD_HELP.doc);
      const abs = path.resolve(docPath);
      const params: Record<string, unknown> = {};
      if (flags.toc === true) params.toc = true;
      if (typeof flags.width === "string") params.width = flags.width;
      const body: Record<string, unknown> = {
        path: abs,
        title: typeof flags.title === "string" ? flags.title : path.basename(abs),
        template: "doc",
        params,
        project_root: resolveProjectRoot(),
      };
      const metadata = attributionMetadata(flags);
      if (metadata) body.metadata = metadata;
      if (flags["no-open"] === true) body.open = false;
      out(await call("POST", "/artifacts/link", body));
      return;
    }

    case "template": {
      const sub = positional[0];
      const projectRoot = resolveProjectRoot();
      if (sub === "list" || sub === undefined) {
        const templates: any[] = await call("GET", `/api/templates?project=${encodeURIComponent(projectRoot)}`);
        if (flags.json) { out(templates); return; }
        const w = Math.max(4, ...templates.map((t) => t.name.length)) + 2;
        console.log(`${"NAME".padEnd(w)}${"SOURCE".padEnd(10)}DESCRIPTION`);
        for (const t of templates) console.log(`${t.name.padEnd(w)}${t.source.padEnd(10)}${t.description}`);
        return;
      }
      if (sub === "show") {
        const name = positional[1];
        if (!name) usage("usage: " + CMD_HELP.template);
        out(await call("GET", `/api/templates/${encodeURIComponent(name)}?project=${encodeURIComponent(projectRoot)}`));
        return;
      }
      if (sub === "create") {
        // Promote an existing surface into a template scaffold. Written by the
        // CLI (never the service) so the repo's .surface/ stays agent-edited.
        const name = positional[1];
        const from = typeof flags.from === "string" ? flags.from : "";
        if (!name || !from) usage("usage: " + CMD_HELP.template);
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) usage("template names are [A-Za-z0-9._-]");
        const artifact = await call("GET", `/artifacts/${encodeURIComponent(from)}`);
        const htmlFile = (artifact.files || []).find((f: any) => f.mime === "text/html" || f.path.endsWith(".html"));
        if (!htmlFile) fail(new Error(`Artifact ${from} has no HTML file to promote`));
        const destBase = flags.user === true
          ? path.join(process.env.HOME || "~", ".surface", "templates")
          : path.join(projectRoot, ".surface", "templates");
        const dest = path.join(destBase, name);
        if (fs.existsSync(dest)) fail(new Error(`Template directory already exists: ${dest}`));
        const htmlRes = await fetch(`${BASE}/artifacts/${encodeURIComponent(from)}/files/${htmlFile.path}`, {
          headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
        });
        const html = await htmlRes.text();
        fs.mkdirSync(dest, { recursive: true });
        fs.writeFileSync(path.join(dest, "index.html"), html);
        fs.writeFileSync(path.join(dest, "template.json"), JSON.stringify({
          name,
          description: `Promoted from "${artifact.artifact?.title || from}" — edit me`,
          params: {},
          state: {},
          actions: [],
        }, null, 2) + "\n");
        out({
          created: dest,
          next: "Edit template.json (declare params/state/actions) and replace hard-coded values in index.html with {{param}} slots.",
        });
        return;
      }
      usage("usage: " + CMD_HELP.template);
      return;
    }

    case "update": {
      const id = positional[0];
      if (!id) usage("usage: " + CMD_HELP.update);
      const content = await readContentInput(flags);
      const body: Record<string, unknown> = {};
      if (typeof flags.title === "string") body.title = flags.title;
      if (typeof flags.mime === "string") body.mime = flags.mime;
      if (content) Object.assign(body, content);
      const metadata = parseMetadata(flags);
      if (metadata) body.metadata = metadata;
      out(await call("PUT", `/artifacts/${encodeURIComponent(id)}`, body));
      return;
    }

    case "link": {
      const linkPath = positional[0];
      if (!linkPath) usage("usage: " + CMD_HELP.link);
      const abs = path.resolve(linkPath);
      const body: Record<string, unknown> = {
        path: abs,
        title: typeof flags.title === "string" ? flags.title : path.basename(abs),
        project_root: resolveProjectRoot(),
      };
      if (typeof flags.entry === "string") body.entry = flags.entry;
      const metadata = attributionMetadata(flags);
      if (metadata) body.metadata = metadata;
      if (flags["no-open"] === true) body.open = false;
      out(await call("POST", "/artifacts/link", body));
      return;
    }

    case "touch": {
      const id = positional[0];
      if (!id) usage("usage: " + CMD_HELP.touch);
      out(await call("POST", `/artifacts/${encodeURIComponent(id)}/touch`));
      return;
    }

    case "present": {
      const presentPath = positional[0];
      if (!presentPath) usage("usage: " + CMD_HELP.present);
      const body: Record<string, unknown> = { path: path.resolve(presentPath), project_root: resolveProjectRoot() };
      if (typeof flags.title === "string") body.title = flags.title;
      const metadata = attributionMetadata(flags);
      if (metadata) body.metadata = metadata;
      out(await call("POST", "/artifacts/present-file", body));
      return;
    }

    case "set": {
      const [id, key, ...rest] = positional;
      const rawValue = rest.join(" ");
      if (!id || !key || rawValue === "") usage("usage: " + CMD_HELP.set);
      let value: unknown;
      try { value = JSON.parse(rawValue); } catch { value = rawValue; }
      // Build the nested single-key patch from the dotted path.
      let patch: unknown = value;
      const parts = key.split(".").filter(Boolean);
      for (let i = parts.length - 1; i >= 0; i--) patch = { [parts[i]]: patch };
      out(await call("PATCH", `/artifacts/${encodeURIComponent(id)}/state`, patch));
      return;
    }

    case "patch": {
      const id = positional[0];
      if (!id) usage("usage: " + CMD_HELP.patch);
      const raw = positional[1] === "-" || positional[1] === undefined ? await readStdin() : positional[1];
      let body: unknown;
      try { body = JSON.parse(raw); } catch { usage("patch expects valid JSON"); }
      out(await call("PATCH", `/artifacts/${encodeURIComponent(id)}/state`, body));
      return;
    }

    case "state": {
      const id = positional[0];
      if (!id) usage("usage: " + CMD_HELP.state);
      out(await call("GET", `/artifacts/${encodeURIComponent(id)}/state`));
      return;
    }

    case "versions": {
      const id = positional[0];
      if (!id) usage("usage: " + CMD_HELP.versions);
      out(await call("GET", `/artifacts/${encodeURIComponent(id)}/versions`));
      return;
    }

    case "rollback": {
      const [id, version] = positional;
      if (!id || !version) usage("usage: " + CMD_HELP.rollback);
      out(await call("POST", `/artifacts/${encodeURIComponent(id)}/rollback`, { version }));
      return;
    }

    case "delete": {
      const id = positional[0];
      if (!id) usage("usage: " + CMD_HELP.delete);
      out(await call("DELETE", `/artifacts/${encodeURIComponent(id)}`));
      return;
    }

    case "seed-demos": {
      const demosDir = path.resolve(__dirname, "..", "examples", "demos");
      if (!fs.existsSync(demosDir)) {
        fail(new Error(`Demo directory not found: ${demosDir}`));
      }
      const files = fs.readdirSync(demosDir).filter((f) => f.endsWith(".html")).sort();
      // Include hidden rows so a previous `clear-demos` archive can be revived
      // by flipping the hidden flag back off, rather than creating duplicates.
      const existing: any[] = await call("GET", "/artifacts?include_hidden=1");
      const byPath = new Map<string, any>();
      for (const s of existing) {
        const meta = parseMetadataField(s.metadata);
        if (meta && typeof meta.original_path === "string") byPath.set(meta.original_path as string, s);
      }
      const seeded: Array<{ id: string; title: string; file: string }> = [];
      const restored: Array<{ id: string; title: string; file: string }> = [];
      const skipped: string[] = [];
      for (const file of files) {
        const abs = path.join(demosDir, file);
        const found = byPath.get(abs);
        if (found) {
          const meta = parseMetadataField(found.metadata) || {};
          if (meta.hidden === true) {
            const nextMeta: Record<string, unknown> = { ...meta };
            delete nextMeta.hidden;
            await call("PUT", `/artifacts/${encodeURIComponent(found.id)}`, { metadata: nextMeta });
            restored.push({ id: found.id, title: found.title, file });
          } else {
            skipped.push(file);
          }
          continue;
        }
        const title = DEMO_TITLES[file] || file.replace(/\.html$/, "");
        const result = await call("POST", "/artifacts/link", {
          path: abs,
          title,
          metadata: { demo: true },
          open: false,
        });
        seeded.push({ id: result.artifact.id, title, file });
      }
      out({ seeded: seeded.length, restored: restored.length, skipped: skipped.length, items: [...seeded, ...restored] });
      return;
    }

    case "clear-demos": {
      // Soft-hide rather than delete: flip metadata.hidden = true on every
      // demo-tagged surface. Artifact rows stay intact so `seed-demos` can
      // revive them later instead of re-linking from disk.
      const existing: any[] = await call("GET", "/artifacts?include_hidden=1");
      const hidden: string[] = [];
      const alreadyHidden: string[] = [];
      for (const s of existing) {
        const meta = parseMetadataField(s.metadata);
        if (!meta || meta.demo !== true) continue;
        if (meta.hidden === true) { alreadyHidden.push(s.id); continue; }
        const nextMeta = { ...meta, hidden: true };
        await call("PUT", `/artifacts/${encodeURIComponent(s.id)}`, { metadata: nextMeta });
        hidden.push(s.id);
      }
      out({ hidden: hidden.length, already_hidden: alreadyHidden.length, ids: hidden });
      return;
    }

    case "open": {
      const id = positional[0];
      const body: Record<string, unknown> = { surface_id: id };
      if (typeof flags.on === "string") body.device = flags.on;
      out(await call("POST", "/display/navigate", body));
      return;
    }

    case "exec": {
      const id = positional[0];
      if (!id) usage("usage: " + CMD_HELP.exec);
      let js: string | undefined;
      if (flags.js === "-") js = await readStdin();
      else if (typeof flags.js === "string") js = flags.js;
      else if (typeof flags.file === "string") js = fs.readFileSync(path.resolve(flags.file), "utf8");
      if (!js) usage("--js or --file required");
      out(await call("POST", `/artifacts/${encodeURIComponent(id)}/exec`, { js }));
      return;
    }

    case "actions": {
      const id = positional[0];
      const p = id ? `/artifacts/${encodeURIComponent(id)}/actions` : `/actions`;
      out(await call("GET", p));
      return;
    }

    case "ack": {
      const actionId = positional[0];
      if (!actionId) usage("usage: " + CMD_HELP.ack);
      out(await call("POST", `/actions/${encodeURIComponent(actionId)}/ack`));
      return;
    }

    case "reply": {
      const id = positional[0];
      const text = positional.slice(1).join(" ");
      if (!id || !text) usage("usage: " + CMD_HELP.reply);
      out(await call("POST", `/artifacts/${encodeURIComponent(id)}/reply`, { text }));
      return;
    }

    case "notify": {
      const text = positional.join(" ");
      if (!text) usage("usage: " + CMD_HELP.notify);
      const body: Record<string, unknown> = { text };
      if (typeof flags.style === "string") body.style = flags.style;
      const duration = parseNumberFlag(flags, "duration");
      if (duration !== undefined) body.duration = duration;
      if (typeof flags.on === "string") body.device = flags.on;
      out(await call("POST", "/display/notify", body));
      return;
    }

    case "theme": {
      const first = positional[0];
      if (first === "reset") {
        out(await call("POST", "/display/reset"));
        return;
      }
      if (!first) {
        out(await call("GET", "/display/config"));
        return;
      }
      const raw = first === "-" ? await readStdin() : first;
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        usage("theme expects valid JSON");
      }
      out(await call("PUT", "/display/config", body));
      return;
    }

    case "status":
      out(await call("GET", "/display/status"));
      return;

    case "slot": {
      const role = positional[0];
      if (!role) {
        out(await call("GET", "/display/slots"));
        return;
      }
      if (!["renderer", "home", "overlay"].includes(role)) usage("usage:\n" + CMD_HELP.slot);
      const mergeRole = async (artifactId: string, set: boolean) => {
        const data = await call("GET", `/artifacts/${encodeURIComponent(artifactId)}`);
        let meta: Record<string, unknown> = {};
        try { meta = JSON.parse(data.artifact.metadata) || {}; } catch {}
        if (set) meta.display_role = role;
        else delete meta.display_role;
        await call("PUT", `/artifacts/${encodeURIComponent(artifactId)}`, { metadata: meta });
      };
      const clearRole = async () => {
        const all: any[] = await call("GET", "/artifacts?include_hidden=1");
        for (const surface of all) {
          const meta = parseMetadataField(surface.metadata);
          if (meta?.display_role === role) {
            await mergeRole(surface.id, false);
          }
        }
      };
      if (flags.clear === true) {
        let cleared = 0;
        while (true) {
          const slots = await call("GET", "/display/slots");
          if (!slots[role]) break;
          await mergeRole(slots[role], false);
          cleared++;
        }
        out({ ...(await call("GET", "/display/slots")), cleared });
        return;
      }
      const id = positional[1];
      if (!id) usage("usage:\n" + CMD_HELP.slot);
      await clearRole();
      await mergeRole(id, true);
      out(await call("GET", "/display/slots"));
      return;
    }

    case "wait": {
      const surfaceId = typeof flags.id === "string" ? flags.id : undefined;
      const wantAction = typeof flags.action === "string" ? flags.action : undefined;
      const wantEvent = typeof flags.event === "string" ? flags.event : "surface_action";
      const timeoutSec = parseNumberFlag(flags, "timeout") || 0;
      const autoAck = flags["no-ack"] !== true;

      // Some harnesses kill foreground commands after a silent interval
      // (Gemini CLI: 300s default). A heartbeat on stderr resets those timers
      // without polluting the stdout JSON contract.
      const heartbeatSec = parseNumberFlag(flags, "heartbeat") || 0;
      if (heartbeatSec > 0) {
        const beat = setInterval(() => {
          process.stderr.write(`: waiting ${new Date().toISOString()}\n`);
        }, heartbeatSec * 1000);
        beat.unref();
      }

      if (flags.follow === true) {
        installLifetimeGuards(timeoutSec);
        // The persistent action terminal: one compact JSON line per action,
        // forever. Built for harness watchdogs that pattern-match stdout.
        const result = await waitForAction({
          surfaceId, wantAction, wantEvent, timeoutSec, autoAck,
          onAction: (a) => process.stdout.write(JSON.stringify(a) + "\n"),
        });
        // Only resolves when --timeout was given and elapsed (a lifetime cap).
        if (result.timedOut) {
          console.error(JSON.stringify({ error: "timeout", timeout_seconds: timeoutSec }));
          process.exit(3);
        }
        return;
      }

      const result = await waitForAction({ surfaceId, wantAction, wantEvent, timeoutSec, autoAck });
      if (result.timedOut) {
        console.error(JSON.stringify({ error: "timeout", timeout_seconds: timeoutSec }));
        process.exit(3);
      }
      console.log(JSON.stringify(result.action, null, 2));
      process.exit(0);
    }

    case "pair": {
      const ttlSeconds = parseDurationSeconds(flags.ttl);
      const label = typeof flags.name === "string" ? flags.name
        : typeof flags.label === "string" ? flags.label : "pairing link";
      const baseUrl = typeof flags["base-url"] === "string" ? flags["base-url"].replace(/\/$/, "") : BASE;
      const hostedUrl = typeof flags["hosted-url"] === "string" ? flags["hosted-url"].replace(/\/$/, "") : undefined;
      const body: Record<string, unknown> = { label, baseUrl };
      if (ttlSeconds !== undefined) body.ttlSeconds = ttlSeconds;
      const token = await call("POST", "/api/auth/pairing-token", body);
      const output = hostedUrl && token?.credential
        ? { ...token, hostedPairingUrl: buildHostedPairingUrl(hostedUrl, baseUrl, token.credential) }
        : token;
      if (flags.json) out(output);
      else printPairingLink(output, { baseUrl, hostedUrl, qr: flags["no-qr"] !== true });
      return;
    }

    case "stream": {
      const id = typeof flags.id === "string" ? flags.id : undefined;
      const timeoutSec = parseNumberFlag(flags, "timeout");
      installLifetimeGuards(timeoutSec);
      const url = id ? `${BASE}/artifacts/${encodeURIComponent(id)}/stream` : `${BASE}/stream`;
      const headers: Record<string, string> = { Accept: "text/event-stream" };
      if (TOKEN) headers["Authorization"] = `Bearer ${TOKEN}`;
      // Reconnect with backoff until interrupted — a dropped connection (server
      // restart, network blip) should not silently end the tail.
      let backoff = 1000;
      while (true) {
        let res: Response;
        try {
          res = await fetch(url, { headers });
        } catch {
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, 30000);
          continue;
        }
        if (!res.ok || !res.body) {
          if (res.status === 401 || res.status === 403 || res.status === 404) {
            throw new Error(`${res.status} ${res.statusText}`);
          }
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, 30000);
          continue;
        }
        backoff = 1000;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let currentEvent = "message";
        let dataLines: string[] = [];
        while (true) {
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try {
            chunk = await reader.read();
          } catch {
            break;
          }
          if (chunk.done) break;
          buf += decoder.decode(chunk.value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, nl).replace(/\r$/, "");
            buf = buf.slice(nl + 1);
            if (line === "") {
              if (dataLines.length > 0) {
                const data = dataLines.join("\n");
                let parsed: unknown = data;
                try {
                  parsed = JSON.parse(data);
                } catch {}
                process.stdout.write(JSON.stringify({ event: currentEvent, data: parsed }) + "\n");
              }
              currentEvent = "message";
              dataLines = [];
            } else if (line.startsWith(":")) {
              // SSE comment / heartbeat — ignore
            } else if (line.startsWith("event:")) {
              currentEvent = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              dataLines.push(line.slice(5).trim());
            }
          }
        }
      }
    }

    case "devices": {
      if (positional[0] === "revoke") {
        const target = positional[1];
        if (!target) usage("usage: surface devices revoke <name-or-id>");
        out(await call("POST", "/api/auth/devices/revoke", { device: target }));
        return;
      }
      const devices: any[] = await call("GET", "/api/auth/devices");
      if (flags.json) { out(devices); return; }
      if (devices.length === 0) {
        console.log("No paired devices. Pair one with: surface pair --name <device-name>");
        return;
      }
      const ago = (iso: string | null) => {
        const parsed = parseServerDate(iso);
        if (!parsed) return "never";
        const mins = Math.floor((Date.now() - parsed.getTime()) / 60000);
        if (mins < 2) return "just now";
        if (mins < 60) return `${mins}m ago`;
        if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
        return `${Math.floor(mins / 1440)}d ago`;
      };
      const rows = devices.map((d) => ({
        label: d.label || d.id.slice(0, 8),
        seen: d.connected ? "live" : ago(d.last_seen_at),
        viewing: d.viewing || "—",
        ip: d.client_ip || "",
      }));
      const w = Math.max(5, ...rows.map((r) => r.label.length)) + 2;
      const v = Math.max(7, ...rows.map((r) => r.viewing.length)) + 2;
      console.log(`${"LABEL".padEnd(w)}${"LAST SEEN".padEnd(12)}${"VIEWING".padEnd(v)}IP`);
      for (const r of rows) {
        console.log(`${r.label.padEnd(w)}${r.seen.padEnd(12)}${r.viewing.padEnd(v)}${r.ip}`);
      }
      return;
    }

    case "bind": {
      const id = positional[0];
      if (!id) usage("usage: " + CMD_HELP.bind);
      const body: Record<string, unknown> = {};
      if (typeof flags.action === "string") body.action_pattern = flags.action;
      if (typeof flags.run === "string") body.run = flags.run;
      if (typeof flags.webhook === "string") body.webhook_url = flags.webhook;
      if (typeof flags.cwd === "string") body.cwd = path.resolve(flags.cwd);
      const timeout = parseNumberFlag(flags, "timeout");
      if (timeout !== undefined) body.timeout_seconds = timeout;
      out(await call("POST", `/artifacts/${encodeURIComponent(id)}/bindings`, body));
      return;
    }

    case "bindings": {
      const id = positional[0];
      const rows: any[] = await call("GET", id ? `/artifacts/${encodeURIComponent(id)}/bindings` : "/bindings");
      if (flags.json || rows.length === 0) { out(rows); return; }
      for (const b of rows) {
        const target = b.kind === "command" ? b.run : b.webhook_url;
        const status = b.last_status ? `${b.last_status}${b.last_error ? ` (${b.last_error})` : ""} at ${b.last_run_at}` : "never run";
        console.log(`${b.id}  ${b.surface_id}  on:${b.action_pattern}  ${b.enabled ? "" : "[disabled] "}${b.kind}: ${target}\n  last: ${status}`);
      }
      return;
    }

    case "unbind": {
      const id = positional[0];
      if (!id) usage("usage: " + CMD_HELP.unbind);
      out(await call("DELETE", `/bindings/${encodeURIComponent(id)}`));
      return;
    }

    case "init": {
      const root = resolveProjectRoot();
      const surfaceDir = path.join(root, ".surface");
      const created: string[] = [];
      const mkdir = (p: string) => {
        if (!fs.existsSync(p)) { fs.mkdirSync(p, { recursive: true }); created.push(path.relative(root, p) + "/"); }
      };
      mkdir(surfaceDir);
      mkdir(path.join(surfaceDir, "surfaces"));
      mkdir(path.join(surfaceDir, "templates"));
      const configPath = path.join(surfaceDir, "config.json");
      if (!fs.existsSync(configPath)) {
        // bindings.enabled: null = the wake-binding consent question hasn't
        // been asked yet (ask once per project, record the answer here).
        fs.writeFileSync(configPath, JSON.stringify({ bindings: { enabled: null } }, null, 2) + "\n");
        created.push(".surface/config.json");
      }
      const surfaceMdPath = path.join(root, "SURFACE.md");
      if (!fs.existsSync(surfaceMdPath)) {
        fs.writeFileSync(surfaceMdPath, [
          "# SURFACE.md",
          "",
          "What this project shows on the user's Surface display, and how agents should treat it.",
          "Agents: read this at session start, alongside draining `surface actions`. Keep it current",
          "the way you keep CLAUDE.md current.",
          "",
          "## Surfaces",
          "",
          "| id | what it is | update when |",
          "|---|---|---|",
          "| _(none yet — `surface sync --export <id>` adds manifests under `.surface/surfaces/`)_ | | |",
          "",
          "## State variables",
          "",
          "_(document which `surface set` keys matter and when to update them)_",
          "",
          "## Conventions",
          "",
          "- Definitions live in `.surface/` (committed); live values live in Surface's own DB — never write runtime state into this repo.",
          "- `.surface/config.json → bindings.enabled` records whether the user wants clicks to wake offline agents (costs a headless session per wake). Ask once, record the answer, don't re-ask.",
          "",
        ].join("\n"));
        created.push("SURFACE.md");
      }
      out({ project: root, created: created.length ? created : "(everything already existed)" });
      return;
    }

    case "sync": {
      const root = resolveProjectRoot();
      const surfacesDir = path.join(root, ".surface", "surfaces");

      if (typeof flags.export === "string") {
        const id = flags.export;
        const data = await call("GET", `/artifacts/${encodeURIComponent(id)}`);
        let templateParams: Record<string, unknown> = {};
        try { templateParams = JSON.parse(data.artifact.metadata)?.template_params || {}; } catch {}
        const manifest: Record<string, unknown> = {
          id: data.artifact.id,
          title: data.artifact.title,
        };
        if (data.artifact.template) {
          manifest.template = data.artifact.template;
          manifest.params = templateParams;
        }
        manifest.state = { schema: {}, defaults: {} };
        manifest.bindings = [];
        fs.mkdirSync(surfacesDir, { recursive: true });
        const dest = path.join(surfacesDir, `${data.artifact.id}.json`);
        fs.writeFileSync(dest, JSON.stringify(manifest, null, 2) + "\n");
        out({ exported: path.relative(root, dest) });
        return;
      }

      if (!fs.existsSync(surfacesDir)) {
        fail(new Error(`No .surface/surfaces/ in ${root} — run surface init first`));
      }
      const results: Array<Record<string, unknown>> = [];
      for (const entry of fs.readdirSync(surfacesDir).filter((f) => f.endsWith(".json")).sort()) {
        const manifestPath = path.join(surfacesDir, entry);
        let manifest: any;
        try {
          manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        } catch (err: any) {
          results.push({ manifest: entry, error: `invalid JSON: ${err.message}` });
          continue;
        }
        const id = manifest.id || entry.replace(/\.json$/, "");
        if (!manifest.template) {
          results.push({ id, skipped: "manifest has no template (only template-based surfaces sync)" });
          continue;
        }
        try {
          // Create-or-re-render: the server treats POST with an existing id as
          // a param update. Live state values are never touched — only empty
          // state receives manifest defaults.
          const res = await call("POST", "/artifacts", {
            id,
            title: manifest.title || id,
            template: manifest.template,
            params: manifest.params || {},
            project_root: root,
            metadata: typeof flags.agent === "string" ? { agent: flags.agent } : undefined,
          });
          const defaults = manifest.state?.defaults;
          if (defaults && typeof defaults === "object" && Object.keys(defaults).length) {
            const state = await call("GET", `/artifacts/${encodeURIComponent(id)}/state`);
            if (state.state_version === 0) {
              await call("PATCH", `/artifacts/${encodeURIComponent(id)}/state`, defaults);
            }
          }
          results.push({ id, synced: true, version: res.version?.version });
          if (Array.isArray(manifest.bindings) && manifest.bindings.length) {
            results.push({ id, note: "bindings in manifest are registered by surface bind (delivery ladder)" });
          }
        } catch (err: any) {
          results.push({ id, error: err.message });
        }
      }
      out({ project: root, results });
      return;
    }

    case "auth": {
      const group = positional[0];
      const action = positional[1];
      const ttlSeconds = parseDurationSeconds(flags.ttl);
      const label = typeof flags.label === "string" ? flags.label : undefined;

      if (group === "pairing") {
        if (action === "create") {
          const body: Record<string, unknown> = {};
          if (label !== undefined) body.label = label;
          if (ttlSeconds !== undefined) body.ttlSeconds = ttlSeconds;
          if (typeof flags["base-url"] === "string") body.baseUrl = flags["base-url"];
          out(await call("POST", "/api/auth/pairing-token", body));
          return;
        }
        if (action === "list") {
          out(await call("GET", "/api/auth/pairing-tokens"));
          return;
        }
        if (action === "revoke") {
          const id = positional[2];
          if (!id) usage("usage: surface auth pairing revoke <id>");
          out(await call("POST", "/api/auth/pairing-tokens/revoke", { id }));
          return;
        }
        usage("usage:\n" + CMD_HELP.auth);
      }

      if (group === "session") {
        if (action === "issue") {
          const body: Record<string, unknown> = {};
          if (label !== undefined) body.label = label;
          if (ttlSeconds !== undefined) body.ttlSeconds = ttlSeconds;
          if (typeof flags.role === "string") body.role = flags.role;
          out(await call("POST", "/api/auth/sessions", body));
          return;
        }
        if (action === "list") {
          out(await call("GET", "/api/auth/clients"));
          return;
        }
        if (action === "revoke") {
          const id = positional[2];
          if (!id) usage("usage: surface auth session revoke <id>");
          out(await call("POST", "/api/auth/clients/revoke", { id }));
          return;
        }
        usage("usage:\n" + CMD_HELP.auth);
      }

      usage("usage:\n" + CMD_HELP.auth);
      return;
    }

    default:
      usage(`unknown command: ${cmd}`);
  }
}

main().catch((err) => fail(err));
