// Release awareness + one-click update for the PWA home.
//
// Two halves, deliberately kept apart:
//
//   1. THE CHECK (read-only, background). A cached "is there a newer
//      surface-display on npm?" answer. It runs on a self-rearming timer, never
//      on a request, and `GET /api/update/status` serves the cache only — an
//      offline host answers instantly with the last known good value instead of
//      hanging a page load on a dead socket. Disabled under NODE_ENV=test / CI
//      so the suites and the CI matrix never touch the registry.
//
//   2. THE APPLY (system plane only). Runs the existing converger — `surface
//      upgrade`, the same command a human would type — as a detached child.
//      There is no second upgrade path here: this module spawns bin/upgrade.ts
//      and reads the progress file it writes. See applyUpdate() for why the
//      device plane is refused.
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import {
  contextAdvice,
  installContext,
  newerThan,
  type InstallContext,
  type UpgradeProgress,
} from "../bin/upgrade.js";
import { getDataDir } from "./paths.js";
import { broadcastGlobal } from "./sse.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_TTL_HOURS = 6;
// A failed check backs off instead of retrying: first retry after 30 min, then
// 60, 90 … capped at the normal TTL. An offline host makes at most a handful of
// doomed requests a day and logs nothing.
const FAILURE_BACKOFF_MS = 30 * 60 * 1000;
// First check is deferred past boot so a cold start never competes with the
// service coming up (and a supervisor restart loop can't turn into a request
// loop). SURFACE_UPDATE_CHECK_DELAY_MS shortens it for tests.
const FIRST_CHECK_DELAY_MS = 30_000;
// A run that stops reporting for this long is dead, not slow.
const RUN_STALE_MS = 10 * 60 * 1000;

// ── on-disk state ──

interface CheckCache {
  checked_at: string | null;
  latest: string | null;
  error: string | null;
  failures: number;
}

const EMPTY_CACHE: CheckCache = { checked_at: null, latest: null, error: null, failures: 0 };

function checkCachePath(): string {
  return path.join(getDataDir(), "update-check.json");
}

export function progressFilePath(): string {
  return path.join(getDataDir(), "update-state.json");
}

// The cache is owned by this process: memory is the source of truth, disk is
// the write-through copy that survives a restart (so a reboot doesn't re-hit
// the registry). Requests never read the disk.
let cache: CheckCache | null = null;

function loadCache(): CheckCache {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(checkCachePath(), "utf8"));
    cache = {
      checked_at: typeof raw?.checked_at === "string" ? raw.checked_at : null,
      latest: typeof raw?.latest === "string" ? raw.latest : null,
      error: typeof raw?.error === "string" ? raw.error : null,
      failures: Number.isFinite(raw?.failures) ? Number(raw.failures) : 0,
    };
  } catch {
    cache = { ...EMPTY_CACHE };
  }
  return cache;
}

function writeAtomic(file: string, data: unknown): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

function saveCache(next: CheckCache): void {
  cache = next;
  try {
    writeAtomic(checkCachePath(), next);
  } catch {
    // the cache is advisory — an unwritable data dir must not break the server
  }
}

/** Test seam: forget the memoized cache/context so a suite can re-read state. */
export function resetUpdateStateForTests(): void {
  cache = null;
  contextCache = undefined;
  serviceNameCache = undefined;
}

// ── configuration ──

function ttlMs(): number {
  const raw = Number(process.env.SURFACE_UPDATE_CHECK_TTL_HOURS);
  const hours = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_HOURS;
  return hours * 60 * 60 * 1000;
}

// Off in tests and CI by default: a suite must never depend on (or hammer) the
// npm registry. SURFACE_UPDATE_CHECK is the explicit override in both
// directions — the update suite turns it on and points it at a stub registry.
export function updateCheckEnabled(): boolean {
  const raw = process.env.SURFACE_UPDATE_CHECK;
  if (raw !== undefined && raw !== "") return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
  if (process.env.NODE_ENV === "test") return false;
  if (process.env.CI) return false;
  return true;
}

function registryUrl(): string {
  return (process.env.SURFACE_NPM_REGISTRY || "https://registry.npmjs.org").replace(/\/$/, "");
}

let contextCache: InstallContext | undefined;

// installContext() spawns `npm root -g`; it is memoized and only ever called
// from the background check, never from a request handler.
function context(): InstallContext {
  if (contextCache === undefined) {
    try {
      contextCache = installContext();
    } catch {
      contextCache = "dev";
    }
  }
  return contextCache;
}

let serviceNameCache: string | undefined;

// `surface upgrade` converges the service named "surface" unless told
// otherwise. A host that installed under `--name kiosk` would otherwise have
// its *other* service restarted, so match ourselves against the saved service
// registry by port before falling back to the default.
function serviceName(): string {
  if (serviceNameCache !== undefined) return serviceNameCache;
  serviceNameCache = "surface";
  const port = Number(process.env.PORT || 3000);
  const dir = path.join(os.homedir(), ".surface", "services");
  try {
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      const saved = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      if (Number(saved?.port ?? 3000) === port) {
        serviceNameCache = file.slice(0, -5);
        break;
      }
    }
  } catch {
    // no registry (fresh install, or a server started outside `surface service`)
  }
  return serviceNameCache;
}

// ── the check ──

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

async function fetchLatest(): Promise<string> {
  const url = `${registryUrl()}/surface-display/latest`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`registry answered ${res.status}`);
  const body: any = await res.json();
  // Same strict gate as `surface upgrade`: this string is displayed and, on the
  // apply path, decides whether an install runs at all.
  if (typeof body?.version !== "string" || !SEMVER.test(body.version)) {
    throw new Error("registry returned an invalid version");
  }
  return body.version;
}

function firstCheckDelayMs(): number {
  const raw = Number(process.env.SURFACE_UPDATE_CHECK_DELAY_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : FIRST_CHECK_DELAY_MS;
}

/** When the next registry check is due (epoch ms). 0 = never checked. */
export function checkDueAt(): number {
  return nextDueAt(loadCache());
}

function nextDueAt(c: CheckCache): number {
  if (!c.checked_at) return 0;
  const last = Date.parse(c.checked_at);
  if (!Number.isFinite(last)) return 0;
  const wait = c.error
    ? Math.min(ttlMs(), FAILURE_BACKOFF_MS * Math.max(1, c.failures))
    : ttlMs();
  return last + wait;
}

let checking = false;

/** Run one registry check now, regardless of TTL. Never throws. */
export async function runUpdateCheck(): Promise<void> {
  if (checking) return;
  checking = true;
  context(); // memoize the (blocking) install-context probe off the request path
  const prev = loadCache();
  try {
    const latest = await fetchLatest();
    saveCache({ checked_at: new Date().toISOString(), latest, error: null, failures: 0 });
  } catch (err: any) {
    // Degrade silently: keep the last known good `latest`, record why, back off.
    // No console noise — an offline display would otherwise spam its log file.
    saveCache({
      checked_at: new Date().toISOString(),
      latest: prev.latest,
      error: String(err?.cause?.code || err?.code || err?.message || err).slice(0, 200),
      failures: prev.failures + 1,
    });
  } finally {
    checking = false;
  }
  broadcastUpdateStatus();
}

let timer: NodeJS.Timeout | null = null;

function armTimer(delayMs: number): void {
  if (timer) clearTimeout(timer);
  // unref'd: this timer must never hold the process open or wake an idle host
  // more than it has to. One wakeup per TTL, not a poll loop.
  timer = setTimeout(() => {
    void runUpdateCheck().then(() => armTimer(Math.max(60_000, nextDueAt(loadCache()) - Date.now())));
  }, delayMs);
  timer.unref();
}

/** Start the background release check. No-op when disabled (tests, CI, opt-out). */
export function startUpdateChecks(): void {
  reconcileRunFile(true);
  if (!updateCheckEnabled()) return;
  const due = nextDueAt(loadCache());
  armTimer(Math.max(firstCheckDelayMs(), due - Date.now()));
}

// ── the in-flight run ──

function readRun(): UpgradeProgress | null {
  try {
    const raw = JSON.parse(fs.readFileSync(progressFilePath(), "utf8"));
    return typeof raw?.phase === "string" ? (raw as UpgradeProgress) : null;
  } catch {
    return null;
  }
}

export function isTerminal(phase: string | undefined): boolean {
  return phase === "done" || phase === "failed";
}

/**
 * Resolve a run record that stopped reporting. Pure so it can be unit-tested.
 *
 * The upgrade child is killed by the very restart it triggers (systemd's
 * default KillMode takes down the whole unit cgroup), so "restarting" is often
 * the last phase ever written. `booted` marks the first read after a fresh
 * server start, where the running version is the honest answer to whether the
 * update landed.
 */
export function reconcileRun(
  run: UpgradeProgress | null,
  opts: { version: string; now: number; booted: boolean },
): UpgradeProgress | null {
  if (!run || isTerminal(run.phase)) return run;
  const { version, now, booted } = opts;
  if (booted && run.to && version !== "unknown" && !newerThan(run.to, version)) {
    return { ...run, phase: "done", installed: version, error: null, updated_at: new Date(now).toISOString() };
  }
  if (booted && run.phase === "restarting") {
    return {
      ...run,
      phase: "failed",
      installed: version,
      error: `Surface restarted but is still running ${version}`,
      updated_at: new Date(now).toISOString(),
    };
  }
  const last = Date.parse(run.updated_at || run.started_at || "");
  if (Number.isFinite(last) && now - last > RUN_STALE_MS) {
    return {
      ...run,
      phase: "failed",
      error: "the update stopped reporting progress — run `surface upgrade` on the host to see why",
      updated_at: new Date(now).toISOString(),
    };
  }
  return run;
}

// Cached because the status endpoint reads it on every request: the file only
// changes while a run is in flight, and the watcher below refreshes it then.
let runCache: UpgradeProgress | null = null;

function reconcileRunFile(booted: boolean): UpgradeProgress | null {
  const raw = readRun();
  const resolved = reconcileRun(raw, { version: serverVersion(), now: Date.now(), booted });
  if (resolved && raw && resolved.phase !== raw.phase) {
    try {
      writeAtomic(progressFilePath(), resolved);
    } catch {
      // advisory
    }
  }
  runCache = resolved;
  return resolved;
}

let versionCache: string | null = null;

export function serverVersion(): string {
  if (versionCache) return versionCache;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    versionCache = String(pkg.version || "unknown");
  } catch {
    versionCache = "unknown";
  }
  return versionCache;
}

// ── status ──

export interface UpdateStatus {
  current: string;
  latest: string | null;
  update_available: boolean;
  checked_at: string | null;
  check_error: string | null;
  context: InstallContext;
  advice: string | null;
  run: UpgradeProgress | null;
}

// contextCache is filled by the background check; until then report the safe
// answer ("dev" offers no button) rather than blocking a request on `npm root -g`.
function cachedContext(): InstallContext {
  return contextCache ?? "dev";
}

export function updateStatus(): UpdateStatus {
  const c = loadCache();
  const latest = c.latest;
  const current = serverVersion();
  const available = !!latest && current !== "unknown" && newerThan(latest, current);
  return {
    current,
    latest,
    update_available: available,
    checked_at: c.checked_at,
    check_error: c.error,
    context: cachedContext(),
    advice: cachedContext() === "global" ? null : contextAdvice(cachedContext()),
    run: runCache,
  };
}

/**
 * Why a one-click update is not offered here, or null when it is.
 * Cache-only (never blocks); `applyUpdate` re-checks authoritatively.
 */
export function applyBlockedReason(role: "system" | "device"): string | null {
  if (role !== "system") {
    return "One-click update runs on the system plane. Open Surface on the host (or run `surface upgrade` there).";
  }
  if (cachedContext() !== "global") return contextAdvice(cachedContext());
  if (runCache && !isTerminal(runCache.phase)) return "An update is already running.";
  return null;
}

export function broadcastUpdateStatus(): void {
  broadcastGlobal("update_status", updateStatus());
}

// ── the apply ──

function cliPath(): string {
  // dist/surface.mjs sits next to dist/server.mjs in the published package; in
  // a repo clone the server runs from server/ and the bundle is in ../dist.
  const bundled = path.join(__dirname, "surface.mjs");
  return fs.existsSync(bundled) ? bundled : path.join(__dirname, "..", "dist", "surface.mjs");
}

export interface ApplyResult {
  started: boolean;
  status: number;
  error?: string;
}

/**
 * Start `surface upgrade` for the PWA's Update button.
 *
 * SECURITY (see SECURITY.md, docs/auth/trust-model.md): this installs an npm
 * package and restarts the service. That is squarely inside "executes code",
 * which the trust model reserves for the **system plane** — loopback and
 * explicitly minted system bearers. A paired display is `device`: it may look,
 * click, and author its own surfaces, but it may not make the host fetch and
 * run new code. The content plane can never satisfy this either (it resolves to
 * `device` by construction), so device-authored surface JS cannot reach it.
 * Devices still *see* the "update available" pill — the notification is
 * information, the install is authority.
 */
export function applyUpdate(role: "system" | "device"): ApplyResult {
  if (role !== "system") {
    return { started: false, status: 403, error: applyBlockedReason(role)! };
  }
  reconcileRunFile(false);
  if (runCache && !isTerminal(runCache.phase)) {
    return { started: false, status: 409, error: "An update is already running." };
  }
  if (context() !== "global") {
    return { started: false, status: 409, error: contextAdvice(context()) };
  }
  const cli = cliPath();
  if (!fs.existsSync(cli)) {
    return { started: false, status: 500, error: `the surface CLI bundle is missing at ${cli}` };
  }

  const progressFile = progressFilePath();
  try {
    fs.rmSync(progressFile, { force: true });
  } catch {
    // a leftover file is overwritten by the child's first write anyway
  }

  // No shell, fixed argv — nothing here is caller-supplied; the version to
  // install is resolved by the converger itself and semver-gated there.
  //
  // detached + ignored stdio: the run must not be tied to this request, and the
  // service restart it performs kills this process. On systemd the child dies
  // with the cgroup too — that is expected and handled: the phase file is
  // written *before* each step and the restarted server reconciles it.
  const child = spawn(process.execPath, [
    cli,
    "upgrade",
    "--json",
    "--name", serviceName(),
    "--progress-file", progressFile,
  ], {
    detached: true,
    stdio: "ignore",
    cwd: getDataDir(),
    env: process.env,
  });
  child.on("error", (err) => {
    runCache = {
      phase: "failed",
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      pid: 0,
      from: serverVersion(),
      error: `could not start the upgrade: ${err.message}`,
    };
    try { writeAtomic(progressFile, runCache); } catch {}
    broadcastUpdateStatus();
  });
  child.unref();

  runCache = {
    phase: "checking",
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    pid: child.pid ?? 0,
    from: serverVersion(),
  };
  watchRun();
  broadcastUpdateStatus();
  return { started: true, status: 202 };
}

let watcher: NodeJS.Timeout | null = null;

// Bounded, in-flight-only polling: 1s while a run is live, cleared the moment
// it reaches a terminal phase. An idle Surface polls nothing.
function watchRun(): void {
  if (watcher) return;
  const startedAt = Date.now();
  watcher = setInterval(() => {
    const before = runCache?.phase;
    const now = reconcileRunFile(false);
    if (now?.phase !== before) broadcastUpdateStatus();
    if (!now || isTerminal(now.phase) || Date.now() - startedAt > RUN_STALE_MS + 60_000) {
      clearInterval(watcher!);
      watcher = null;
    }
  }, 1000);
  watcher.unref();
}

export function stopUpdateWatchers(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  if (watcher) { clearInterval(watcher); watcher = null; }
}
