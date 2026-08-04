// Release notice + one-click update (server/updates.ts, server/routes/updates.ts).
//
// Nothing here touches the real npm registry, the real global npm prefix, or
// any service on this machine: every registry read goes to a local stub, every
// `npm` call goes to a fake `npm` on PATH, and every install/upgrade runs with
// HOME pointed at a throwaway directory whose service registry names a unit
// that does not exist.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { cleanupDir, makeClient, REPO_ROOT, sleep, tmpDir } from "./helpers.js";

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(name);
    console.error(`  FAIL  ${name}${detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  }
}

// Ports are pinned to the 38000-38999 band so a test server can never be
// confused with (or collide with) the live Surface on 3000/3100.
let nextPort = 38400 + (process.pid % 400);
function claimPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const port = nextPort++;
    if (port > 38999) { reject(new Error("out of test ports")); return; }
    const srv = net.createServer();
    srv.once("error", () => resolve(claimPort()));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(port)));
  });
}

// A stand-in for registry.npmjs.org that counts its hits, so "the status
// endpoint never reaches the network" is an assertion and not a hope.
function stubRegistry(version: string | null): Promise<{ url: string; hits: () => number; close: () => void }> {
  let hits = 0;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      hits++;
      if (req.url === "/surface-display/latest" && version !== null) {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ name: "surface-display", version }));
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}`, hits: () => hits, close: () => server.close() });
    });
  });
}

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 20000, everyMs = 200): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(everyMs);
  }
  return null;
}

const scratch = tmpDir("surface-updates-");
const children: ChildProcess[] = [];

function killAll(): void {
  for (const child of children) {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      try { child.kill("SIGKILL"); } catch {}
    }
  }
}

try {
  // ══ 1. Pure logic (imported in-process) ══════════════════════════════════
  // getDataDir() memoizes on first call, so the data dir has to be chosen
  // before the module graph is loaded.
  const unitData = path.join(scratch, "unit-data");
  fs.mkdirSync(unitData, { recursive: true });
  process.env.SURFACE_DATA_DIR = unitData;
  const updates = await import("../server/updates.js");

  // ── the check is off in tests and CI unless explicitly turned on ──
  const savedNodeEnv = process.env.NODE_ENV;
  const savedCI = process.env.CI;
  const savedFlag = process.env.SURFACE_UPDATE_CHECK;
  delete process.env.SURFACE_UPDATE_CHECK;
  process.env.NODE_ENV = "test";
  delete process.env.CI;
  check("update check is off under NODE_ENV=test", updates.updateCheckEnabled() === false);
  process.env.NODE_ENV = "production";
  process.env.CI = "true";
  check("update check is off under CI", updates.updateCheckEnabled() === false);
  delete process.env.CI;
  check("update check is on for a normal install", updates.updateCheckEnabled() === true);
  process.env.SURFACE_UPDATE_CHECK = "0";
  check("SURFACE_UPDATE_CHECK=0 opts out", updates.updateCheckEnabled() === false);
  process.env.SURFACE_UPDATE_CHECK = "1";
  process.env.NODE_ENV = "test";
  check("SURFACE_UPDATE_CHECK=1 overrides the test gate", updates.updateCheckEnabled() === true);
  process.env.NODE_ENV = savedNodeEnv ?? "test";
  if (savedCI === undefined) delete process.env.CI; else process.env.CI = savedCI;
  if (savedFlag === undefined) delete process.env.SURFACE_UPDATE_CHECK; else process.env.SURFACE_UPDATE_CHECK = savedFlag;

  // ── reconcileRun: an upgrade child that never got to write a terminal phase ──
  const iso = (t: number) => new Date(t).toISOString();
  const now = Date.now();
  const restarting = {
    phase: "restarting" as const,
    started_at: iso(now - 5000),
    updated_at: iso(now - 5000),
    pid: 1,
    from: "0.2.3",
    to: "0.2.4",
  };
  check(
    "a restart that landed the new version reconciles to done",
    updates.reconcileRun(restarting, { version: "0.2.4", now, booted: true })?.phase === "done",
  );
  check(
    "a newer-than-target version still counts as done",
    updates.reconcileRun(restarting, { version: "0.3.0", now, booted: true })?.phase === "done",
  );
  const stillOld = updates.reconcileRun(restarting, { version: "0.2.3", now, booted: true });
  check("a restart that did NOT land the version reports failed", stillOld?.phase === "failed", stillOld);
  check("…and says which version is actually running", /0\.2\.3/.test(String(stillOld?.error)), stillOld?.error);
  check(
    "a live run mid-flight is left alone",
    updates.reconcileRun(restarting, { version: "0.2.3", now, booted: false })?.phase === "restarting",
  );
  const silent = { ...restarting, phase: "installing" as const, updated_at: iso(now - 11 * 60 * 1000) };
  check(
    "a run that stopped reporting for 10 minutes fails instead of spinning",
    updates.reconcileRun(silent, { version: "0.2.3", now, booted: false })?.phase === "failed",
  );
  check(
    "a terminal run is never rewritten",
    updates.reconcileRun({ ...restarting, phase: "failed", error: "npm exploded" }, { version: "0.2.4", now, booted: true })?.error === "npm exploded",
  );
  check("no run reconciles to no run", updates.reconcileRun(null, { version: "0.2.4", now, booted: true }) === null);

  // ── the cached check: success, TTL, backoff, offline, garbage ──
  process.env.SURFACE_UPDATE_CHECK_TTL_HOURS = "6";
  const reg = await stubRegistry("9.9.9");
  process.env.SURFACE_NPM_REGISTRY = reg.url;
  await updates.runUpdateCheck();
  let status = updates.updateStatus();
  check("a successful check caches the latest version", status.latest === "9.9.9", status);
  check("…and reports an update is available", status.update_available === true);
  check("…and stamps checked_at", typeof status.checked_at === "string");
  check("…and records no error", status.check_error === null);
  const cacheFile = path.join(unitData, "update-check.json");
  check("the cache is persisted so a restart does not re-hit the registry", fs.existsSync(cacheFile));
  const ttlLeft = updates.checkDueAt() - Date.now();
  check("the next check is a TTL away, not minutes", ttlLeft > 5.9 * 3600_000 && ttlLeft <= 6 * 3600_000, ttlLeft);

  const hitsBefore = reg.hits();
  check("updateStatus() serves the cache without touching the registry", reg.hits() === hitsBefore);
  reg.close();

  // registry gone: keep the last good answer, record why, back off
  process.env.SURFACE_NPM_REGISTRY = "http://127.0.0.1:9";
  await updates.runUpdateCheck();
  status = updates.updateStatus();
  check("an offline check keeps the last known latest", status.latest === "9.9.9", status);
  check("…records the failure instead of throwing", typeof status.check_error === "string" && status.check_error.length > 0);
  const backoff1 = updates.checkDueAt() - Date.now();
  check("…and backs off ~30 min rather than retrying in a loop", backoff1 > 25 * 60_000 && backoff1 <= 30 * 60_000, backoff1);
  await updates.runUpdateCheck();
  const backoff2 = updates.checkDueAt() - Date.now();
  check("…with the backoff widening on repeat failure", backoff2 > backoff1 + 20 * 60_000, { backoff1, backoff2 });

  // a registry that answers with junk must not poison the cached version
  const junk = await stubRegistry('9.9.9"; rm -rf /; "');
  process.env.SURFACE_NPM_REGISTRY = junk.url;
  await updates.runUpdateCheck();
  status = updates.updateStatus();
  check("a non-semver registry answer is rejected", status.latest === "9.9.9", status);
  check("…and reported as an error", /invalid version/.test(String(status.check_error)), status.check_error);
  junk.close();
  delete process.env.SURFACE_NPM_REGISTRY;
  updates.stopUpdateWatchers();

  // ══ 2. HTTP: a repo clone (dev install) ══════════════════════════════════
  const devReg = await stubRegistry("99.0.0");
  const devData = path.join(scratch, "dev-data");
  const devPort = await claimPort();
  const devContentPort = await claimPort();
  const devChild = spawn(process.execPath, [path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs"), "server/index.ts"], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      SURFACE_DATA_DIR: devData,
      SURFACE_BIND: "127.0.0.1",
      SURFACE_PAIR_ON_START: "0",
      PORT: String(devPort),
      SURFACE_CONTENT_PORT: String(devContentPort),
      NODE_ENV: "test",
      SURFACE_UPDATE_CHECK: "1",
      SURFACE_UPDATE_CHECK_DELAY_MS: "200",
      SURFACE_NPM_REGISTRY: devReg.url,
    },
  });
  children.push(devChild);
  if (process.env.SURFACE_TEST_VERBOSE) {
    devChild.stdout?.on("data", (d) => process.stdout.write(d));
    devChild.stderr?.on("data", (d) => process.stderr.write(d));
  }
  const dev = makeClient(`http://127.0.0.1:${devPort}`);
  const devContent = makeClient(`http://127.0.0.1:${devContentPort}`);
  await waitFor(async () => {
    try { return (await dev("GET", "/api/auth/session")).status < 500 ? true : null; } catch { return null; }
  });

  const seen = await waitFor(async () => {
    const r = await dev("GET", "/api/update/status");
    return r.body?.latest === "99.0.0" ? r.body : null;
  }, 15000);
  check("the background check populates the cache", seen?.latest === "99.0.0", seen);
  check("…flags the newer release", seen?.update_available === true);
  check("…and detects a repo clone as a dev install", seen?.context === "dev", seen?.context);
  check("…offering git pull instead of a one-click npm update", /git pull/.test(String(seen?.advice)), seen?.advice);
  check("…so the button is not offered", seen?.can_apply === false);

  const hitsAfterCheck = devReg.hits();
  await dev("GET", "/api/update/status");
  await dev("GET", "/api/update/status");
  check("GET /api/update/status is cache-only (no registry traffic)", devReg.hits() === hitsAfterCheck, devReg.hits());

  const devApply = await dev("POST", "/api/update/apply");
  check("a repo clone refuses the one-click update", devApply.status === 409, devApply);
  check("…with honest advice, not a silent no-op", /git pull/.test(String(devApply.body?.error)), devApply.body);
  check("…and never starts a run", (await dev("GET", "/api/update/status")).body?.run === null);

  // the content plane is `device` by construction — device-authored surface JS
  // must not be able to make the host install software
  const contentStatus = await devContent("GET", "/api/update/status");
  check("the content plane may read the release notice", contentStatus.status === 200, contentStatus.status);
  check("…but is never offered the button", contentStatus.body?.can_apply === false);
  check("…and is told why", /system plane/i.test(String(contentStatus.body?.apply_blocked_reason)), contentStatus.body?.apply_blocked_reason);
  const contentApply = await devContent("POST", "/api/update/apply");
  check("the content plane cannot apply an update", contentApply.status === 403, contentApply);

  killAll();
  children.length = 0;
  devReg.close();

  // ══ 3. HTTP: paired device vs. system bearer (SURFACE_TRUST_LOOPBACK=0) ══
  // Boot A (loopback trusted) mints a system bearer; boot B trusts nobody, so
  // the two planes are genuinely distinguishable over the same socket.
  const planeData = path.join(scratch, "plane-data");
  const planePort = await claimPort();
  const planeContentPort = await claimPort();
  const planeEnvBase = {
    ...process.env,
    SURFACE_DATA_DIR: planeData,
    SURFACE_BIND: "127.0.0.1",
    SURFACE_PAIR_ON_START: "0",
    PORT: String(planePort),
    SURFACE_CONTENT_PORT: String(planeContentPort),
    NODE_ENV: "test",
  };
  const tsxCli = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const bootPlane = (env: Record<string, string>) => {
    const c = spawn(process.execPath, [tsxCli, "server/index.ts"], {
      cwd: REPO_ROOT, detached: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...planeEnvBase, ...env },
    });
    children.push(c);
    if (process.env.SURFACE_TEST_VERBOSE) {
      c.stdout?.on("data", (d) => process.stdout.write(d));
      c.stderr?.on("data", (d) => process.stderr.write(d));
    }
    return c;
  };
  const plane = makeClient(`http://127.0.0.1:${planePort}`);
  bootPlane({});
  await waitFor(async () => {
    try { return (await plane("GET", "/api/auth/session")).status < 500 ? true : null; } catch { return null; }
  });
  const systemBearer = (await plane("POST", "/api/auth/sessions", { body: { role: "system", label: "agent" } })).body?.token;
  const pairing = (await plane("POST", "/api/auth/pairing-token", { body: { label: "phone" } })).body?.credential;
  check("minted a system bearer and a pairing token", !!systemBearer && !!pairing);
  killAll();
  children.length = 0;
  await waitFor(async () => {
    try { await plane("GET", "/api/auth/session"); return null; } catch { return true; }
  }, 10000);

  bootPlane({ SURFACE_TRUST_LOOPBACK: "0" });
  await waitFor(async () => {
    try { return (await plane("GET", "/api/auth/session")).status < 500 ? true : null; } catch { return null; }
  });
  const anon = await plane("GET", "/api/update/status");
  check("release status is not public — an unpaired browser gets 401", anon.status === 401, anon.status);
  const anonApply = await plane("POST", "/api/update/apply");
  check("neither is the apply endpoint", anonApply.status === 401, anonApply.status);

  const boot = await plane("POST", "/api/auth/bootstrap", { body: { credential: pairing, label: "phone" } });
  const deviceCookie = (boot.headers.get("set-cookie") || "").split(";")[0];
  check("paired a device session", !!deviceCookie && boot.body?.role === "device", boot.body);

  const deviceStatus = await plane("GET", "/api/update/status", { cookie: deviceCookie });
  check("a paired device can read the release notice", deviceStatus.status === 200, deviceStatus.status);
  check("…but is not offered the button", deviceStatus.body?.can_apply === false);
  check("…and is told to update from the host", /host/i.test(String(deviceStatus.body?.apply_blocked_reason)), deviceStatus.body?.apply_blocked_reason);
  const deviceApply = await plane("POST", "/api/update/apply", { cookie: deviceCookie });
  check("a paired device cannot install software on the host", deviceApply.status === 403, deviceApply);
  check("…and the refusal names the plane", /system plane/i.test(String(deviceApply.body?.error)), deviceApply.body);

  const systemStatus = await plane("GET", "/api/update/status", { token: systemBearer });
  check("a system bearer reads the same status", systemStatus.status === 200, systemStatus.status);
  const systemApply = await plane("POST", "/api/update/apply", { token: systemBearer });
  check("a system bearer gets past the plane gate (and is stopped by the repo-clone gate)",
    systemApply.status === 409 && /git pull/.test(String(systemApply.body?.error)), systemApply);

  killAll();
  children.length = 0;

  // ══ 4. End-to-end apply inside a fake global install ═════════════════════
  // A copy of the built package under a fake `npm root -g`, a fake `npm` on
  // PATH, and HOME pointed at scratch: `installContext()` resolves to "global"
  // and the whole converger runs for real without touching this machine.
  const fakeHome = path.join(scratch, "global-home");
  const pkgRoot = path.join(fakeHome, "npm-global", "node_modules", "surface-display");
  fs.mkdirSync(path.join(pkgRoot, "dist"), { recursive: true });
  for (const f of ["package.json", "SKILL.md"]) fs.copyFileSync(path.join(REPO_ROOT, f), path.join(pkgRoot, f));
  for (const f of ["server.mjs", "surface.mjs"]) {
    fs.copyFileSync(path.join(REPO_ROOT, "dist", f), path.join(pkgRoot, "dist", f));
  }
  fs.symlinkSync(path.join(REPO_ROOT, "client"), path.join(pkgRoot, "client"), "dir");
  fs.symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(pkgRoot, "node_modules"), "dir");
  const fakeGlobalRoot = path.dirname(pkgRoot);
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).version as string;

  const fakeBin = path.join(scratch, "fake-bin");
  fs.mkdirSync(fakeBin, { recursive: true });
  const writeFakeNpm = (installExit: number) => {
    if (process.platform === "win32") {
      fs.writeFileSync(path.join(fakeBin, "npm.cmd"),
        `@echo off\r\nif "%1"=="root" (\r\necho ${fakeGlobalRoot}\r\nexit /b 0\r\n)\r\n` +
        `echo npm output\r\nexit /b ${installExit}\r\n`);
    } else {
      fs.writeFileSync(path.join(fakeBin, "npm"),
        `#!/bin/sh\nif [ "$1" = "root" ]; then\n  echo "${fakeGlobalRoot}"\n  exit 0\nfi\necho "npm output"\nexit ${installExit}\n`,
        { mode: 0o755 });
    }
  };
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") || "PATH";

  // A service registry entry the server will match itself against by port —
  // it names a unit that does not exist, so `surface upgrade` finds nothing
  // registered and never restarts anything.
  const globalPort = await claimPort();
  const globalContentPort = await claimPort();
  const globalData = path.join(scratch, "global-data");
  const svcName = `surface-updates-test-${process.pid}`;
  fs.mkdirSync(path.join(fakeHome, ".surface", "services"), { recursive: true });
  fs.writeFileSync(
    path.join(fakeHome, ".surface", "services", `${svcName}.json`),
    JSON.stringify({ port: globalPort, contentPort: globalContentPort, dataDir: globalData }, null, 2),
  );

  const globalReg = await stubRegistry("99.0.0");
  const bootGlobal = () => {
    const c = spawn(process.execPath, [path.join(pkgRoot, "dist", "server.mjs")], {
      cwd: globalData,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        [pathKey]: `${fakeBin}${path.delimiter}${process.env[pathKey] || ""}`,
        SURFACE_DATA_DIR: globalData,
        SURFACE_BIND: "127.0.0.1",
        SURFACE_PAIR_ON_START: "0",
        PORT: String(globalPort),
        SURFACE_CONTENT_PORT: String(globalContentPort),
        NODE_ENV: "test",
        SURFACE_UPDATE_CHECK: "1",
        SURFACE_UPDATE_CHECK_DELAY_MS: "200",
        SURFACE_NPM_REGISTRY: globalReg.url,
      },
    });
    children.push(c);
    if (process.env.SURFACE_TEST_VERBOSE) {
      c.stdout?.on("data", (d) => process.stdout.write(d));
      c.stderr?.on("data", (d) => process.stderr.write(d));
    }
    return c;
  };
  fs.mkdirSync(globalData, { recursive: true });

  // ── 4a. an npm install that fails is reported as a failure, not a success ──
  writeFakeNpm(1);
  bootGlobal();
  const globalClient = makeClient(`http://127.0.0.1:${globalPort}`);
  await waitFor(async () => {
    try { return (await globalClient("GET", "/api/auth/session")).status < 500 ? true : null; } catch { return null; }
  });

  const offered = await waitFor(async () => {
    const r = await globalClient("GET", "/api/update/status");
    return r.body?.context === "global" ? r.body : null;
  }, 15000);
  check("a global install is detected as global", offered?.context === "global", offered);
  check("…and IS offered the one-click update", offered?.can_apply === true, offered);
  check("…with no advice to redirect the user elsewhere", offered?.advice === null);

  // single-flight: a run already in progress is refused, not stacked
  fs.writeFileSync(path.join(globalData, "update-state.json"), JSON.stringify({
    phase: "installing", started_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    pid: 1, from: pkgVersion, to: "99.0.0",
  }));
  const busy = await globalClient("POST", "/api/update/apply");
  check("a second update while one is running is refused", busy.status === 409, busy);
  fs.rmSync(path.join(globalData, "update-state.json"), { force: true });

  const failStart = await globalClient("POST", "/api/update/apply");
  check("the update starts (202 Accepted)", failStart.status === 202, failStart);
  const failed = await waitFor(async () => {
    const r = await globalClient("GET", "/api/update/status");
    const run = r.body?.run;
    return run && (run.phase === "done" || run.phase === "failed") ? run : null;
  }, 40000);
  check("a failing npm install ends as failed, never optimistically done", failed?.phase === "failed", failed);
  check("…and the reported error names the npm install", /npm install/.test(String(failed?.error)), failed?.error);
  check("…and the package on disk is untouched",
    JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8")).version === pkgVersion);

  killAll();
  children.length = 0;
  await sleep(500);

  // ── 4b. the happy path, end to end through the real converger ──
  writeFakeNpm(0);
  fs.rmSync(path.join(globalData, "update-state.json"), { force: true });
  bootGlobal();
  await waitFor(async () => {
    try { return (await globalClient("GET", "/api/auth/session")).status < 500 ? true : null; } catch { return null; }
  });
  const started = await globalClient("POST", "/api/update/apply");
  check("the update starts from the system plane", started.status === 202, started);
  const done = await waitFor(async () => {
    const r = await globalClient("GET", "/api/update/status");
    const run = r.body?.run;
    return run && (run.phase === "done" || run.phase === "failed") ? run : null;
  }, 60000);
  check("the run reaches done", done?.phase === "done", done);
  check("…targeting the version the registry advertised", done?.to === "99.0.0", done);
  check("…and it ran the real converger (skill synced into the sandbox HOME)",
    fs.existsSync(path.join(globalData, "skills", "surface", "SKILL.md")));
  check("…without registering or restarting any service on this machine",
    !fs.existsSync(path.join(fakeHome, ".config", "systemd", "user", `${svcName}.service`)));
  const progress = JSON.parse(fs.readFileSync(path.join(globalData, "update-state.json"), "utf8"));
  check("the progress file survives as the record of the run", progress.phase === "done", progress);

  killAll();
  children.length = 0;
  globalReg.close();

  // ── 4c. boot reconciliation: a run cut short by its own restart ──
  // The upgrade child is killed by the restart it triggers, so the file can be
  // left at "restarting" forever. The next boot must resolve it honestly.
  fs.writeFileSync(path.join(globalData, "update-state.json"), JSON.stringify({
    phase: "restarting", started_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    pid: 1, from: "0.0.1", to: "99.0.0",
  }));
  const deadReg = await stubRegistry(null);
  const reconcileReg = deadReg;
  bootGlobal();
  await waitFor(async () => {
    try { return (await globalClient("GET", "/api/auth/session")).status < 500 ? true : null; } catch { return null; }
  });
  const reconciled = (await globalClient("GET", "/api/update/status")).body?.run;
  check("a restart that never landed the version is reported failed on boot", reconciled?.phase === "failed", reconciled);
  check("…naming the version actually running", String(reconciled?.error).includes(pkgVersion), reconciled?.error);

  killAll();
  children.length = 0;
  reconcileReg.close();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.error(`  FAILED: ${f}`);
    process.exitCode = 1;
  } else {
    console.log("Update-notification tests passed");
  }
} finally {
  killAll();
  cleanupDir(scratch);
}
