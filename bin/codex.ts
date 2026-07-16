import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// Codex integration management (docs/interaction/codex.md).
//
//   surface codex setup    one-time: daemon + SessionStart hook, then every
//                          plain `codex` session is reachable in realtime
//   surface codex status   local + service-side bridge health
//   surface codex hook     the SessionStart hook target (registers the
//                          session with the Surface service; silent, fast,
//                          never fails the codex session)

export const CODEX_HELP = [
  "surface codex setup [--remove-hook]",
  "  One-time integration setup: starts the codex app-server daemon (plain `codex`",
  "  sessions auto-attach to it, which is what makes realtime flowback possible) and",
  "  installs a SessionStart hook that registers each codex session with Surface.",
  "  Codex will ask you to trust the new hook on its next start — that prompt is codex's,",
  "  not Surface's. Headless wakes of dead sessions additionally need per-project consent",
  "  (bindings.enabled in .surface/config.json), same as wake bindings.",
  "surface codex status [--json]",
  "surface codex hook   (internal: SessionStart hook target, reads the payload on stdin)",
].join("\n");

interface Ctx {
  cmd: string;
  positional: string[];
  flags: Record<string, string | boolean>;
  multi: Record<string, string[]>;
}

type CallFn = (method: string, pathname: string, body?: unknown) => Promise<any>;

const MIN_CODEX_VERSION = [0, 144, 0] as const;
const HOOK_COMMAND = "surface codex hook";

function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function daemonSocketPath(): string {
  return process.env.SURFACE_CODEX_SOCKET
    || path.join(codexHome(), "app-server-control", "app-server-control.sock");
}

function codexBin(): string {
  return process.env.SURFACE_CODEX_BIN || "codex";
}

function codexVersion(): [number, number, number] | null {
  try {
    const out = execFileSync(codexBin(), ["--version"], { timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] }).toString();
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(out);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  } catch {
    return null;
  }
}

function versionOk(v: [number, number, number]): boolean {
  const [a, b, c] = v;
  const [x, y, z] = MIN_CODEX_VERSION;
  if (a !== x) return a > x;
  if (b !== y) return b > y;
  return c >= z;
}

function startDaemon(): { ok: boolean; detail: string } {
  try {
    const out = execFileSync(codexBin(), ["app-server", "daemon", "start"], { timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] }).toString();
    try {
      const parsed = JSON.parse(out);
      return { ok: true, detail: parsed.status || "running" };
    } catch {
      return { ok: true, detail: "running" };
    }
  } catch (err: any) {
    return { ok: false, detail: err?.stderr?.toString?.() || err?.message || "failed" };
  }
}

// ── hooks.json management ──
// Shape (codex-rs/config hooks): { "hooks": { "SessionStart": [ { "hooks":
// [{ "type": "command", "command": "…" }] } ] } }. We merge, never clobber:
// unknown events/groups/handlers are preserved byte-for-byte.

function hooksJsonPath(): string {
  return path.join(codexHome(), "hooks.json");
}

function readHooksFile(): Record<string, any> {
  const p = hooksJsonPath();
  if (!fs.existsSync(p)) return { hooks: {} };
  const raw = fs.readFileSync(p, "utf8");
  const parsed = JSON.parse(raw); // malformed file -> loud error, never overwrite
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${p} is not a JSON object`);
  }
  if (parsed.hooks === undefined) parsed.hooks = {};
  return parsed;
}

function isSurfaceHookHandler(handler: any): boolean {
  return handler?.type === "command" && typeof handler.command === "string" && handler.command.includes(HOOK_COMMAND);
}

export function hookInstalled(): boolean {
  try {
    const file = readHooksFile();
    const groups = file.hooks?.SessionStart;
    if (!Array.isArray(groups)) return false;
    return groups.some((g: any) => Array.isArray(g?.hooks) && g.hooks.some(isSurfaceHookHandler));
  } catch {
    return false;
  }
}

function installHook(): { changed: boolean } {
  const file = readHooksFile();
  if (!file.hooks || typeof file.hooks !== "object") file.hooks = {};
  if (!Array.isArray(file.hooks.SessionStart)) file.hooks.SessionStart = [];
  const groups: any[] = file.hooks.SessionStart;
  for (const g of groups) {
    if (Array.isArray(g?.hooks) && g.hooks.some(isSurfaceHookHandler)) {
      return { changed: false };
    }
  }
  groups.push({
    hooks: [{
      type: "command",
      command: HOOK_COMMAND,
      timeout: 10,
      statusMessage: "Registering session with Surface",
    }],
  });
  writeHooksFile(file);
  return { changed: true };
}

function removeHook(): { changed: boolean } {
  const file = readHooksFile();
  const groups = file.hooks?.SessionStart;
  if (!Array.isArray(groups)) return { changed: false };
  let changed = false;
  for (const g of groups) {
    if (!Array.isArray(g?.hooks)) continue;
    const kept = g.hooks.filter((h: any) => !isSurfaceHookHandler(h));
    if (kept.length !== g.hooks.length) { g.hooks = kept; changed = true; }
  }
  file.hooks.SessionStart = groups.filter((g: any) => !Array.isArray(g?.hooks) || g.hooks.length > 0);
  if (changed) writeHooksFile(file);
  return { changed };
}

function writeHooksFile(file: Record<string, any>): void {
  const p = hooksJsonPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n");
  fs.renameSync(tmp, p);
}

// ── hook execution (SessionStart payload on stdin) ──

async function readStdinWithTimeout(ms: number): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    const finish = () => {
      clearTimeout(timer);
      // Codex may hold our stdin open; stop it from keeping the process alive.
      try { process.stdin.pause(); } catch {}
      resolve(data);
    };
    const timer = setTimeout(finish, ms);
    process.stdin.on("data", (d) => { data += d.toString("utf8"); });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

interface ProcInfo { comm: string; ppid: number }

function procInfo(pid: number): ProcInfo | null {
  try {
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      // pid (comm) state ppid …  — comm may contain spaces/parens; take the
      // last ')' as the delimiter.
      const close = stat.lastIndexOf(")");
      const comm = stat.slice(stat.indexOf("(") + 1, close);
      const fields = stat.slice(close + 2).split(" ");
      return { comm, ppid: Number(fields[1]) };
    }
    const out = execFileSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], { timeout: 2_000 }).toString().trim();
    const m = /^\s*(\d+)\s+(.*)$/.exec(out);
    return m ? { comm: path.basename(m[2]), ppid: Number(m[1]) } : null;
  } catch {
    return null;
  }
}

// The hook process is a child (possibly via a shell) of the codex process.
// Walk up until we find it so liveness checks can target the right pid.
export function findCodexAncestorPid(startPid = process.ppid): number | null {
  let pid = startPid;
  for (let hops = 0; hops < 10 && pid > 1; hops++) {
    const info = procInfo(pid);
    if (!info) return null;
    if (/codex/i.test(info.comm)) return pid;
    pid = info.ppid;
  }
  return null;
}

async function runHook(call: CallFn): Promise<void> {
  // Never break or stall a codex session start: swallow every error, cap
  // every wait, always exit 0.
  try {
    const raw = await readStdinWithTimeout(2_000);
    const payload = JSON.parse(raw || "{}");
    const sessionId = payload.session_id || payload.thread_id || process.env.CODEX_THREAD_ID;
    if (!sessionId || typeof sessionId !== "string") return;
    await Promise.race([
      call("POST", "/codex/sessions/register", {
        kind: "codex",
        session_id: sessionId,
        pid: findCodexAncestorPid() ?? undefined,
        cwd: typeof payload.cwd === "string" ? payload.cwd : undefined,
        transcript_path: typeof payload.transcript_path === "string" ? payload.transcript_path : undefined,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("register timeout")), 5_000).unref()),
    ]);
  } catch {
    // silent by design
  } finally {
    process.exit(0); // a lingering stdin/socket must not eat the hook budget
  }
}

// ── entry ──

export async function runCodex(ctx: Ctx, call: CallFn): Promise<void> {
  const sub = ctx.positional[0];

  if (sub === "hook") {
    await runHook(call);
    return;
  }

  if (sub === "status" || sub === undefined) {
    const version = codexVersion();
    const local = {
      codex_version: version ? version.join(".") : null,
      codex_version_ok: version ? versionOk(version) : false,
      daemon_socket: daemonSocketPath(),
      daemon_socket_exists: fs.existsSync(daemonSocketPath()),
      hook_installed: hookInstalled(),
    };
    let service: any = null;
    let serviceError: string | null = null;
    try {
      service = await call("GET", "/codex/status");
    } catch (err: any) {
      serviceError = err?.status === 404
        ? "service predates the codex bridge — run: surface upgrade"
        : err?.message || String(err);
    }
    const result = { ...local, service, service_error: serviceError };
    if (ctx.flags.json === true) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`codex:          ${local.codex_version ? `v${local.codex_version}` : "not found"}${local.codex_version && !local.codex_version_ok ? ` (need >= ${MIN_CODEX_VERSION.join(".")})` : ""}`);
    console.log(`daemon socket:  ${local.daemon_socket} ${local.daemon_socket_exists ? "(present)" : "(missing — run: surface codex setup)"}`);
    console.log(`session hook:   ${local.hook_installed ? "installed" : "not installed — run: surface codex setup"}`);
    if (service) {
      console.log(`bridge:         ${service.connected ? `connected (codex ${service.daemon_version})` : "not connected yet (connects on first delivery)"}`);
      console.log(`deliveries:     ${service.deliveries_ok} ok, ${service.deliveries_failed} failed${service.last_error ? ` — last error: ${service.last_error}` : ""}`);
      console.log(`sessions seen:  ${service.registered_sessions}`);
    } else {
      console.log(`service:        unreachable (${serviceError})`);
    }
    return;
  }

  if (sub === "setup") {
    // Removal must remain available after Codex is uninstalled or downgraded;
    // it only edits Surface's own hook entry.
    if (ctx.flags["remove-hook"] === true) {
      const { changed } = removeHook();
      console.log(changed ? "SessionStart hook removed." : "No Surface SessionStart hook to remove.");
      return;
    }

    const version = codexVersion();
    if (!version) {
      console.error(`codex CLI not found (looked for \`${codexBin()}\`). Install codex first: https://developers.openai.com/codex/cli`);
      process.exitCode = 1;
      return;
    }
    if (!versionOk(version)) {
      console.error(`codex v${version.join(".")} is too old — the Surface bridge needs >= ${MIN_CODEX_VERSION.join(".")}. Run: codex update`);
      process.exitCode = 1;
      return;
    }
    console.log(`codex v${version.join(".")} ok`);

    const daemon = startDaemon();
    if (!daemon.ok) {
      console.error(`could not start the codex app-server daemon: ${daemon.detail}`);
      process.exitCode = 1;
      return;
    }
    console.log(`app-server daemon: ${daemon.detail} (${daemonSocketPath()})`);

    let hook: { changed: boolean };
    try {
      hook = installHook();
    } catch (err: any) {
      console.error(`could not update ${hooksJsonPath()}: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    console.log(hook.changed
      ? `SessionStart hook installed in ${hooksJsonPath()} — codex will ask you to trust it on its next start.`
      : "SessionStart hook already installed.");

    console.log([
      "",
      "Codex sessions started from now on auto-attach to the daemon, and surfaces they",
      "create flow actions straight back into the live conversation. Waking a *dead*",
      "session additionally needs per-project consent: set bindings.enabled=true in",
      "<project>/.surface/config.json (the agent asks you first — that is the contract).",
      "",
      "Note: the daemon does not survive a reboot by itself. Re-run `surface codex setup`",
      "or use `codex app-server daemon bootstrap` for a persistent install.",
    ].join("\n"));
    return;
  }

  console.error(CODEX_HELP);
  process.exitCode = 1;
}
