import { spawnSync } from "child_process";
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
  const inner = serverArgs(cfg)
    .map((a) => `\\"${a}\\"`)
    .join(" ");
  const argument = `--headless \\"${cfg.node}\\" ${inner}`;
  return [
    `$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "${argument}" -WorkingDirectory ${psQuote(cfg.dataDir)}`,
    `$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME`,
    `$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)`,
    `Register-ScheduledTask -TaskName ${psQuote(cfg.name)} -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null`,
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
  return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
}

const windowsBackend: Backend = {
  install(cfg) {
    const r = powershell(windowsInstallScript(cfg));
    if (!r.ok) throw new Error(`Register-ScheduledTask failed: ${r.stderr || r.stdout}`);
    const s = powershell(`Start-ScheduledTask -TaskName ${psQuote(cfg.name)}`);
    if (!s.ok) throw new Error(`Start-ScheduledTask failed: ${s.stderr || s.stdout}`);
  },
  uninstall(cfg) {
    powershell(`Stop-ScheduledTask -TaskName ${psQuote(cfg.name)} -ErrorAction SilentlyContinue`);
    powershell(`Unregister-ScheduledTask -TaskName ${psQuote(cfg.name)} -Confirm:$false`);
  },
  start(cfg) {
    const r = powershell(`Start-ScheduledTask -TaskName ${psQuote(cfg.name)}`);
    if (!r.ok) throw new Error(`Start-ScheduledTask failed: ${r.stderr || r.stdout}`);
  },
  stop(cfg) {
    const r = powershell(`Stop-ScheduledTask -TaskName ${psQuote(cfg.name)}`);
    if (!r.ok) throw new Error(`Stop-ScheduledTask failed: ${r.stderr || r.stdout}`);
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

function localVersion(): string {
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

export async function checkHealth(port: number): Promise<HealthReport> {
  const url = `http://127.0.0.1:${port}/healthz`;
  let body: any;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { ok: false, url, error: `HTTP ${res.status}` };
    body = await res.json();
  } catch (err: any) {
    return { ok: false, url, error: err?.cause?.code || err?.message || String(err) };
  }
  if (body?.ok !== true) return { ok: false, url, error: "healthz returned ok !== true" };
  const contentOk = typeof body.content_port === "number" ? await probeTcp(body.content_port) : false;
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

async function waitHealthy(port: number, timeoutSec: number): Promise<HealthReport> {
  const deadline = Date.now() + timeoutSec * 1000;
  let last: HealthReport = { ok: false, url: "", error: "not attempted" };
  for (;;) {
    last = await checkHealth(port);
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
  "Backends: systemd user unit (Linux), launchd LaunchAgent (macOS), Scheduled Task (Windows).",
].join("\n");

interface ServiceCtx {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function resolveConfig(flags: Record<string, string | boolean>): ServiceConfig {
  const name = typeof flags.name === "string" ? flags.name : "surface";
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(name)) {
    throw new Error(`invalid --name "${name}" (letters, digits, hyphens)`);
  }
  const dataDir = typeof flags["data-dir"] === "string"
    ? path.resolve(String(flags["data-dir"]))
    : process.env.SURFACE_DATA_DIR
      ? path.resolve(process.env.SURFACE_DATA_DIR)
      : path.join(os.homedir(), ".surface");
  const bundled = path.join(__dirname, "server.mjs");
  const entry = fs.existsSync(bundled) ? bundled : path.join(__dirname, "..", "dist", "server.mjs");
  const port = typeof flags.port === "string" ? Number(flags.port) : 3000;
  const contentPort = typeof flags["content-port"] === "string" ? Number(flags["content-port"]) : undefined;
  return {
    name,
    node: process.execPath,
    entry,
    dataDir,
    logFile: path.join(dataDir, "logs", `${name}.log`),
    port,
    contentPort,
    bind: typeof flags.bind === "string" ? flags.bind : undefined,
  };
}

export async function runService({ positional, flags }: ServiceCtx): Promise<void> {
  const sub = positional[0];
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
        const already = await checkHealth(cfg.port);
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
      const health = await waitHealthy(cfg.port, timeoutSec);
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
      const health = await waitHealthy(cfg.port, timeoutSec);
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
      const health = await checkHealth(cfg.port);
      if (json) {
        console.log(JSON.stringify(health, null, 2));
      } else if (health.ok) {
        console.log(`healthy: Surface ${health.version} on :${health.port} (content :${health.content_port}), pid ${health.pid}, up ${health.uptime_seconds}s`);
      } else {
        console.error(`unhealthy: ${health.error} (${health.url})`);
      }
      // The npm-upgrade blind spot: package updated, service still running old code.
      const mine = localVersion();
      if (health.ok && mine !== "unknown" && health.version !== mine) {
        console.error(`note: this CLI is ${mine} but the running service is ${health.version} — run: surface service restart`);
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
