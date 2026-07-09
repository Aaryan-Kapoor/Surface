import { spawnSync } from "child_process";
import { createHash } from "crypto";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

// `surface service` — one command, three native per-user supervisors:
//   Linux   systemd user unit      (~/.config/systemd/user/<name>.service)
//   macOS   launchd LaunchAgent    (~/Library/LaunchAgents/com.surface-display.<name>.plist)
//   Windows Scheduled Task at logon (task name = <name>)
// All three exec the same argv (node dist/server.mjs --log-file … [--port …]),
// so behavior differences live in the supervisor, never in the server. The
// server tees its output to the log file itself (server/logging.ts) because
// Scheduled Tasks cannot redirect output and launchd/journald disagree anyway.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ServiceConfig {
  name: string;
  node: string;
  entry: string;
  dataDir: string;
  logFile: string;
  port: number;
  contentPort?: number;
  bind?: string;
}

export function serverArgs(cfg: ServiceConfig): string[] {
  const args = [cfg.entry, "--log-file", cfg.logFile, "--data-dir", cfg.dataDir];
  if (cfg.port !== 3000) args.push("--port", String(cfg.port));
  if (cfg.contentPort !== undefined) args.push("--content-port", String(cfg.contentPort));
  if (cfg.bind) args.push("--bind", cfg.bind);
  return args;
}

// ---------- generators (pure; unit-tested in test/service.ts) ----------

function systemdQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function systemdUnit(cfg: ServiceConfig): string {
  const exec = [cfg.node, ...serverArgs(cfg)].map(systemdQuote).join(" ");
  return `[Unit]
Description=Surface local display service (${cfg.name})
After=network.target

[Service]
Type=simple
WorkingDirectory=${cfg.dataDir}
Environment=NODE_ENV=production
ExecStart=${exec}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`;
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function launchdLabel(name: string): string {
  return `com.surface-display.${name}`;
}

export function launchdPlist(cfg: ServiceConfig): string {
  const args = [cfg.node, ...serverArgs(cfg)]
    .map((a) => `    <string>${xmlEscape(a)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(launchdLabel(cfg.name))}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(cfg.dataDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
</dict>
</plist>
`;
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function windowsInstallScript(cfg: ServiceConfig): string {
  // conhost --headless keeps the console window from appearing at logon; the
  // task itself runs node directly underneath it. Scheduled Tasks cannot set
  // environment variables, which is why the server takes flags (serverArgs).
  // The -Argument value is a Windows process command line: each path rides in
  // literal double quotes. The whole thing is a single-quoted PowerShell
  // string (psQuote), so no backslash escaping is involved anywhere.
  const argument = ["--headless", cfg.node, ...serverArgs(cfg)]
    .map((a) => (a.startsWith("--") ? a : `"${a}"`))
    .join(" ");
  return [
    `$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument ${psQuote(argument)} -WorkingDirectory ${psQuote(cfg.dataDir)}`,
    `$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME`,
    `$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)`,
    `Register-ScheduledTask -TaskName ${psQuote(cfg.name)} -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null`,
  ].join("\n");
}

export function windowsStopScript(cfg: ServiceConfig): string {
  // Stop-ScheduledTask kills the conhost wrapper but can orphan the node
  // child (observed on CI: the server kept answering after uninstall). Finish
  // the job: kill whatever still LISTENs on the app port, but only if it's
  // our shape of process (node/conhost) — never an unrelated port squatter.
  return [
    `Stop-ScheduledTask -TaskName ${psQuote(cfg.name)} -ErrorAction SilentlyContinue`,
    `$owners = Get-NetTCPConnection -LocalPort ${cfg.port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`,
    `foreach ($id in $owners) {`,
    `  $p = Get-Process -Id $id -ErrorAction SilentlyContinue`,
    `  if ($p -and ($p.ProcessName -eq 'node' -or $p.ProcessName -eq 'conhost')) {`,
    `    Stop-Process -Id $id -Force -ErrorAction SilentlyContinue`,
    `  }`,
    `}`,
  ].join("\n");
}

// ---------- backends ----------

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[]): RunResult {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return {
    ok: r.status === 0,
    stdout: (r.stdout || "").trim(),
    stderr: (r.stderr || "").trim(),
  };
}

function mustRun(cmd: string, args: string[], what: string): void {
  const r = run(cmd, args);
  if (!r.ok) throw new Error(`${what} failed: ${r.stderr || r.stdout || cmd}`);
}

export interface ServiceStatus {
  registered: boolean;
  state: string;
  location: string;
}

interface Backend {
  install(cfg: ServiceConfig): void;
  uninstall(cfg: ServiceConfig): void;
  start(cfg: ServiceConfig): void;
  stop(cfg: ServiceConfig): void;
  restart(cfg: ServiceConfig): void;
  status(cfg: ServiceConfig): ServiceStatus;
}

function systemdUnitPath(name: string): string {
  return path.join(os.homedir(), ".config", "systemd", "user", `${name}.service`);
}

const linuxBackend: Backend = {
  install(cfg) {
    const unitPath = systemdUnitPath(cfg.name);
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    // Pre-`surface service` units ran from the repo clone, where dotenv read
    // the repo .env. The new unit runs from the data dir — warn when we're
    // about to orphan a .env the old working directory was supplying.
    try {
      const old = fs.readFileSync(unitPath, "utf8");
      const oldCwd = old.match(/^WorkingDirectory=(.+)$/m)?.[1]?.trim();
      if (oldCwd && path.resolve(oldCwd) !== path.resolve(cfg.dataDir) && fs.existsSync(path.join(oldCwd, ".env"))) {
        console.error(
          `note: the previous unit ran from ${oldCwd}, which has a .env. ` +
          `The service now runs from ${cfg.dataDir} — copy that .env to ${path.join(cfg.dataDir, ".env")} to keep its settings.`,
        );
      }
    } catch {
      // no previous unit
    }
    fs.writeFileSync(unitPath, systemdUnit(cfg));
    mustRun("systemctl", ["--user", "daemon-reload"], "systemd daemon-reload");
    mustRun("systemctl", ["--user", "enable", "--now", `${cfg.name}.service`], "systemd enable --now");
  },
  uninstall(cfg) {
    run("systemctl", ["--user", "disable", "--now", `${cfg.name}.service`]);
    fs.rmSync(systemdUnitPath(cfg.name), { force: true });
    run("systemctl", ["--user", "daemon-reload"]);
  },
  start(cfg) {
    mustRun("systemctl", ["--user", "start", `${cfg.name}.service`], "systemd start");
  },
  stop(cfg) {
    mustRun("systemctl", ["--user", "stop", `${cfg.name}.service`], "systemd stop");
  },
  restart(cfg) {
    mustRun("systemctl", ["--user", "restart", `${cfg.name}.service`], "systemd restart");
  },
  status(cfg) {
    const registered = fs.existsSync(systemdUnitPath(cfg.name));
    const active = run("systemctl", ["--user", "is-active", `${cfg.name}.service`]);
    return {
      registered,
      state: active.stdout || active.stderr || "unknown",
      location: systemdUnitPath(cfg.name),
    };
  },
};

function plistPath(name: string): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${launchdLabel(name)}.plist`);
}

function launchdTarget(name: string): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 501;
  return `gui/${uid}/${launchdLabel(name)}`;
}

function launchdDomain(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 501;
  return `gui/${uid}`;
}

const darwinBackend: Backend = {
  install(cfg) {
    const file = plistPath(cfg.name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    run("launchctl", ["bootout", launchdTarget(cfg.name)]); // ok to fail: not loaded yet
    fs.writeFileSync(file, launchdPlist(cfg));
    mustRun("launchctl", ["bootstrap", launchdDomain(), file], "launchctl bootstrap");
  },
  uninstall(cfg) {
    run("launchctl", ["bootout", launchdTarget(cfg.name)]);
    fs.rmSync(plistPath(cfg.name), { force: true });
  },
  start(cfg) {
    // Loading the agent starts it (RunAtLoad); if already loaded this is a no-op error we ignore.
    run("launchctl", ["bootstrap", launchdDomain(), plistPath(cfg.name)]);
    mustRun("launchctl", ["kickstart", launchdTarget(cfg.name)], "launchctl kickstart");
  },
  stop(cfg) {
    // KeepAlive would resurrect a killed process, so stop = unload. `start` reloads it.
    mustRun("launchctl", ["bootout", launchdTarget(cfg.name)], "launchctl bootout");
  },
  restart(cfg) {
    // After `stop` the agent is unloaded and there is no target to kickstart;
    // bootstrap first (a no-op error when already loaded), then kick.
    run("launchctl", ["bootstrap", launchdDomain(), plistPath(cfg.name)]);
    mustRun("launchctl", ["kickstart", "-k", launchdTarget(cfg.name)], "launchctl kickstart -k");
  },
  status(cfg) {
    const registered = fs.existsSync(plistPath(cfg.name));
    const print = run("launchctl", ["print", launchdTarget(cfg.name)]);
    let state = "not loaded";
    if (print.ok) {
      const m = print.stdout.match(/state = (\w+)/);
      state = m ? m[1] : "loaded";
    }
    return { registered, state, location: plistPath(cfg.name) };
  },
};

function powershell(script: string): RunResult {
  // -EncodedCommand sidesteps every layer of Windows command-line re-quoting:
  // the script arrives byte-identical no matter what characters it contains.
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded]);
}

const windowsBackend: Backend = {
  install(cfg) {
    const r = powershell(windowsInstallScript(cfg));
    if (!r.ok) throw new Error(`Register-ScheduledTask failed: ${r.stderr || r.stdout}`);
    const s = powershell(`Start-ScheduledTask -TaskName ${psQuote(cfg.name)}`);
    if (!s.ok) throw new Error(`Start-ScheduledTask failed: ${s.stderr || s.stdout}`);
  },
  uninstall(cfg) {
    powershell(windowsStopScript(cfg));
    powershell(`Unregister-ScheduledTask -TaskName ${psQuote(cfg.name)} -Confirm:$false`);
  },
  start(cfg) {
    const r = powershell(`Start-ScheduledTask -TaskName ${psQuote(cfg.name)}`);
    if (!r.ok) throw new Error(`Start-ScheduledTask failed: ${r.stderr || r.stdout}`);
  },
  stop(cfg) {
    const r = powershell(windowsStopScript(cfg));
    if (!r.ok) throw new Error(`stopping the task failed: ${r.stderr || r.stdout}`);
  },
  restart(cfg) {
    windowsBackend.stop(cfg);
    windowsBackend.start(cfg);
  },
  status(cfg) {
    const r = powershell(`(Get-ScheduledTask -TaskName ${psQuote(cfg.name)} -ErrorAction Stop).State`);
    if (!r.ok) return { registered: false, state: "not registered", location: `Scheduled Task "${cfg.name}"` };
    return { registered: true, state: r.stdout || "unknown", location: `Scheduled Task "${cfg.name}"` };
  },
};

function backend(): Backend {
  switch (process.platform) {
    case "linux":
      return linuxBackend;
    case "darwin":
      return darwinBackend;
    case "win32":
      return windowsBackend;
    default:
      throw new Error(
        `no service backend for platform "${process.platform}". ` +
        `Run the server under your own supervisor: node ${path.join(__dirname, "server.mjs")}`,
      );
  }
}

// ---------- health ----------

export interface HealthReport {
  ok: boolean;
  url: string;
  version?: string;
  pid?: number;
  uptime_seconds?: number;
  port?: number;
  content_port?: number;
  content_plane_ok?: boolean;
  error?: string;
}

export function localVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    return String(pkg.version || "unknown");
  } catch {
    return "unknown";
  }
}

function probeTcp(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (v: boolean) => {
      sock.destroy();
      resolve(v);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(2000, () => done(false));
  });
}

// A concrete --bind address must be probed where the server actually listens;
// wildcard binds are reachable on loopback anyway.
export function healthHost(bind?: string): string {
  if (!bind || bind === "0.0.0.0" || bind === "::" || bind === "[::]") return "127.0.0.1";
  return bind;
}

function hostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export async function checkHealth(port: number, host = "127.0.0.1"): Promise<HealthReport> {
  const url = `http://${hostForUrl(host)}:${port}/healthz`;
  let body: any;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { ok: false, url, error: `HTTP ${res.status}` };
    body = await res.json();
  } catch (err: any) {
    return { ok: false, url, error: err?.cause?.code || err?.message || String(err) };
  }
  if (body?.ok !== true) return { ok: false, url, error: "healthz returned ok !== true" };
  const contentOk = typeof body.content_port === "number" ? await probeTcp(body.content_port, host) : false;
  return {
    ok: contentOk,
    url,
    version: body.version,
    pid: body.pid,
    uptime_seconds: body.uptime_seconds,
    port: body.port,
    content_port: body.content_port,
    content_plane_ok: contentOk,
    error: contentOk ? undefined : `content plane on :${body.content_port} not accepting connections`,
  };
}

async function waitHealthy(port: number, timeoutSec: number, host = "127.0.0.1"): Promise<HealthReport> {
  const deadline = Date.now() + timeoutSec * 1000;
  let last: HealthReport = { ok: false, url: "", error: "not attempted" };
  for (;;) {
    last = await checkHealth(port, host);
    if (last.ok || Date.now() > deadline) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
}

// ---------- logs ----------

function readLastLines(file: string, count: number): string {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return "";
  }
  try {
    const size = fs.fstatSync(fd).size;
    const span = Math.min(size, 128 * 1024);
    const buf = Buffer.alloc(span);
    fs.readSync(fd, buf, 0, span, size - span);
    const lines = buf.toString("utf8").split("\n").filter((l) => l !== "");
    return lines.slice(-count).join("\n");
  } finally {
    fs.closeSync(fd);
  }
}

async function followFile(file: string): Promise<never> {
  let offset = fs.existsSync(file) ? fs.statSync(file).size : 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, 500));
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      continue;
    }
    if (size < offset) offset = 0; // rotated/truncated
    if (size > offset) {
      const stream = fs.createReadStream(file, { start: offset, end: size - 1 });
      for await (const chunk of stream) process.stdout.write(chunk);
      offset = size;
    }
  }
}

// ---------- command entry ----------

export const SERVICE_HELP = [
  "surface service install    register + start the background service, then health-gate it",
  "surface service uninstall  stop + remove the service (data in ~/.surface is kept)",
  "surface service start|stop|restart",
  "surface service status     supervisor view: registered? running? where?",
  "surface service health     service view: /healthz + content-plane probe (exit 0/1)",
  "surface service logs       [--lines <n>] [--follow] read ~/.surface/logs/<name>.log",
  "",
  "Options: --name <svc> --port <n> --content-port <n> --bind <addr> --data-dir <dir>",
  "         --timeout <s> (install/restart health gate, default 20) --json --lines <n> --follow",
  "",
  "install remembers its flags per --name (~/.surface/services/<name>.json);",
  "every other subcommand reuses them, so flags never need repeating.",
  "",
  "Backends: systemd user unit (Linux), launchd LaunchAgent (macOS), Scheduled Task (Windows).",
].join("\n");

interface ServiceCtx {
  positional: string[];
  flags: Record<string, string | boolean>;
}

// `install` remembers its resolved flags here so every later subcommand
// (stop, uninstall, logs, health, …) operates on the service as installed —
// nobody should have to repeat --port/--data-dir to tear down what they set
// up. The registry lives in the *default* data dir on purpose: it's CLI-side
// metadata keyed by --name, findable without knowing the custom data dir.
function savedConfigPath(name: string): string {
  return path.join(os.homedir(), ".surface", "services", `${name}.json`);
}

interface SavedConfig {
  port?: number;
  contentPort?: number;
  bind?: string;
  dataDir?: string;
}

function loadSavedConfig(name: string): SavedConfig {
  try {
    return JSON.parse(fs.readFileSync(savedConfigPath(name), "utf8"));
  } catch {
    return {};
  }
}

// The skill/upgrade side (bin/upgrade.ts) anchors the canonical SKILL.md in
// the same data dir the service actually uses — saved config beats
// SURFACE_DATA_DIR, matching resolveConfig below.
export function savedServiceDataDir(name = "surface"): string | undefined {
  return loadSavedConfig(name).dataDir;
}

export function saveServiceConfig(cfg: ServiceConfig): void {
  const file = savedConfigPath(cfg.name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const saved: SavedConfig = {
    port: cfg.port,
    contentPort: cfg.contentPort,
    bind: cfg.bind,
    dataDir: cfg.dataDir,
  };
  fs.writeFileSync(file, JSON.stringify(saved, null, 2) + "\n");
}

function removeServiceConfig(name: string): void {
  fs.rmSync(savedConfigPath(name), { force: true });
}

function resolveConfig(flags: Record<string, string | boolean>): ServiceConfig {
  const name = typeof flags.name === "string" ? flags.name : "surface";
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(name)) {
    throw new Error(`invalid --name "${name}" (letters, digits, hyphens)`);
  }
  const saved = loadSavedConfig(name);
  const dataDir = typeof flags["data-dir"] === "string"
    ? path.resolve(String(flags["data-dir"]))
    : saved.dataDir
      ? saved.dataDir
      : process.env.SURFACE_DATA_DIR
        ? path.resolve(process.env.SURFACE_DATA_DIR)
        : path.join(os.homedir(), ".surface");
  const bundled = path.join(__dirname, "server.mjs");
  const entry = fs.existsSync(bundled) ? bundled : path.join(__dirname, "..", "dist", "server.mjs");
  const port = typeof flags.port === "string" ? Number(flags.port) : saved.port ?? 3000;
  const contentPort = typeof flags["content-port"] === "string"
    ? Number(flags["content-port"])
    : saved.contentPort;
  return {
    name,
    node: process.execPath,
    entry,
    dataDir,
    logFile: path.join(dataDir, "logs", `${name}.log`),
    port,
    contentPort,
    bind: typeof flags.bind === "string" ? flags.bind : saved.bind,
  };
}

// Is the skill copy agents read in sync with the package's SKILL.md?
// "stale" = provably our old content (hash matches skill_sha256 in
// install-state — upgrade will converge it); "edited" = the user changed it
// (or its provenance is unknown) — upgrade keeps it.
function skillCopyState(cfg: ServiceConfig): { path: string; state: "ok" | "stale" | "edited" | "missing" | "unknown" } {
  const copy = path.join(cfg.dataDir, "skills", "surface", "SKILL.md");
  try {
    const pkgSkill = fs.readFileSync(path.join(__dirname, "..", "SKILL.md"));
    if (!fs.existsSync(copy)) return { path: copy, state: "missing" };
    const cur = fs.readFileSync(copy);
    if (cur.equals(pkgSkill)) return { path: copy, state: "ok" };
    let recorded: unknown;
    try {
      recorded = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, "install-state.json"), "utf8")).skill_sha256;
    } catch {
      // no state file — unknown provenance
    }
    const mine = createHash("sha256").update(cur).digest("hex");
    return { path: copy, state: recorded === mine ? "stale" : "edited" };
  } catch {
    return { path: copy, state: "unknown" };
  }
}

// Supervisor states that mean "an operator stopped this on purpose":
// systemd `inactive`, launchd unloaded (stop = bootout), Scheduled Task
// Ready/Disabled. Crashed/hung states are NOT here — those still restart.
const STOPPED_STATES = new Set(["inactive", "not loaded", "ready", "disabled"]);

// Converge the running service onto the installed package version: restart
// only when a service is registered AND it reports a different version than
// this CLI (the post-`npm update -g` blind spot). A cleanly stopped service
// stays stopped — upgrade converges versions, it never overrides an
// operator's stop. Used by `surface upgrade`.
export async function restartServiceIfStale(
  timeoutSec = 20,
  name?: string,
): Promise<{ installed: boolean; restarted: boolean; version?: string; state?: string; error?: string }> {
  const cfg = resolveConfig(name ? { name } : {});
  const st = backend().status(cfg);
  if (!st.registered) return { installed: false, restarted: false };
  if (STOPPED_STATES.has(st.state.trim().toLowerCase())) {
    return { installed: true, restarted: false, state: st.state };
  }
  const mine = localVersion();
  const before = await checkHealth(cfg.port, healthHost(cfg.bind));
  if (before.ok && mine !== "unknown" && before.version === mine) {
    return { installed: true, restarted: false, version: before.version };
  }
  backend().restart(cfg);
  const health = await waitHealthy(cfg.port, timeoutSec, healthHost(cfg.bind));
  if (!health.ok) return { installed: true, restarted: true, error: String(health.error) };
  return { installed: true, restarted: true, version: health.version };
}

export async function runService({ positional, flags }: ServiceCtx): Promise<void> {
  const sub = positional[0];
  if (sub === "update" || sub === "upgrade") {
    console.error("did you mean: surface upgrade — updates the package, refreshes the skill, and restarts the service");
    process.exit(2);
  }
  const subs = ["install", "uninstall", "start", "stop", "restart", "status", "health", "logs"];
  if (!sub || !subs.includes(sub)) {
    console.error(`usage:\n${SERVICE_HELP}`);
    process.exit(2);
  }
  const cfg = resolveConfig(flags);
  const timeoutSec = typeof flags.timeout === "string" ? Number(flags.timeout) : 20;
  const json = flags.json === true;

  switch (sub) {
    case "install": {
      if (!fs.existsSync(cfg.entry)) {
        throw new Error(`server bundle not found at ${cfg.entry} (run npm run build in the repo, or reinstall the package)`);
      }
      fs.mkdirSync(path.join(cfg.dataDir, "logs"), { recursive: true });
      const b = backend();
      const existing = b.status(cfg);
      if (!existing.registered) {
        // A live server we don't supervise would fight this install for the
        // ports. Refuse rather than sabotage it — the Codex-on-Windows lesson.
        const already = await checkHealth(cfg.port, healthHost(cfg.bind));
        if (already.ok || (already.error && !/ECONNREFUSED|fetch failed|timeout/i.test(String(already.error)))) {
          throw new Error(
            `something is already answering on 127.0.0.1:${cfg.port}` +
            (already.version ? ` (Surface ${already.version}, not supervised by "${cfg.name}")` : "") +
            `. Reuse it, or stop it before installing.`,
          );
        }
      }
      // Reinstall/upgrade: stop the old process so the new definition takes
      // effect on start (systemd won't re-exec a running unit on enable --now).
      if (existing.registered) {
        try {
          b.stop(cfg);
        } catch {
          // already stopped
        }
      }
      b.install(cfg);
      saveServiceConfig(cfg);
      const health = await waitHealthy(cfg.port, timeoutSec, healthHost(cfg.bind));
      if (!health.ok) {
        const tail = readLastLines(cfg.logFile, 10);
        console.error(`service registered but not healthy after ${timeoutSec}s: ${health.error}`);
        if (tail) console.error(`--- last log lines (${cfg.logFile}) ---\n${tail}`);
        console.error(`inspect with: surface service logs${cfg.name === "surface" ? "" : ` --name ${cfg.name}`}`);
        process.exit(1);
      }
      const st = b.status(cfg);
      console.log(`surface service installed and healthy`);
      console.log(`  supervisor : ${st.location}`);
      console.log(`  server     : http://127.0.0.1:${health.port}  (content plane :${health.content_port})`);
      console.log(`  version    : ${health.version}`);
      console.log(`  data       : ${cfg.dataDir}`);
      console.log(`  logs       : ${cfg.logFile}`);
      return;
    }
    case "uninstall": {
      backend().uninstall(cfg);
      removeServiceConfig(cfg.name);
      console.log(`surface service "${cfg.name}" removed. Data kept at ${cfg.dataDir}.`);
      return;
    }
    case "start": {
      backend().start(cfg);
      console.log(`started "${cfg.name}"`);
      return;
    }
    case "stop": {
      backend().stop(cfg);
      console.log(`stopped "${cfg.name}"`);
      return;
    }
    case "restart": {
      backend().restart(cfg);
      const health = await waitHealthy(cfg.port, timeoutSec, healthHost(cfg.bind));
      if (!health.ok) {
        console.error(`restarted but not healthy after ${timeoutSec}s: ${health.error}`);
        process.exit(1);
      }
      console.log(`restarted "${cfg.name}" (version ${health.version}, pid ${health.pid})`);
      return;
    }
    case "status": {
      const st = backend().status(cfg);
      if (json) {
        console.log(JSON.stringify({ ...st, log_file: cfg.logFile, data_dir: cfg.dataDir }, null, 2));
      } else {
        console.log(`registered : ${st.registered ? "yes" : "no"} (${st.location})`);
        console.log(`state      : ${st.state}`);
        console.log(`logs       : ${cfg.logFile}`);
      }
      process.exit(st.registered && /running|active/i.test(st.state) ? 0 : 1);
    }
    case "health": {
      const health = await checkHealth(cfg.port, healthHost(cfg.bind));
      const mine = localVersion();
      const skill = skillCopyState(cfg);
      if (json) {
        console.log(JSON.stringify({ ...health, cli_version: mine, skill_copy: skill.path, skill_copy_state: skill.state }, null, 2));
      } else if (health.ok) {
        console.log(`healthy: Surface ${health.version} on :${health.port} (content :${health.content_port}), pid ${health.pid}, up ${health.uptime_seconds}s`);
      } else {
        console.error(`unhealthy: ${health.error} (${health.url})`);
      }
      if (!json) {
        // The npm-upgrade blind spot: package updated, service still running old code.
        if (health.ok && mine !== "unknown" && health.version !== mine) {
          console.error(`note: this CLI is ${mine} but the running service is ${health.version} — run: surface upgrade`);
        }
        // Same blind spot for the skill: the copy agents read must match the package.
        if (skill.state === "stale" || skill.state === "missing") {
          console.error(`note: skill copy at ${skill.path} is ${skill.state} — run: surface upgrade (or: surface skill install)`);
        } else if (skill.state === "edited") {
          console.error(`note: skill copy at ${skill.path} is locally edited — kept; surface skill install --force replaces it`);
        }
      }
      process.exit(health.ok ? 0 : 1);
    }
    case "logs": {
      const lines = typeof flags.lines === "string" ? Number(flags.lines) : 50;
      if (!fs.existsSync(cfg.logFile)) {
        console.error(`no log file at ${cfg.logFile} yet`);
        process.exit(1);
      }
      const tail = readLastLines(cfg.logFile, lines);
      if (tail) console.log(tail);
      if (flags.follow === true) await followFile(cfg.logFile);
      return;
    }
  }
}
