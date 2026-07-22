import { execFileSync, spawn } from "child_process";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { dataDir } from "./upgrade.js";
import {
  codexBridgeConfigPath,
  readCodexBridgeConfig,
  writeCodexBridgeConfig,
  type CodexBridgeConfig,
} from "../shared/codexBridgeConfig.js";

// Codex integration management (docs/interaction/codex.md).
//
//   surface codex setup    one-time: daemon + SessionStart hook, then every
//                          plain `codex` session is reachable in realtime
//   surface codex status   local + service-side bridge health
//   surface codex hook     the SessionStart hook target (registers the
//                          session with the Surface service; silent, fast,
//                          never fails the codex session)

export const CODEX_HELP = [
  "surface codex setup [--remove|--remove-hook]",
  "  One-time integration setup: starts a shared codex app-server (native daemon on",
  "  Linux/macOS; Surface-managed loopback host for Codex Desktop on Windows) and",
  "  installs a SessionStart hook that registers each codex session with Surface.",
  "  Codex will ask you to trust the new hook on its next start — that prompt is codex's,",
  "  not Surface's. Headless wakes of dead sessions additionally need per-project consent",
  "  (bindings.enabled in .surface/config.json), same as wake bindings.",
  "surface codex launch",
  "  Windows: starts Codex Desktop with the bridge endpoint scoped to that process.",
  "  Quit any running Codex Desktop window first. Normal app launches stay unchanged.",
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
const DESKTOP_WS_ENV = "CODEX_APP_SERVER_WS_URL";

export function createWindowsBridgeConfig(endpoint: string, codexBinary: string): CodexBridgeConfig {
  return {
    version: 1,
    transport: "websocket",
    endpoint,
    codex_bin: codexBinary,
    managed: true,
    updated_at: new Date().toISOString(),
  };
}

export function desktopLaunchEnvironment(base: NodeJS.ProcessEnv, endpoint: string): NodeJS.ProcessEnv {
  return { ...base, [DESKTOP_WS_ENV]: endpoint };
}

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

function codexVersionForBin(bin: string): [number, number, number] | null {
  try {
    const out = execFileSync(bin, ["--version"], { timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] }).toString();
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(out);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  } catch {
    return null;
  }
}

function codexVersion(): [number, number, number] | null {
  return codexVersionForBin(codexBin());
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

function findNativeCodexBinary(root: string): string | null {
  const wanted = process.platform === "win32" ? "codex.exe" : "codex";
  const openai = path.join(root, "node_modules", "@openai");
  if (!fs.existsSync(openai)) return null;
  const stack = [openai];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name === wanted && path.basename(path.dirname(full)) === "bin") return full;
    }
  }
  return null;
}

function provisionCodexRuntime(): string {
  if (process.env.SURFACE_CODEX_BIN) {
    const explicit = path.resolve(process.env.SURFACE_CODEX_BIN);
    if (!versionOk(codexVersionForBin(explicit) || [0, 0, 0])) {
      throw new Error(`SURFACE_CODEX_BIN is missing or older than ${MIN_CODEX_VERSION.join(".")}: ${explicit}`);
    }
    return explicit;
  }
  const root = path.join(dataDir(), "codex-runtime");
  const existing = findNativeCodexBinary(root);
  if (existing && versionOk(codexVersionForBin(existing) || [0, 0, 0])) return existing;

  fs.mkdirSync(root, { recursive: true });
  const npmArgs = ["install", "--prefix", root, "--no-save", "--omit=dev", "--no-audit", "--no-fund", "@openai/codex@latest"];
  const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const npmCommand = fs.existsSync(npmCli) ? process.execPath : "npm";
  const args = fs.existsSync(npmCli) ? [npmCli, ...npmArgs] : npmArgs;
  try {
    execFileSync(npmCommand, args, {
      timeout: 5 * 60_000,
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true,
    });
  } catch (err: any) {
    throw new Error(`could not install Surface's private Codex runtime: ${err?.message || err}`);
  }
  const installed = findNativeCodexBinary(root);
  if (!installed || !versionOk(codexVersionForBin(installed) || [0, 0, 0])) {
    throw new Error(`npm completed but no compatible native Codex binary was found under ${root}`);
  }
  return installed;
}

function allocateLoopbackEndpoint(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((err) => err ? reject(err) : resolve(`ws://127.0.0.1:${port}`));
    });
  });
}

function windowsUserEnv(name: string): string | null {
  try {
    const out = execFileSync("reg.exe", ["query", "HKCU\\Environment", "/v", name], { stdio: ["ignore", "pipe", "ignore"] }).toString();
    const m = new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.*)$`, "mi").exec(out);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

function clearWindowsUserEnv(name: string): void {
  if (windowsUserEnv(name) === null) return;
  execFileSync("reg.exe", ["delete", "HKCU\\Environment", "/v", name, "/f"], {
    timeout: 15_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Broadcast an environment refresh without recreating the dangerous value.
  const marker = "SURFACE_ENVIRONMENT_REFRESH";
  execFileSync("setx.exe", [marker, String(Date.now())], { timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("reg.exe", ["delete", "HKCU\\Environment", "/v", marker, "/f"], { timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
  if (windowsUserEnv(name) !== null) throw new Error(`failed to remove ${name} from the user environment`);
}

function clearLegacyDesktopEnvironment(existing: CodexBridgeConfig | null): boolean {
  if (process.platform !== "win32") return false;
  const current = windowsUserEnv(DESKTOP_WS_ENV);
  // Migrate only the value that this Surface config previously installed.
  // An unrelated user-managed endpoint is left untouched.
  if (current && (current === existing?.desktop_env_set || current === existing?.endpoint)) {
    clearWindowsUserEnv(DESKTOP_WS_ENV);
    return true;
  }
  return false;
}

function removeManagedDesktopBridge(existing: CodexBridgeConfig | null): void {
  clearLegacyDesktopEnvironment(existing);
  try { fs.unlinkSync(codexBridgeConfigPath(dataDir())); } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
  }
}

export function findCodexDesktopExecutable(): string | null {
  const explicit = process.env.SURFACE_CODEX_DESKTOP_BIN;
  if (explicit) return fs.existsSync(explicit) ? path.resolve(explicit) : null;
  if (process.platform !== "win32") return null;
  try {
    const script = [
      "$p = Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1",
      "if ($p) { Join-Path $p.InstallLocation 'app\\ChatGPT.exe' }",
    ].join("; ");
    const result = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      timeout: 15_000,
      windowsHide: true,
      encoding: "utf8",
    }).trim();
    return result && fs.existsSync(result) ? result : null;
  } catch {
    return null;
  }
}

function codexDesktopRunning(): boolean {
  if (process.platform !== "win32") return false;
  try {
    const rows = execFileSync("tasklist.exe", ["/FI", "IMAGENAME eq ChatGPT.exe", "/FO", "CSV", "/NH"], {
      timeout: 2_000,
      windowsHide: true,
      encoding: "utf8",
    });
    return /^"ChatGPT\.exe"\s*,/im.test(rows);
  } catch {
    return false;
  }
}

async function launchCodexDesktop(call: CallFn): Promise<void> {
  if (process.platform !== "win32") {
    console.error("surface codex launch is only needed for Codex Desktop on Windows.");
    process.exitCode = 1;
    return;
  }
  const managed = readCodexBridgeConfig(dataDir());
  if (!managed) {
    console.error("Codex Desktop bridge is not configured. Run: surface codex setup");
    process.exitCode = 1;
    return;
  }
  if (codexDesktopRunning()) {
    console.error("Codex Desktop is already running. Quit it completely, then run: surface codex launch");
    process.exitCode = 1;
    return;
  }
  clearLegacyDesktopEnvironment(managed);
  let service: any;
  try {
    service = await call("POST", "/codex/host/start", {});
  } catch (err: any) {
    console.error(`Could not start the Codex bridge host: ${err?.message || err}`);
    process.exitCode = 1;
    return;
  }
  if (!service?.managed_host?.reachable && !service?.managed_host?.running) {
    console.error("The Codex bridge host did not become reachable; Desktop was not launched.");
    process.exitCode = 1;
    return;
  }
  const desktop = findCodexDesktopExecutable();
  if (!desktop) {
    console.error("Codex Desktop is not installed (expected the OpenAI.Codex Windows package).");
    process.exitCode = 1;
    return;
  }
  const child = spawn(desktop, [], {
    cwd: path.dirname(desktop),
    detached: true,
    stdio: "ignore",
    windowsHide: false,
    env: desktopLaunchEnvironment(process.env, managed.endpoint),
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  }).catch((err) => {
    console.error(`Could not launch Codex Desktop: ${err?.message || err}`);
    process.exitCode = 1;
  });
  if (process.exitCode) return;
  child.unref();
  console.log(`Codex Desktop launched with Surface flowback (${managed.endpoint}).`);
  console.log("This endpoint is process-scoped; normal Codex Desktop startup remains independent.");
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

  if (sub === "launch") {
    await launchCodexDesktop(call);
    return;
  }

  if (sub === "status" || sub === undefined) {
    const managed = readCodexBridgeConfig(dataDir());
    const version = managed ? codexVersionForBin(managed.codex_bin) : codexVersion();
    const local = {
      codex_version: version ? version.join(".") : null,
      codex_version_ok: version ? versionOk(version) : false,
      daemon_socket: daemonSocketPath(),
      daemon_socket_exists: fs.existsSync(daemonSocketPath()),
      managed_endpoint: managed?.endpoint || null,
      managed_config: managed ? codexBridgeConfigPath(dataDir()) : null,
      desktop_environment: process.platform === "win32" ? windowsUserEnv(DESKTOP_WS_ENV) : null,
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
    if (local.managed_endpoint) {
      console.log(`app-server:     ${local.managed_endpoint} (managed by Surface)`);
      if (process.platform === "win32") {
        const desktopState = local.desktop_environment === local.managed_endpoint
          ? "unsafe legacy value detected — rerun setup to remove it"
          : local.desktop_environment
            ? "user-defined (Surface does not modify it)"
            : "not persisted (safe; use: surface codex launch)";
        console.log(`desktop env:    ${desktopState}`);
      }
    } else {
      console.log(`daemon socket:  ${local.daemon_socket} ${local.daemon_socket_exists ? "(present)" : "(missing — run: surface codex setup)"}`);
    }
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

    if (ctx.flags.remove === true) {
      const existing = readCodexBridgeConfig(dataDir());
      if (process.platform === "win32" && existing && codexDesktopRunning()) {
        console.error("Quit Codex Desktop before removing its Surface bridge; removal stops the shared host.");
        process.exitCode = 1;
        return;
      }
      try { await call("POST", "/codex/host/stop", {}); } catch {}
      removeManagedDesktopBridge(existing);
      const { changed } = removeHook();
      console.log(existing ? "Managed Codex Desktop bridge removed." : "No managed Codex Desktop bridge was configured.");
      console.log(changed ? "SessionStart hook removed." : "No Surface SessionStart hook to remove.");
      return;
    }

    // The upstream daemon lifecycle is Unix-only. On Windows, provision a
    // private native runtime and let the Surface background service start a
    // detached loopback WebSocket app-server. Desktop receives the endpoint
    // only from `surface codex launch`; setup never changes its global env.
    if (process.platform === "win32" && !process.env.SURFACE_CODEX_SOCKET) {
      const existing = readCodexBridgeConfig(dataDir());
      console.log("Preparing a private Codex runtime for Surface (your global Codex install is unchanged)...");
      let nativeBin: string;
      try {
        nativeBin = provisionCodexRuntime();
      } catch (err: any) {
        console.error(err.message);
        process.exitCode = 1;
        return;
      }
      const version = codexVersionForBin(nativeBin)!;
      const endpoint = existing?.endpoint || await allocateLoopbackEndpoint();
      try {
        clearLegacyDesktopEnvironment(existing);
        writeCodexBridgeConfig(dataDir(), createWindowsBridgeConfig(endpoint, nativeBin));
      } catch (err: any) {
        console.error(`could not configure Codex Desktop: ${err.message}`);
        process.exitCode = 1;
        return;
      }

      let hook: { changed: boolean };
      try { hook = installHook(); }
      catch (err: any) {
        try {
          if (existing) {
            writeCodexBridgeConfig(dataDir(), existing);
          } else {
            try { fs.unlinkSync(codexBridgeConfigPath(dataDir())); } catch {}
          }
          await call("POST", "/codex/host/start", {});
        } catch {}
        console.error(`could not update ${hooksJsonPath()}: ${err.message}`);
        process.exitCode = 1;
        return;
      }

      let hostReady = false;
      try {
        const service = await call("POST", "/codex/host/start", {});
        hostReady = service?.managed_host?.reachable === true || service?.managed_host?.running === true || service?.connected === true;
      } catch (err: any) {
        console.error(`bridge configured, but the Surface service could not start it: ${err?.message || err}`);
      }
      console.log(`codex v${version.join(".")} ready at ${endpoint}`);
      console.log(`Surface service host: ${hostReady ? "running" : "configured; restart the Surface service after fixing its health"}`);
      console.log(hook.changed
        ? `SessionStart hook installed in ${hooksJsonPath()}.`
        : "SessionStart hook already installed.");
      console.log("Quit Codex Desktop completely, then run `surface codex launch` to open it with flowback.");
      console.log("Normal Start-menu launches remain independent and can never fail because Surface is down.");
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
