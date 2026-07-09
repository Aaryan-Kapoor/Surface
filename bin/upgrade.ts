// surface skill install / surface upgrade — the self-maintenance pair.
//
// The skill model: one canonical copy of SKILL.md lives in the data dir
// (<data-dir>/skills/surface/SKILL.md) and every agent harness gets a
// directory link (junction on Windows) pointing at it. `surface upgrade`
// refreshes the canonical copy from the installed package, so the skill text
// every harness reads is always the one matching the installed binary.
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { localVersion, restartServiceIfStale, savedServiceDataDir } from "./service.js";

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

export function dataDir(name = "surface"): string {
  // Mirror resolveConfig in service.ts: the service's saved data dir wins,
  // then SURFACE_DATA_DIR, then ~/.surface — so the canonical skill copy and
  // install-state.json live where `surface service health` looks for them.
  const saved = savedServiceDataDir(name);
  if (saved) return saved;
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
  mode: "linked" | "copied" | "kept" | "skipped" | "failed";
  note?: string;
}

interface SkillReport {
  canonical: string;
  version: string;
  updated: boolean;
  edited: boolean;
  links: LinkResult[];
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

// Three canonical states, told apart by the hash of what WE last wrote
// (skill_sha256 in install-state): matches the package → fresh; matches the
// recorded hash → our stale copy, safe to overwrite; matches neither → the
// user edited it — keep it (links and copies then mirror the edit) until
// `surface skill install --force`. No recorded hash + mismatch counts as
// edited: unknown provenance is not ours to destroy.
function syncCanonical(base: string, force: boolean, recordedSha: string | null): { canonical: string; updated: boolean; edited: boolean } {
  const src = packageSkillPath();
  if (!fs.existsSync(src)) {
    throw new Error(`SKILL.md not found at ${src} (broken install?)`);
  }
  const dir = canonicalSkillDir(base);
  const dest = path.join(dir, "SKILL.md");
  const next = fs.readFileSync(src);
  const prev = fs.existsSync(dest) ? fs.readFileSync(dest) : null;
  if (prev && prev.equals(next)) return { canonical: dest, updated: false, edited: false };
  if (prev && !force && sha256(prev) !== recordedSha) {
    return { canonical: dest, updated: false, edited: true };
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dest, next);
  return { canonical: dest, updated: prev !== null, edited: false };
}

function linksTo(target: string, canonical: string): boolean {
  try {
    return fs.realpathSync(target) === fs.realpathSync(canonical);
  } catch {
    return false;
  }
}

// Managed copies mirror the CANONICAL file, not the package — so a kept
// user edit propagates to copy targets exactly like it does through links.
function copyInto(target: string, canonicalDir: string): void {
  fs.mkdirSync(target, { recursive: true });
  const dest = path.join(target, "SKILL.md");
  try {
    // never write through a planted symlink — replace it
    if (fs.lstatSync(dest).isSymbolicLink()) fs.unlinkSync(dest);
  } catch {
    // dest missing — nothing to replace
  }
  fs.copyFileSync(path.join(canonicalDir, "SKILL.md"), dest);
}

// A directory holding only a SKILL.md is adopted only when that file is a
// Surface skill (legacy manual copies from older install instructions);
// someone's unrelated single-file skill is left alone.
function looksLikeSurfaceSkill(file: string): boolean {
  try {
    return /^\s*name:\s*surface\s*$/m.test(fs.readFileSync(file, "utf8").slice(0, 2048));
  } catch {
    return false;
  }
}

// Ensure <skillsDir>/surface is a link to the canonical dir (or a managed
// copy). Refuses to replace a directory holding anything besides a Surface
// SKILL.md — that is someone else's skill. `owned` = recorded in
// install-state as ours, which skips the content check (a stale managed copy
// may hold old text).
function ensureTarget(skillsDir: string, canonicalDir: string, copy: boolean, owned: boolean): LinkResult {
  const target = path.join(skillsDir, "surface");
  let st: fs.Stats | null = null;
  try {
    st = fs.lstatSync(target);
  } catch {
    st = null;
  }

  if (st?.isSymbolicLink()) {
    if (!copy && linksTo(target, canonicalDir)) return { path: target, mode: "kept" };
    // An unrecorded symlink may be the user's own arrangement (e.g. pointing
    // at their custom skill fork) — only repair links that are ours or that
    // resolve to a Surface skill.
    if (!owned && !linksTo(target, canonicalDir) && !looksLikeSurfaceSkill(path.join(target, "SKILL.md"))) {
      return { path: target, mode: "skipped", note: "symlink does not point at a Surface skill — not managed by surface" };
    }
    fs.unlinkSync(target); // rmSync throws EISDIR on a symlink-to-directory
    st = null;
  } else if (st?.isDirectory()) {
    const entries = fs.readdirSync(target).filter((e) => e !== "SKILL.md");
    if (entries.length > 0) {
      return { path: target, mode: "skipped", note: `contains other files (${entries[0]}…) — not managed by surface` };
    }
    const skillFile = path.join(target, "SKILL.md");
    if (!owned && fs.existsSync(skillFile) && !looksLikeSurfaceSkill(skillFile)) {
      return { path: target, mode: "skipped", note: "its SKILL.md is not a Surface skill — not managed by surface" };
    }
    if (copy) {
      copyInto(target, canonicalDir);
      return { path: target, mode: "copied" };
    }
    fs.rmSync(target, { recursive: true, force: true });
    st = null;
  } else if (st) {
    return { path: target, mode: "skipped", note: "exists and is not a directory or symlink" };
  }

  fs.mkdirSync(skillsDir, { recursive: true });
  if (copy) {
    copyInto(target, canonicalDir);
    return { path: target, mode: "copied" };
  }
  try {
    fs.symlinkSync(canonicalDir, target, process.platform === "win32" ? "junction" : "dir");
    return { path: target, mode: "linked" };
  } catch (e: any) {
    // Symlinks can be forbidden (e.g. Windows without developer mode) —
    // fall back to a managed copy; upgrade rewrites it from install-state.
    copyInto(target, canonicalDir);
    return { path: target, mode: "copied", note: `symlink failed (${e?.code || e}), copied instead` };
  }
}

// ── install-state.json (the agent bootstrap contract in INSTALL_FOR_AGENTS.md) ──

function installStatePath(base: string): string {
  return path.join(base, "install-state.json");
}

function readInstallState(base: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(installStatePath(base), "utf8"));
  } catch (e: any) {
    if (e?.code === "ENOENT") return {
      service: "pending",
      skill_saved_to: null,
      skill_sha256: null,
      tutorial: "pending",
      surface_version: null,
      installed_at: null,
      notes: null,
    };
    return null; // corrupt — leave it alone
  }
}

function recordedSkillSha(base: string): string | null {
  const sha = (readInstallState(base) as any)?.skill_sha256;
  return typeof sha === "string" ? sha : null;
}

function recordSkillState(report: SkillReport, base: string, prev: Map<string, "copy" | "link">, writtenSha: string | null): void {
  const state = readInstallState(base);
  if (!state) return;
  state.skill_saved_to = report.canonical;
  // Only stamp the hash when the canonical holds OUR content; a kept edit
  // must keep the old hash, or the next run would mistake the edit for a
  // stale copy and clobber it.
  if (writtenSha) state.skill_sha256 = writtenSha;
  const links = report.links
    .filter((l) => l.mode !== "skipped" && l.mode !== "failed")
    .map((l) => ({ path: l.path, mode: l.mode === "copied" ? "copy" : "link" }));
  for (const l of report.links) {
    // a failed target stays recorded with its old mode so the next run retries it
    if (l.mode === "failed" && prev.has(path.resolve(l.path))) {
      links.push({ path: l.path, mode: prev.get(path.resolve(l.path))! });
    }
  }
  state.skill_links = links;
  fs.mkdirSync(base, { recursive: true });
  const file = installStatePath(base);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, file); // atomic: a concurrent reader never sees a partial write
}

function recordedLinks(base: string): { path: string; mode: string }[] {
  const state = readInstallState(base);
  const links = (state as any)?.skill_links;
  return Array.isArray(links) ? links.filter((l) => typeof l?.path === "string") : [];
}

// Mode rules: --copy/--link apply to this run's scope — the --to dirs when
// given, else the default targets. Every other recorded target keeps its
// recorded mode; new targets default to link. Modes are remembered per
// target, so `surface upgrade` refreshes without reshaping anything.
export function syncSkill(extraTo: string[], copy: boolean, link = false, name?: string, force = false): SkillReport {
  const base = dataDir(name);
  const { canonical, updated, edited } = syncCanonical(base, force, recordedSkillSha(base));
  const canonicalDir = path.dirname(canonical);
  const recorded = new Map<string, "copy" | "link">();
  for (const l of recordedLinks(base)) recorded.set(path.resolve(l.path), l.mode === "copy" ? "copy" : "link");
  const recCopy = (skillsDir: string) => recorded.get(path.join(skillsDir, "surface")) === "copy";
  const modeFor = (skillsDir: string, inScope: boolean) =>
    inScope && copy ? true : inScope && link ? false : recCopy(skillsDir);

  const targets = new Map<string, boolean>(); // skillsDir -> copy?
  const explicit = extraTo.length > 0;
  for (const dir of defaultTargets()) {
    const d = path.resolve(dir);
    targets.set(d, modeFor(d, !explicit));
  }
  for (const dir of extraTo) {
    const d = path.resolve(dir);
    targets.set(d, modeFor(d, true));
  }
  for (const [t] of recorded) {
    const skillsDir = path.dirname(t);
    if (!targets.has(skillsDir)) targets.set(skillsDir, recCopy(skillsDir));
  }

  const links: LinkResult[] = [];
  for (const [skillsDir, asCopy] of targets) {
    const target = path.join(skillsDir, "surface");
    if (path.resolve(target) === path.resolve(canonicalDir)) continue;
    try {
      links.push(ensureTarget(skillsDir, canonicalDir, asCopy, recorded.has(path.resolve(target))));
    } catch (e: any) {
      // one unwritable target must not abort the converger — report and move on
      links.push({ path: target, mode: "failed", note: String(e?.code || e?.message || e) });
    }
  }
  const report: SkillReport = { canonical, version: localVersion(), updated, edited, links };
  recordSkillState(report, base, recorded, edited ? null : sha256(fs.readFileSync(packageSkillPath())));
  return report;
}

export function skillFresh(name?: string): { canonical: string; fresh: boolean; edited: boolean } {
  const base = dataDir(name);
  const dest = path.join(canonicalSkillDir(base), "SKILL.md");
  try {
    const cur = fs.readFileSync(dest);
    if (cur.equals(fs.readFileSync(packageSkillPath()))) return { canonical: dest, fresh: true, edited: false };
    return { canonical: dest, fresh: false, edited: sha256(cur) !== recordedSkillSha(base) };
  } catch {
    return { canonical: dest, fresh: false, edited: false };
  }
}

// ── surface skill install ──

export async function runSkill({ positional, flags, multi }: Ctx): Promise<void> {
  if (positional[0] !== "install") {
    console.error("usage: surface skill install [--to <skills-dir>]... [--copy|--link] [--force] [--json]");
    process.exit(2);
  }
  if (flags.copy === true && flags.link === true) {
    console.error("--copy and --link are mutually exclusive");
    process.exit(2);
  }
  const report = syncSkill(multi.to || [], flags.copy === true, flags.link === true, undefined, flags.force === true);
  const failed = report.links.filter((l) => l.mode === "failed");
  if (flags.json === true) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`skill ${report.version} → ${report.canonical}${skillSuffix(report)}`);
    for (const l of report.links) {
      console.log(`  ${l.mode.padEnd(7)} ${l.path}${l.note ? `  (${l.note})` : ""}`);
    }
    if (failed.length) console.error(`${failed.length} target(s) could not be written — see notes above`);
  }
  if (failed.length) process.exit(1);
}

function skillSuffix(report: SkillReport): string {
  if (report.edited) return " (locally edited — kept; surface skill install --force to replace)";
  return report.updated ? " (updated)" : "";
}

// ── surface upgrade ──

function registryUrl(): string {
  return (process.env.SURFACE_NPM_REGISTRY || "https://registry.npmjs.org").replace(/\/$/, "");
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

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
  // strict gate: this string reaches a shell-backed npm spawn on Windows
  if (typeof body?.version !== "string" || !SEMVER.test(body.version)) {
    throw new Error(`registry returned an invalid version (${JSON.stringify(body?.version).slice(0, 60)}) from ${url}`);
  }
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
    if (globalRoot) {
      const rel = path.relative(fs.realpathSync(globalRoot), root);
      if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return "global";
    }
  } catch {
    // global root missing — treat as local
  }
  return "local";
}

export async function runUpgrade({ flags }: Ctx): Promise<void> {
  const json = flags.json === true;
  const timeoutSec = typeof flags.timeout === "string" ? Number(flags.timeout) : 30;
  const name = typeof flags.name === "string" ? flags.name : undefined;
  const current = localVersion();
  const latest = await latestVersion();
  const available = newerThan(latest, current);
  const context = installContext();

  if (flags.check === true) {
    const skill = skillFresh(name);
    const report = { current, latest, update_available: available, context, skill };
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(available ? `update available: ${current} → ${latest}` : `up to date (${current})`);
      if (skill.edited) console.log(`skill copy locally edited at ${skill.canonical} — kept (surface skill install --force to replace)`);
      else if (!skill.fresh) console.log(`skill copy stale/missing at ${skill.canonical} — run: surface upgrade`);
      if (available && context !== "global") console.log(contextAdvice(context));
    }
    return;
  }

  let installed = current;
  let packageStep = "unchanged";
  if (available && context === "global") {
    const res = spawnSync(npmCmd(), ["install", "-g", `surface-display@${latest}`], {
      // --json promises pure JSON on stdout — npm's install chatter goes to
      // stderr there instead of corrupting the report.
      stdio: json ? ["ignore", "pipe", "inherit"] : "inherit",
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    if (res.status !== 0) {
      if (json && res.stdout) process.stderr.write(res.stdout);
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
  const skill = syncSkill([], false, false, name);
  const service = await restartServiceIfStale(timeoutSec, name);
  const failedLinks = skill.links.filter((l) => l.mode === "failed");

  const report = { previous: current, installed, latest, package: packageStep, context, skill, service };
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    if ((service.restarted && service.error) || failedLinks.length) process.exit(1);
    return;
  }
  console.log(available && packageStep.startsWith("updated") ? packageStep : `package: ${packageStep === "unchanged" ? `up to date (${current})` : packageStep}`);
  if (available && context !== "global") console.log(contextAdvice(context));
  console.log(`skill  : ${skill.version} → ${skill.canonical}${skillSuffix(skill)}`);
  for (const l of skill.links) console.log(`  ${l.mode.padEnd(7)} ${l.path}${l.note ? `  (${l.note})` : ""}`);
  if (!service.installed) console.log("service: not installed here — skipped");
  else if (service.restarted && service.error) {
    console.error(`service: restarted but not healthy — ${service.error}`);
    process.exit(1);
  } else if (service.restarted) console.log(`service: restarted, now ${service.version}`);
  else if (service.version) console.log(`service: already on ${service.version} — no restart needed`);
  else console.log(`service: ${service.state || "stopped"} — left as-is (start it with: surface service start)`);
  if (failedLinks.length) {
    console.error(`skill  : ${failedLinks.length} target(s) could not be written — see notes above`);
    process.exit(1);
  }
}

function contextAdvice(context: InstallContext): string {
  return context === "dev"
    ? "this is a repo clone — update with: git pull && npm install && npm test"
    : "surface-display is installed locally here — update with: npm update surface-display (in that project)";
}
