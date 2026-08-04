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
import { randomUUID } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import {
  contextAdvice,
  installContext,
  newerThan,
  redactUrls,
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
  runCache = null;
  ownRunId = null;
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

// Resolve "how was surface-display installed here?" exactly once, and never on
// a request.
//
// installContext() is blocking: outside a repo clone it spawns `npm root -g`
// and waits, with no timeout. It has two callers, both off the request path —
// runUpdateCheck() (the background timer) and startUpdateChecks() (boot). The
// apply endpoint used to call it too, which meant `POST /api/update/apply`
// blocked an Express worker on npm whenever the cache was still empty, and the
// cache was reachably empty two ways: SURFACE_UPDATE_CHECK=0 (the background
// check never runs at all), or any POST arriving inside the 30s first-check
// delay. It also made the two endpoints disagree — the status endpoint reads
// the cache and falls back to "dev", so it advertised `can_apply: false` with
// repo-clone advice while the apply endpoint probed and started a real update
// on the same host. Every reader now shares the one cached answer.
//
// A repo clone answers from the package path alone (no spawn), so this costs
// nothing in a dev checkout or in the suites.
function resolveContext(): InstallContext {
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
  resolveContext(); // memoize the (blocking) install-context probe off the request path
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
      // SURFACE_NPM_REGISTRY can carry credentials, and Node names the whole
      // URL when it rejects one. This string is served by a device-readable
      // endpoint and broadcast over SSE — launder it before it is stored.
      error: redactUrls(err?.cause?.code || err?.code || err?.message || err).slice(0, 200),
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
  // Before the early return, and regardless of whether the registry check is
  // enabled: this is the one place the blocking install-context probe is
  // guaranteed to run off a request. With SURFACE_UPDATE_CHECK=0 the background
  // check never runs, and without this the first POST /api/update/apply would
  // be the thing that spawned `npm root -g`.
  resolveContext();
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
 *
 * The reference version is what the run actually put ON DISK (`installed`),
 * falling back to what it was aiming for (`to`) for a record written before the
 * install step got that far. That is the same reference `staleServiceError()`
 * in bin/upgrade.ts uses, and the two must agree — they are two routes to the
 * one claim "the update is done". Comparing against `to` alone would fail a
 * dev/local install, which legitimately converges skill + service without
 * moving the package and which `surface upgrade` itself reports as success.
 */
export function reconcileRun(
  run: UpgradeProgress | null,
  opts: { version: string; now: number; booted: boolean },
): UpgradeProgress | null {
  if (!run || isTerminal(run.phase)) return run;
  const { version, now, booted } = opts;
  const target = run.installed || run.to;
  if (booted && target && version !== "unknown" && !newerThan(target, version)) {
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

/**
 * Which record describes the current run — the one in memory, or the one on
 * disk? Pure so the rule is unit-testable.
 *
 * A run THIS process started is the authority while it is live. Its file may be
 * *temporarily* absent — the detached child takes a node boot to write its first
 * record, and every later write is a tmp+rename — and letting a missing file
 * clear the in-memory run is exactly how a second POST slipped past the
 * single-flight guard and started a second global npm install. A record
 * carrying a different run_id belongs to somebody else and must not replace
 * ours either.
 *
 * A record we merely *adopted* from the file (a run from before a restart, or
 * one started by `surface upgrade` on the host) gets no such protection: there
 * the file is the only source of truth, so if it goes away, so does the run.
 */
export function chooseRunRecord(
  memory: UpgradeProgress | null,
  disk: UpgradeProgress | null,
  ownRunId: string | null,
): UpgradeProgress | null {
  if (!memory || isTerminal(memory.phase)) return disk;
  if (!memory.run_id || memory.run_id !== ownRunId) return disk;
  if (!disk) return memory;
  if (disk.run_id !== memory.run_id) return memory;
  return disk;
}

// Cached because the status endpoint reads it on every request: the file only
// changes while a run is in flight, and the watcher below refreshes it then.
let runCache: UpgradeProgress | null = null;
// The id of the run THIS process spawned, if any — see chooseRunRecord().
let ownRunId: string | null = null;

function reconcileRunFile(booted: boolean): UpgradeProgress | null {
  const disk = readRun();
  const raw = chooseRunRecord(runCache, disk, ownRunId);
  const resolved = reconcileRun(raw, { version: serverVersion(), now: Date.now(), booted });
  if (resolved && raw && raw === disk && resolved.phase !== raw.phase) {
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
 *
 * Cache-only, and so is `applyUpdate` — they read the same resolved context, so
 * what the status endpoint advertises and what the apply endpoint will actually
 * do cannot drift apart. Neither ever blocks on `npm root -g`.
 */
export function applyBlockedReason(role: "system" | "device"): string | null {
  if (role !== "system") {
    return "One-click update runs on the system plane. Open Surface on the host (or run `surface upgrade` there).";
  }
  if (cachedContext() !== "global") return contextAdvice(cachedContext());
  if (runCache && !isTerminal(runCache.phase)) return "An update is already running.";
  return null;
}

/**
 * The status as a given plane may see it.
 *
 * Errors here are already laundered where they are produced (see redactUrls),
 * so this is the second wall rather than the first: a device gets to know THAT
 * the check or the run failed — enough for an honest pill — without being
 * handed a host-side diagnostic it cannot act on and that may name internal
 * infrastructure. The system plane, which is the only plane that can do
 * anything about a failure, still gets the full text.
 */
export function updateStatusFor(role: "system" | "device"): UpdateStatus {
  const status = updateStatus();
  if (role === "system") return status;
  return {
    ...status,
    check_error: status.check_error ? "the last release check failed" : null,
    run: status.run
      ? {
        ...status.run,
        error: status.run.error ? "the update failed — check Surface on the host" : null,
      }
      : null,
  };
}

// SSE has no per-plane fan-out (a global client's target is a device session id
// or "local", and the content plane on loopback is "local" too), so the pushed
// payload is the device-safe one for everybody. The system dashboard polls
// GET /api/update/status while a run is live and gets the full detail there.
export function broadcastUpdateStatus(): void {
  broadcastGlobal("update_status", updateStatusFor("device"));
}

// ── the apply ──

function cliPath(): string {
  // dist/surface.mjs sits next to dist/server.mjs in the published package; in
  // a repo clone the server runs from server/ and the bundle is in ../dist.
  const bundled = path.join(__dirname, "surface.mjs");
  return fs.existsSync(bundled) ? bundled : path.join(__dirname, "..", "dist", "surface.mjs");
}

/**
 * Write the run record with an exclusive create, so the slot is taken before
 * anything is spawned. Throws when a live run already owns the file.
 *
 * Synchronous on purpose: applyUpdate() must not yield between "no run is in
 * flight" and "this run owns the file", or the check is decoration.
 */
function claimRunFile(file: string, record: UpgradeProgress): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = readRun();
  if (existing && !isTerminal(existing.phase)) throw new Error("a run already owns the progress file");
  fs.rmSync(file, { force: true });
  const fd = fs.openSync(file, "wx"); // EEXIST if anyone re-created it in between
  try {
    fs.writeSync(fd, JSON.stringify(record, null, 2) + "\n");
  } finally {
    fs.closeSync(fd);
  }
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
  // The cache, not a fresh probe: this runs on an Express worker, and the
  // status endpoint answers from the same value — the two planes must not
  // disagree about whether a one-click update is on offer. startUpdateChecks()
  // has already resolved it; an unresolved cache reads "dev", which refuses.
  const installedAs = cachedContext();
  if (installedAs !== "global") {
    return { started: false, status: 409, error: contextAdvice(installedAs) };
  }
  const cli = cliPath();
  if (!fs.existsSync(cli)) {
    return { started: false, status: 500, error: `the surface CLI bundle is missing at ${cli}` };
  }

  const progressFile = progressFilePath();
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const claim: UpgradeProgress = {
    phase: "checking",
    started_at: startedAt,
    updated_at: startedAt,
    pid: 0,
    from: serverVersion(),
    run_id: runId,
  };
  // Claim the slot BEFORE spawning, by exclusive creation. The child needs a
  // node boot to write its own first record, and until this claim existed that
  // gap was wide enough for a second POST to see no run at all — two global npm
  // installs, two service restarts, one progress file. The claim also carries
  // the run id, so a record written by anybody else can be told apart later.
  try {
    claimRunFile(progressFile, claim);
  } catch {
    return { started: false, status: 409, error: "An update is already running." };
  }
  ownRunId = runId;
  runCache = claim;

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
    "--run-id", runId,
  ], {
    detached: true,
    stdio: "ignore",
    cwd: getDataDir(),
    env: process.env,
  });
  child.on("error", (err) => {
    runCache = {
      ...claim,
      phase: "failed",
      updated_at: new Date().toISOString(),
      error: `could not start the upgrade: ${err.message}`,
    };
    try { writeAtomic(progressFile, runCache); } catch {}
    broadcastUpdateStatus();
  });
  child.unref();

  runCache = { ...claim, pid: child.pid ?? 0 };
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
