import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const CODEX_LAUNCHER_MARKER = "Surface Codex launcher";

const NON_INTERACTIVE_COMMANDS = new Set([
  "exec", "e", "review", "login", "logout", "mcp", "plugin", "mcp-server",
  "app-server", "remote-control", "app", "completion", "update", "doctor",
  "sandbox", "debug", "apply", "a", "cloud", "exec-server", "features", "help",
]);
const GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "-c", "--config", "--enable", "--disable", "--remote", "--remote-auth-token-env",
  "-i", "--image", "-m", "--model", "--local-provider", "-p", "--profile",
  "-s", "--sandbox", "-C", "--cd", "--add-dir", "-a", "--ask-for-approval",
]);

interface LauncherRecord {
  path: string;
  backup?: string;
  kind?: "file" | "symlink";
  symlink_target?: string;
  original_sha256: string;
  wrapper_sha256: string;
  mode: number;
}

export interface CodexLauncherManifest {
  version: 1;
  target: { command: string; args: string[] };
  remote_endpoint?: string;
  proxy: string;
  launchers: LauncherRecord[];
  installed_at: string;
}

interface InstallOptions {
  dataDir: string;
  launcherPath?: string;
  proxySource: string;
  nodeBinary?: string;
  remoteEndpoint?: string;
}

function sha256(value: Buffer | string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function codexLauncherManifestPath(dataDir: string): string {
  return path.join(dataDir, "codex-launcher.json");
}

export function readCodexLauncherManifest(dataDir: string): CodexLauncherManifest | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(codexLauncherManifestPath(dataDir), "utf8"));
    if (parsed?.version !== 1 || !Array.isArray(parsed.launchers) || typeof parsed?.target?.command !== "string") return null;
    return parsed as CodexLauncherManifest;
  } catch {
    return null;
  }
}

export function codexLauncherStatus(dataDir: string): { installed: boolean; healthy: boolean; launchers: string[] } {
  const manifest = readCodexLauncherManifest(dataDir);
  if (!manifest) return { installed: false, healthy: false, launchers: [] };
  const healthy = manifest.launchers.every((record) => {
    try {
      const current = fs.readFileSync(record.path);
      return sha256(current) === record.wrapper_sha256 && current.toString("utf8").includes(CODEX_LAUNCHER_MARKER);
    } catch {
      return false;
    }
  });
  return { installed: true, healthy, launchers: manifest.launchers.map((record) => record.path) };
}

export function routeCodexArgs(args: string[], endpoint: string): string[] {
  const bypass = args.includes("--no-surface");
  const cleaned = args.filter((arg) => arg !== "--no-surface");
  if (!shouldAttachCodex(args)) return cleaned;
  return ["--remote", endpoint, ...cleaned];
}

export function shouldAttachCodex(args: string[]): boolean {
  if (args.includes("--no-surface") || args.includes("--remote") || args.some((arg) => arg.startsWith("--remote="))) return false;
  if (args.some((arg) => arg === "--version" || arg === "-V" || arg === "--help" || arg === "-h")) return false;
  let command: string | null = null;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") break;
    if (GLOBAL_OPTIONS_WITH_VALUE.has(arg)) { index++; continue; }
    if (arg.startsWith("-")) continue;
    command = arg;
    break;
  }
  if (command && NON_INTERACTIVE_COMMANDS.has(command)) return false;
  return true;
}

function discoverWindowsLauncher(): string {
  const output = execFileSync("where.exe", ["codex.cmd"], { encoding: "utf8", windowsHide: true });
  const found = output.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!found) throw new Error("could not locate codex.cmd on PATH");
  return found;
}

function discoverPosixLauncher(): string {
  const output = execFileSync("sh", ["-lc", "command -v codex"], { encoding: "utf8" }).trim();
  if (!output) throw new Error("could not locate codex on PATH");
  return output.split(/\r?\n/)[0];
}

function launcherFamily(primary: string): string[] {
  if (process.platform !== "win32" && !/\.cmd$/i.test(primary)) return [primary];
  const base = primary.replace(/\.(cmd|ps1)$/i, "");
  return [base, `${base}.cmd`, `${base}.ps1`].filter((candidate) => fs.existsSync(candidate));
}

function resolveTarget(primary: string, nodeBinary: string): { command: string; args: string[] } {
  if (fs.lstatSync(primary).isSymbolicLink()) return { command: fs.realpathSync(primary), args: [] };
  const bytes = fs.readFileSync(primary, "utf8");
  const match = /node_modules[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.js/i.exec(bytes);
  if (match) {
    const script = path.join(path.dirname(primary), ...match[0].split(/[\\/]/));
    if (!fs.existsSync(script)) throw new Error(`the Codex package target does not exist: ${script}`);
    return { command: nodeBinary, args: [script] };
  }
  const real = fs.realpathSync(primary);
  if (real !== path.resolve(primary)) return { command: real, args: [] };
  throw new Error(`unsupported Codex launcher at ${primary}; expected an npm shim or symlink`);
}

function escapePs(value: string): string {
  return value.replace(/'/g, "''");
}

function escapeSh(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function wrapperFor(launcher: string, node: string, proxy: string, manifest: string): string {
  if (/\.cmd$/i.test(launcher)) {
    return `@ECHO OFF\r\nREM ${CODEX_LAUNCHER_MARKER}\r\n"${node}" "${proxy}" --surface-launcher-config "${manifest}" -- %*\r\n`;
  }
  if (/\.ps1$/i.test(launcher)) {
    return `#!/usr/bin/env pwsh\n# ${CODEX_LAUNCHER_MARKER}\nif ($MyInvocation.ExpectingInput) {\n  $input | & '${escapePs(node)}' '${escapePs(proxy)}' --surface-launcher-config '${escapePs(manifest)}' -- @args\n} else {\n  & '${escapePs(node)}' '${escapePs(proxy)}' --surface-launcher-config '${escapePs(manifest)}' -- @args\n}\nexit $LASTEXITCODE\n`;
  }
  return `#!/bin/sh\n# ${CODEX_LAUNCHER_MARKER}\nexec ${escapeSh(node)} ${escapeSh(proxy)} --surface-launcher-config ${escapeSh(manifest)} -- "$@"\n`;
}

function writeJsonAtomic(target: string, value: unknown): void {
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, target);
}

export function installCodexLauncher(options: InstallOptions): { changed: boolean; launchers: string[] } {
  const manifestPath = codexLauncherManifestPath(options.dataDir);
  const current = readCodexLauncherManifest(options.dataDir);
  if (current && current.launchers.every((entry) => {
    try { return fs.readFileSync(entry.path, "utf8").includes(CODEX_LAUNCHER_MARKER); } catch { return false; }
  })) {
    fs.copyFileSync(options.proxySource, current.proxy);
    try { fs.chmodSync(current.proxy, 0o755); } catch {}
    let manifestChanged = false;
    for (const record of current.launchers) {
      const installed = fs.readFileSync(record.path);
      if (sha256(installed) !== record.wrapper_sha256) {
        throw new Error(`Surface's Codex launcher was edited after setup; left untouched: ${record.path}`);
      }
      const desired = wrapperFor(record.path, options.nodeBinary || process.execPath, current.proxy, manifestPath);
      const desiredHash = sha256(desired);
      if (desiredHash === record.wrapper_sha256) continue;
      fs.writeFileSync(record.path, desired);
      try { fs.chmodSync(record.path, record.mode); } catch {}
      record.wrapper_sha256 = desiredHash;
      manifestChanged = true;
    }
    if (manifestChanged) writeJsonAtomic(manifestPath, current);
    return { changed: false, launchers: current.launchers.map((entry) => entry.path) };
  }

  const primary = path.resolve(options.launcherPath || (process.platform === "win32" ? discoverWindowsLauncher() : discoverPosixLauncher()));
  const launchers = launcherFamily(primary);
  if (!launchers.length) throw new Error(`no Codex launchers found beside ${primary}`);
  if (launchers.some((entry) => fs.readFileSync(entry, "utf8").includes(CODEX_LAUNCHER_MARKER))) {
    throw new Error("a Surface Codex launcher exists without valid provenance; run `surface codex status` before repairing it");
  }

  fs.mkdirSync(options.dataDir, { recursive: true });
  const installDir = path.join(options.dataDir, "codex-launcher");
  const backupDir = path.join(installDir, "original");
  fs.mkdirSync(backupDir, { recursive: true });
  const proxy = path.join(installDir, "proxy.mjs");
  fs.copyFileSync(options.proxySource, proxy);
  try { fs.chmodSync(proxy, 0o755); } catch {}

  const target = resolveTarget(primary, options.nodeBinary || process.execPath);
  const records: LauncherRecord[] = [];
  for (let index = 0; index < launchers.length; index++) {
    const launcher = launchers[index];
    const stat = fs.lstatSync(launcher);
    const kind = stat.isSymbolicLink() ? "symlink" : "file";
    const symlinkTarget = kind === "symlink" ? fs.readlinkSync(launcher) : undefined;
    const original = kind === "symlink" ? Buffer.from(`symlink:${symlinkTarget}`) : fs.readFileSync(launcher);
    const backup = kind === "file" ? path.join(backupDir, `${index}-${path.basename(launcher)}`) : undefined;
    if (backup) fs.writeFileSync(backup, original);
    const mode = stat.mode;
    const wrapper = wrapperFor(launcher, options.nodeBinary || process.execPath, proxy, manifestPath);
    records.push({
      path: launcher,
      backup,
      kind,
      symlink_target: symlinkTarget,
      original_sha256: sha256(original),
      wrapper_sha256: sha256(wrapper),
      mode,
    });
  }
  const manifest: CodexLauncherManifest = {
    version: 1,
    target,
    remote_endpoint: options.remoteEndpoint,
    proxy,
    launchers: records,
    installed_at: new Date().toISOString(),
  };
  writeJsonAtomic(manifestPath, manifest);
  for (const record of records) {
    if (fs.lstatSync(record.path).isSymbolicLink()) fs.unlinkSync(record.path);
    fs.writeFileSync(record.path, wrapperFor(record.path, options.nodeBinary || process.execPath, proxy, manifestPath));
    try { fs.chmodSync(record.path, record.mode); } catch {}
  }
  return { changed: true, launchers };
}

export function removeCodexLauncher(dataDir: string): { changed: boolean; skipped: string[] } {
  const manifest = readCodexLauncherManifest(dataDir);
  if (!manifest) return { changed: false, skipped: [] };
  const skipped: string[] = [];
  let changed = false;
  for (const record of manifest.launchers) {
    let current: Buffer;
    try { current = fs.readFileSync(record.path); } catch { skipped.push(record.path); continue; }
    if (sha256(current) !== record.wrapper_sha256) {
      skipped.push(record.path);
      continue;
    }
    if (record.kind === "symlink") {
      if (!record.symlink_target) { skipped.push(record.path); continue; }
      fs.unlinkSync(record.path);
      fs.symlinkSync(record.symlink_target, record.path, process.platform === "win32" ? "file" : undefined);
    } else {
      if (!record.backup) { skipped.push(record.path); continue; }
      fs.copyFileSync(record.backup, record.path);
      try { fs.chmodSync(record.path, record.mode); } catch {}
    }
    changed = true;
  }
  if (!skipped.length) {
    try { fs.unlinkSync(codexLauncherManifestPath(dataDir)); } catch {}
  }
  return { changed, skipped };
}
