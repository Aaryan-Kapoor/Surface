// surface skill install / surface upgrade — the self-maintenance pair.
//
// The skill model: one canonical copy of SKILL.md lives in the data dir
// (<data-dir>/skills/surface/SKILL.md) and every agent harness gets a
// directory link (junction on Windows) pointing at it. `surface upgrade`
// refreshes the canonical copy from the installed package, so the skill text
// every harness reads is always the one matching the installed binary.
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { localVersion, restartServiceIfStale } from "./service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface Ctx {
  positional: string[];
  flags: Record<string, string | boolean>;
  multi: Record<string, string[]>;
}

// ── paths ──

export function packageRoot(): string {
  // dist/surface.mjs in the installed package, bin/upgrade.ts in a clone —
  // SKILL.md and package.json sit next to the parent either way.
  return fs.realpathSync(path.join(__dirname, ".."));
}

function packageSkillPath(): string {
  return path.join(packageRoot(), "SKILL.md");
}

export function dataDir(): string {
  return process.env.SURFACE_DATA_DIR
    ? path.resolve(process.env.SURFACE_DATA_DIR)
    : path.join(os.homedir(), ".surface");
}

export function canonicalSkillDir(base = dataDir()): string {
  return path.join(base, "skills", "surface");
}

function defaultTargets(): string[] {
  // Two links cover the ecosystem: ~/.agents/skills is the open standard
  // (agentskills.io — Codex, Cursor, Gemini CLI, Copilot, Zed, Amp, Goose,
  // OpenCode, Roo, Kilo, Windsurf); ~/.claude/skills is Claude Code, which
  // does not read ~/.agents/. Harness-native dirs go through --to.
  return [
    path.join(os.homedir(), ".agents", "skills"),
    path.join(os.homedir(), ".claude", "skills"),
  ];
}

// ── skill sync ──

interface LinkResult {
  path: string;
  mode: "linked" | "copied" | "kept" | "skipped";
  note?: string;
}

interface SkillReport {
  canonical: string;
  version: string;
  updated: boolean;
  links: LinkResult[];
}

function syncCanonical(): { canonical: string; updated: boolean } {
  const src = packageSkillPath();
  if (!fs.existsSync(src)) {
    throw new Error(`SKILL.md not found at ${src} (broken install?)`);
  }
  const dir = canonicalSkillDir();
  const dest = path.join(dir, "SKILL.md");
  const next = fs.readFileSync(src);
  const prev = fs.existsSync(dest) ? fs.readFileSync(dest) : null;
  if (prev && prev.equals(next)) return { canonical: dest, updated: false };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dest, next);
  return { canonical: dest, updated: prev !== null };
}

function linksTo(target: string, canonical: string): boolean {
  try {
    return fs.realpathSync(target) === fs.realpathSync(canonical);
  } catch {
    return false;
  }
}

function copyInto(target: string): void {
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(packageSkillPath(), path.join(target, "SKILL.md"));
}

// Ensure <skillsDir>/surface is a link to the canonical dir (or a managed
// copy). Refuses to replace a directory holding anything besides SKILL.md —
// that is someone else's skill.
function ensureTarget(skillsDir: string, canonicalDir: string, copy: boolean): LinkResult {
  const target = path.join(skillsDir, "surface");
  let st: fs.Stats | null = null;
  try {
    st = fs.lstatSync(target);
  } catch {
    st = null;
  }

  if (st?.isSymbolicLink()) {
    if (!copy && linksTo(target, canonicalDir)) return { path: target, mode: "kept" };
    fs.unlinkSync(target); // rmSync throws EISDIR on a symlink-to-directory
    st = null;
  } else if (st?.isDirectory()) {
    const entries = fs.readdirSync(target).filter((e) => e !== "SKILL.md");
    if (entries.length > 0) {
      return { path: target, mode: "skipped", note: `contains other files (${entries[0]}…) — not managed by surface` };
    }
    if (copy) {
      copyInto(target);
      return { path: target, mode: "copied" };
    }
    fs.rmSync(target, { recursive: true, force: true });
    st = null;
  } else if (st) {
    return { path: target, mode: "skipped", note: "exists and is not a directory or symlink" };
  }

  fs.mkdirSync(skillsDir, { recursive: true });
  if (copy) {
    copyInto(target);
    return { path: target, mode: "copied" };
  }
  try {
    fs.symlinkSync(canonicalDir, target, process.platform === "win32" ? "junction" : "dir");
    return { path: target, mode: "linked" };
  } catch (e: any) {
    // Symlinks can be forbidden (e.g. Windows without developer mode) —
    // fall back to a managed copy; upgrade rewrites it from install-state.
    copyInto(target);
    return { path: target, mode: "copied", note: `symlink failed (${e?.code || e}), copied instead` };
  }
}

// ── install-state.json (the agent bootstrap contract in INSTALL_FOR_AGENTS.md) ──

function installStatePath(): string {
  return path.join(dataDir(), "install-state.json");
}

function readInstallState(): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(installStatePath(), "utf8"));
  } catch (e: any) {
    if (e?.code === "ENOENT") return {
      service: "pending",
      skill_saved_to: null,
      tutorial: "pending",
      surface_version: null,
      installed_at: null,
      notes: null,
    };
    return null; // corrupt — leave it alone
  }
}

function recordSkillState(report: SkillReport): void {
  const state = readInstallState();
  if (!state) return;
  state.skill_saved_to = report.canonical;
  state.skill_links = report.links
    .filter((l) => l.mode !== "skipped")
    .map((l) => ({ path: l.path, mode: l.mode === "copied" ? "copy" : "link" }));
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(installStatePath(), JSON.stringify(state, null, 2) + "\n");
}

function recordedLinks(): { path: string; mode: string }[] {
  const state = readInstallState();
  const links = (state as any)?.skill_links;
  return Array.isArray(links) ? links.filter((l) => typeof l?.path === "string") : [];
}

export function syncSkill(extraTo: string[], copy: boolean): SkillReport {
  const { canonical, updated } = syncCanonical();
  const canonicalDir = path.dirname(canonical);
  // Union: defaults + explicit --to + everything recorded by earlier installs
  // (so copies made where symlinks failed keep getting refreshed).
  const targets = new Map<string, boolean>(); // skillsDir -> copy?
  for (const dir of defaultTargets()) targets.set(path.resolve(dir), copy);
  for (const dir of extraTo) targets.set(path.resolve(dir), copy);
  for (const l of recordedLinks()) {
    const skillsDir = path.dirname(path.resolve(l.path));
    if (!targets.has(skillsDir)) targets.set(skillsDir, l.mode === "copy");
  }
  const links: LinkResult[] = [];
  for (const [skillsDir, asCopy] of targets) {
    if (path.resolve(path.join(skillsDir, "surface")) === path.resolve(canonicalDir)) continue;
    links.push(ensureTarget(skillsDir, canonicalDir, asCopy));
  }
  const report: SkillReport = { canonical, version: localVersion(), updated, links };
  recordSkillState(report);
  return report;
}

export function skillFresh(): { canonical: string; fresh: boolean } {
  const dest = path.join(canonicalSkillDir(), "SKILL.md");
  try {
    return { canonical: dest, fresh: fs.readFileSync(dest).equals(fs.readFileSync(packageSkillPath())) };
  } catch {
    return { canonical: dest, fresh: false };
  }
}

// ── surface skill install ──

export async function runSkill({ positional, flags, multi }: Ctx): Promise<void> {
  if (positional[0] !== "install") {
    console.error("usage: surface skill install [--to <skills-dir>]... [--copy] [--json]");
    process.exit(2);
  }
  const report = syncSkill(multi.to || [], flags.copy === true);
  if (flags.json === true) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`skill ${report.version} → ${report.canonical}${report.updated ? " (updated)" : ""}`);
  for (const l of report.links) {
    console.log(`  ${l.mode.padEnd(7)} ${l.path}${l.note ? `  (${l.note})` : ""}`);
  }
}

// ── surface upgrade ──

function registryUrl(): string {
  return (process.env.SURFACE_NPM_REGISTRY || "https://registry.npmjs.org").replace(/\/$/, "");
}

async function latestVersion(): Promise<string> {
  const url = `${registryUrl()}/surface-display/latest`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  } catch (e: any) {
    throw new Error(`could not reach the npm registry at ${url} (${e?.cause?.code || e?.code || e?.message || e})`);
  }
  if (!res.ok) throw new Error(`registry answered ${res.status} for ${url}`);
  const body: any = await res.json();
  if (typeof body?.version !== "string") throw new Error(`no version in registry response from ${url}`);
  return body.version;
}

function newerThan(a: string, b: string): boolean {
  const parse = (v: string) => v.split(/[.+-]/, 3).map((n) => Number(n) || 0);
  const [a0, a1, a2] = parse(a);
  const [b0, b1, b2] = parse(b);
  return a0 !== b0 ? a0 > b0 : a1 !== b1 ? a1 > b1 : a2 > b2;
}

type InstallContext = "global" | "local" | "dev";

function npmCmd(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function installContext(): InstallContext {
  const root = packageRoot();
  if (path.basename(path.dirname(root)) !== "node_modules") return "dev";
  const probe = spawnSync(npmCmd(), ["root", "-g"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const globalRoot = probe.status === 0 ? probe.stdout.trim() : "";
  try {
    if (globalRoot && root.startsWith(fs.realpathSync(globalRoot))) return "global";
  } catch {
    // global root missing — treat as local
  }
  return "local";
}

export async function runUpgrade({ flags }: Ctx): Promise<void> {
  const json = flags.json === true;
  const timeoutSec = typeof flags.timeout === "string" ? Number(flags.timeout) : 30;
  const current = localVersion();
  const latest = await latestVersion();
  const available = newerThan(latest, current);
  const context = installContext();

  if (flags.check === true) {
    const skill = skillFresh();
    const report = { current, latest, update_available: available, context, skill };
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(available ? `update available: ${current} → ${latest}` : `up to date (${current})`);
      if (!skill.fresh) console.log(`skill copy stale/missing at ${skill.canonical} — run: surface upgrade`);
      if (available && context !== "global") console.log(contextAdvice(context));
    }
    return;
  }

  let installed = current;
  let packageStep = "unchanged";
  if (available && context === "global") {
    const res = spawnSync(npmCmd(), ["install", "-g", `surface-display@${latest}`], {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    if (res.status !== 0) {
      console.error(`npm install -g surface-display@${latest} failed (exit ${res.status ?? "?"})`);
      process.exit(1);
    }
    // npm replaced the package in place; re-read the version from disk.
    installed = localVersion();
    packageStep = `updated ${current} → ${installed}`;
  } else if (available) {
    packageStep = `skipped (${context} install)`;
  }

  // Always converge skill + service, even when already on the latest version —
  // this is what finishes a manual `npm update -g` someone ran without us.
  const skill = syncSkill([], false);
  const service = await restartServiceIfStale(timeoutSec, typeof flags.name === "string" ? flags.name : undefined);

  const report = { previous: current, installed, latest, package: packageStep, context, skill, service };
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(available && packageStep.startsWith("updated") ? packageStep : `package: ${packageStep === "unchanged" ? `up to date (${current})` : packageStep}`);
  if (available && context !== "global") console.log(contextAdvice(context));
  console.log(`skill  : ${skill.version} → ${skill.canonical}${skill.updated ? " (updated)" : ""}`);
  for (const l of skill.links) console.log(`  ${l.mode.padEnd(7)} ${l.path}${l.note ? `  (${l.note})` : ""}`);
  if (!service.installed) console.log("service: not installed here — skipped");
  else if (!service.restarted) console.log(`service: already on ${service.version} — no restart needed`);
  else if (service.error) {
    console.error(`service: restarted but not healthy — ${service.error}`);
    process.exit(1);
  } else console.log(`service: restarted, now ${service.version}`);
}

function contextAdvice(context: InstallContext): string {
  return context === "dev"
    ? "this is a repo clone — update with: git pull && npm install && npm test"
    : "surface-display is installed locally here — update with: npm update surface-display (in that project)";
}
