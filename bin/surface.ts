#!/usr/bin/env -S npx tsx
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
  status                     Get display state
  stream [--id <id>]         Tail SSE events as JSONL until interrupted
  wait [--id <id>]           Block until a matching surface action, then exit 0
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

const CMD_HELP: Record<string, string> = {
  list: "surface list [--project <root>] [--agent <label>] [--include-hidden]",
  read: "surface read <id>",
  create: "surface create <title> [--mime <type>] [--file <path>|--content <s>|--content -] [--id <id>] [--agent <label>] [--metadata <json>]",
  update: "surface update <id> [--title <t>] [--mime <type>] [--file <path>|--content <s>|--content -] [--metadata <json>]",
  link: "surface link <abs-path> [--entry <relpath>] [--title <t>] [--agent <label>] [--metadata <json>] [--no-open]",
  touch: "surface touch <id>",
  present: "surface present <abs-path> [--title <t>] [--agent <label>] [--metadata <json>]",
  versions: "surface versions <id>",
  rollback: "surface rollback <id> <version>",
  delete: "surface delete <id>",
  open: "surface open [<id>] [--on <device>]",
  exec: "surface exec <id> [--js <code>|--file <path>|--js -]",
  actions: "surface actions [<id>]",
  ack: "surface ack <action-id>",
  reply: "surface reply <id> <text>",
  notify: "surface notify <text> [--style info|success|warning|error] [--duration <ms>] [--on <device>]",
  theme: "surface theme [<json>|-|reset]",
  status: "surface status",
  stream: "surface stream [--id <surface-id>]",
  wait: "surface wait [--id <surface-id>] [--action <name>] [--event <name>] [--timeout <seconds>] [--no-ack]",
  pair: "surface pair [--name <device-name>] [--base-url <url>] [--hosted-url <url>] [--ttl 5m] [--json] [--no-qr]",
  devices: "surface devices [revoke <name-or-id>]",
  auth: [
    "surface auth pairing create [--ttl 5m] [--label <l>] [--base-url <url>]",
    "surface auth pairing list",
    "surface auth pairing revoke <id>",
    "surface auth session issue [--role system|device] [--ttl 30d] [--label <l>]",
    "surface auth session list",
    "surface auth session revoke <id>",
  ].join("\n"),
  "seed-demos": "surface seed-demos",
  "clear-demos": "surface clear-demos",
};

// Hand-mapped titles for the bundled example demos. Filenames are derived from
// the file basename; everything else is the same human label the empty-state
// gallery uses, so the same prompts the agent reads in SKILL.md still apply.
const DEMO_TITLES: Record<string, string> = {
  "3d-astronaut.html": "Astronaut · 3D",
  "maps-apple-park.html": "Apple Park · Google Maps",
  "pacman.html": "Pac-Man",
  "spotify-rickroll.html": "Never Gonna Give You Up · Spotify",
  "tweet-trq212.html": "Thariq · X",
  "windy-globe.html": "Wind · Windy",
  "yatch-problem.html": "Yatch Problem · YouTube",
};

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

// Flags that never take a value. Anything not listed here that's followed by a
// non-`--` token consumes that token as its value. Adding a flag here prevents
// it from silently swallowing the next positional argument.
const BOOLEAN_FLAGS = new Set(["help", "json", "no-ack", "no-open", "no-qr", "include-hidden"]);

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const eq = name.indexOf("=");
      if (eq !== -1) {
        flags[name.slice(0, eq)] = name.slice(eq + 1);
      } else if (BOOLEAN_FLAGS.has(name)) {
        flags[name] = true;
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[name] = next;
          i++;
        } else {
          flags[name] = true;
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
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

async function readContent(flags: Record<string, string | boolean>): Promise<string | undefined> {
  if (typeof flags.file === "string") {
    return fs.readFileSync(path.resolve(flags.file), "utf8");
  }
  if (flags.content === "-") return readStdin();
  if (typeof flags.content === "string") return flags.content;
  return undefined;
}

// Parse a human duration like "5m", "30d", "1h", "90s", or a bare number of
// seconds into seconds. Returns undefined when the flag is absent.
function parseDurationSeconds(raw: unknown): number | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const m = raw.trim().match(/^(\d+)\s*(s|m|h|d)?$/i);
  if (!m) usage(`invalid duration: ${raw} (use e.g. 90s, 5m, 1h, 30d)`);
  const n = Number(m![1]);
  const unit = (m![2] || "s").toLowerCase();
  const mult = unit === "d" ? 86400 : unit === "h" ? 3600 : unit === "m" ? 60 : 1;
  return n * mult;
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
  console.error(JSON.stringify(payload));
  process.exit(code);
}

function usage(message: string): never {
  console.error(JSON.stringify({ error: message }));
  process.exit(2);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return;
  }
  const { positional, flags } = parseArgs(argv.slice(1));
  if (flags.help) {
    console.log(CMD_HELP[cmd] || `Unknown command: ${cmd}`);
    return;
  }

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
      const content = await readContent(flags);
      const body: Record<string, unknown> = { title, project_root: resolveProjectRoot() };
      if (typeof flags.id === "string") body.id = flags.id;
      if (typeof flags.mime === "string") body.mime = flags.mime;
      if (content !== undefined) body.content = content;
      const metadata = attributionMetadata(flags);
      if (metadata) body.metadata = metadata;
      out(await call("POST", "/artifacts", body));
      return;
    }

    case "update": {
      const id = positional[0];
      if (!id) usage("usage: " + CMD_HELP.update);
      const content = await readContent(flags);
      const body: Record<string, unknown> = {};
      if (typeof flags.title === "string") body.title = flags.title;
      if (typeof flags.mime === "string") body.mime = flags.mime;
      if (content !== undefined) body.content = content;
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
      if (typeof flags.duration === "string") body.duration = Number(flags.duration);
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

    case "wait": {
      const surfaceId = typeof flags.id === "string" ? flags.id : undefined;
      const wantAction = typeof flags.action === "string" ? flags.action : undefined;
      const wantEvent = typeof flags.event === "string" ? flags.event : "surface_action";
      const timeoutSec = typeof flags.timeout === "string" ? Number(flags.timeout) : 0;
      const autoAck = flags["no-ack"] !== true;

      const normalizeData = (d: unknown) => {
        if (typeof d === "string") {
          try { return JSON.parse(d); } catch { return d; }
        }
        return d;
      };

      const isMatch = (a: any): boolean => {
        if (!a || typeof a !== "object") return false;
        if (surfaceId && a.surface_id !== surfaceId) return false;
        if (wantAction && a.action !== wantAction) return false;
        return true;
      };

      const finalize = async (action: any): Promise<never> => {
        const result = {
          id: action.id,
          surface_id: action.surface_id,
          surface_title: action.surface_title,
          action: action.action,
          data: normalizeData(action.data),
          created_at: action.created_at,
        };
        if (autoAck && action.id && wantEvent === "surface_action") {
          try { await call("POST", `/actions/${encodeURIComponent(action.id)}/ack`); } catch {}
        }
        console.log(JSON.stringify(result, null, 2));
        process.exit(0);
      };

      const pollPending = async () => {
        if (wantEvent !== "surface_action") return;
        try {
          const path = surfaceId ? `/artifacts/${encodeURIComponent(surfaceId)}/actions` : `/actions`;
          const pending = (await call("GET", path)) as any[];
          for (const a of pending) {
            if (isMatch(a)) await finalize(a);
          }
        } catch {}
      };

      const work = (async () => {
        await pollPending();
        let backoff = 1000;
        while (true) {
          // Always listen on the global stream — per-surface stream doesn't carry
          // surface_action events. Filtering by surface_id happens in isMatch().
          const url = `${BASE}/stream`;
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
                  if (isMatch(parsed)) await finalize(parsed);
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
          await pollPending();
        }
      })();

      if (timeoutSec > 0) {
        const timeoutP = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("__TIMEOUT__")), timeoutSec * 1000),
        );
        try {
          await Promise.race([work, timeoutP]);
        } catch (err: any) {
          if (err?.message === "__TIMEOUT__") {
            console.error(JSON.stringify({ error: "timeout", timeout_seconds: timeoutSec }));
            process.exit(3);
          }
          throw err;
        }
      } else {
        await work;
      }
      return;
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
      const url = id ? `${BASE}/artifacts/${encodeURIComponent(id)}/stream` : `${BASE}/stream`;
      const headers: Record<string, string> = { Accept: "text/event-stream" };
      if (TOKEN) headers["Authorization"] = `Bearer ${TOKEN}`;
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const reader = res.body?.getReader();
      if (!reader) throw new Error("SSE body unavailable");
      const decoder = new TextDecoder();
      let buf = "";
      let currentEvent = "message";
      let dataLines: string[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
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
      return;
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
        if (!iso) return "never";
        const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
        if (mins < 2) return "just now";
        if (mins < 60) return `${mins}m ago`;
        if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
        return `${Math.floor(mins / 1440)}d ago`;
      };
      const rows = devices.map((d) => ({
        label: d.label || d.id.slice(0, 8),
        seen: d.connected ? "live" : ago(d.last_seen_at ? d.last_seen_at + "Z" : null),
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
      console.error(`Unknown command: ${cmd}\n\n${HELP}`);
      process.exit(2);
  }
}

main().catch((err) => fail(err));
