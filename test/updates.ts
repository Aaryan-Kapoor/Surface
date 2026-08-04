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

// Collect everything a plane is pushed over SSE for a while, so "the secret is
// never broadcast" is checked against the bytes on the wire.
function collectSSE(url: string, ms: number): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    const req = http.get(url, (res) => {
      text += `HTTP ${res.statusCode}\n`;
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
    });
    req.on("error", (e) => { text += `error ${e.message}`; });
    setTimeout(() => { req.destroy(); resolve(text); }, ms).unref();
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

  // ── chooseRunRecord: a missing file must not un-start a run we spawned ──
  // The single-flight guard reads this. The detached child needs a node boot to
  // write its first record; if an absent file could clear the live in-memory
  // run, a second POST arriving inside that window starts a SECOND global npm
  // install and a second service restart.
  const mine = { ...restarting, phase: "checking" as const, run_id: "run-a" };
  check(
    "a live run we started survives its progress file not existing yet",
    updates.chooseRunRecord(mine, null, "run-a") === mine,
  );
  check(
    "…and survives a record belonging to some other run",
    updates.chooseRunRecord(mine, { ...restarting, run_id: "run-b" }, "run-a") === mine,
  );
  const ours = { ...restarting, phase: "installing" as const, run_id: "run-a" };
  check(
    "…but its own child's newer record replaces it",
    updates.chooseRunRecord(mine, ours, "run-a") === ours,
  );
  check(
    "a finished run defers to the file again",
    updates.chooseRunRecord({ ...mine, phase: "done" }, null, "run-a") === null,
  );
  check(
    "a run we merely adopted from disk is dropped when the file goes",
    updates.chooseRunRecord({ ...restarting, run_id: null }, null, "run-a") === null,
  );
  check(
    "a run from before a restart is dropped when the file goes",
    updates.chooseRunRecord(mine, null, null) === null,
  );

  // ── the two halves of self-healing have to compose ──
  // An update abandoned mid-flight (the machine slept, the child was killed)
  // blocks the Update button until its claim resolves to `failed`. That
  // recovery only reaches disk because reconcileRunFile persists on
  // `raw === disk` — an IDENTITY check on whatever chooseRunRecord returned.
  // So chooseRunRecord returning an equal-but-copied record, or reconcileRun
  // failing to age the claim out, each turn a 10-minute block into a
  // permanent one with no way back except deleting the file by hand. The two
  // are unit-tested apart; this pins them together.
  const abandonedId = "run-abandoned";
  const onDisk = {
    ...restarting,
    phase: "installing" as const,
    run_id: abandonedId,
    updated_at: new Date(now - 11 * 60 * 1000).toISOString(),
  };
  const inMemory = { ...onDisk };
  const chosen = updates.chooseRunRecord(inMemory, onDisk, abandonedId);
  check(
    "an abandoned claim resolves against the disk record itself, not a copy",
    chosen === onDisk,
  );
  check(
    "…and ages out to failed, which is what unblocks a retry",
    updates.reconcileRun(chosen, { version: "0.2.3", now, booted: false })?.phase === "failed",
  );
  check(
    "…and the same holds for a claim this process only adopted",
    updates.chooseRunRecord({ ...onDisk, run_id: abandonedId }, onDisk, null) === onDisk,
  );

  // ── registry URLs are laundered before they can reach an error string ──
  // SURFACE_NPM_REGISTRY is how a private registry is pointed at, and it
  // routinely carries a token. Node rejects a credential-bearing URL with an
  // error naming the whole URL, and that error is stored as `check_error` /
  // written into the progress file — both of which GET /api/update/status
  // serves to DEVICES and SSE broadcasts.
  const upgrade = await import("../bin/upgrade.js");
  check(
    "userinfo is stripped from a registry URL",
    upgrade.sanitizeUrl("https://tok3n:s3cr3t@registry.internal/x") === "https://registry.internal/x",
  );
  check(
    "…as are the query and fragment, where tokens also hide",
    upgrade.sanitizeUrl("https://registry.internal/x?_auth=s3cr3t#s3cr3t") === "https://registry.internal/x",
  );
  check(
    "…and an unparseable URL is dropped entirely rather than guessed at",
    upgrade.sanitizeUrl("http://[not a url") === "[redacted url]",
  );
  const nodeStyleError =
    "Request cannot be constructed from a URL that includes credentials: https://tok3n:s3cr3t@registry.internal/surface-display/latest";
  check(
    "a URL embedded in someone else's error message is laundered too",
    !upgrade.redactUrls(nodeStyleError).includes("s3cr3t"),
    upgrade.redactUrls(nodeStyleError),
  );
  check(
    "…while leaving the message readable",
    /registry\.internal\/surface-display\/latest/.test(upgrade.redactUrls(nodeStyleError)),
    upgrade.redactUrls(nodeStyleError),
  );

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

  // "Status is cache-only, never the network" is the claim the whole feature
  // rests on: /api/update/status is device-readable and is broadcast over SSE,
  // so a status read that reached the registry would put registry traffic (and
  // any credential in that URL) behind a device request.
  const hitsBefore = reg.hits();
  check("the check that filled the cache did reach the registry", hitsBefore > 0, hitsBefore);
  const cached = updates.updateStatus();
  check(
    "updateStatus() serves the cache without touching the registry",
    reg.hits() === hitsBefore && cached.latest === "9.9.9",
    { hitsBefore, hitsAfter: reg.hits(), cached },
  );
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

  // a credentialed registry: whatever went wrong, the token is not the story
  const REGISTRY_SECRET = "s3cr3t-npm-token";
  process.env.SURFACE_NPM_REGISTRY = `https://npm-user:${REGISTRY_SECRET}@127.0.0.1:9/private`;
  await updates.runUpdateCheck();
  status = updates.updateStatus();
  check("a check against a credentialed registry still records an error", !!status.check_error, status);
  check(
    "…which does not contain the registry credentials",
    !JSON.stringify(status).includes(REGISTRY_SECRET),
    status.check_error,
  );
  check(
    "…and the device projection tells a device nothing about the host at all",
    updates.updateStatusFor("device").check_error === "the last release check failed",
    updates.updateStatusFor("device").check_error,
  );
  check(
    "…while the system plane still gets the real (laundered) message",
    updates.updateStatusFor("system").check_error === status.check_error,
  );
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

  // ══ 2b. a registry credential must not reach a device, by any route ══════
  // GET /api/update/status is deliberately device-readable and is broadcast
  // over SSE, so anything the check writes into `check_error` reaches the
  // lower-trust plane. If SURFACE_NPM_REGISTRY carries a token, that includes
  // the token — Node's own error for a credential-bearing URL quotes the whole
  // URL back. Both the HTTP payload and the wire bytes are checked here.
  const SSE_SECRET = "s3cr3t-npm-token";
  const credData = path.join(scratch, "cred-data");
  const credPort = await claimPort();
  const credContentPort = await claimPort();
  const credChild = spawn(process.execPath, [path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs"), "server/index.ts"], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      SURFACE_DATA_DIR: credData,
      SURFACE_BIND: "127.0.0.1",
      SURFACE_PAIR_ON_START: "0",
      PORT: String(credPort),
      SURFACE_CONTENT_PORT: String(credContentPort),
      NODE_ENV: "test",
      SURFACE_UPDATE_CHECK: "1",
      // Late enough that the SSE listener below is connected before the check
      // runs, so the broadcast is genuinely observed and not merely assumed.
      SURFACE_UPDATE_CHECK_DELAY_MS: "3000",
      SURFACE_NPM_REGISTRY: `https://npm-user:${SSE_SECRET}@127.0.0.1:9/private`,
    },
  });
  children.push(credChild);
  if (process.env.SURFACE_TEST_VERBOSE) {
    credChild.stdout?.on("data", (d) => process.stdout.write(d));
    credChild.stderr?.on("data", (d) => process.stderr.write(d));
  }
  const credSystem = makeClient(`http://127.0.0.1:${credPort}`);
  const credDevice = makeClient(`http://127.0.0.1:${credContentPort}`);
  await waitFor(async () => {
    try { return (await credSystem("GET", "/api/auth/session")).status < 500 ? true : null; } catch { return null; }
  });
  const deviceStream = collectSSE(`http://127.0.0.1:${credContentPort}/stream`, 9000);
  const credFailed = await waitFor(async () => {
    const r = await credSystem("GET", "/api/update/status");
    return r.body?.check_error ? r.body : null;
  }, 15000);
  check("the credentialed registry check fails and is recorded", !!credFailed, credFailed);
  check(
    "the system-plane status never carries the registry credentials",
    !JSON.stringify(credFailed).includes(SSE_SECRET),
    credFailed?.check_error,
  );
  const credDeviceStatus = await credDevice("GET", "/api/update/status");
  check("the device-readable status carries no credentials", !JSON.stringify(credDeviceStatus.body).includes(SSE_SECRET), credDeviceStatus.body);
  check(
    "…and no host-side diagnostic at all",
    credDeviceStatus.body?.check_error === "the last release check failed",
    credDeviceStatus.body?.check_error,
  );
  const streamed = await deviceStream;
  check("the SSE stream did broadcast the release status to the device plane", /update_status/.test(streamed), streamed.slice(0, 200));
  check("…and the broadcast carries no credentials", !streamed.includes(SSE_SECRET), streamed.slice(0, 400));

  killAll();
  children.length = 0;

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
  const pkgJsonPath = path.join(pkgRoot, "package.json");
  const npmCalls = path.join(scratch, "npm-calls.log");
  // The fake npm records every invocation, so "exactly one updater ran" is an
  // assertion and not an inference.
  const installCount = () => {
    if (!fs.existsSync(npmCalls)) return 0;
    return fs.readFileSync(npmCalls, "utf8").split("\n").filter((l) => l.includes("install")).length;
  };
  // A real `npm install -g` REPLACES the package on disk. A fixture that skips
  // that step lets a bug where the installed version is never checked look like
  // a passing happy path, so the fake writes the new version itself.
  const bumpScript = path.join(fakeBin, "bump-version.mjs");
  fs.writeFileSync(bumpScript,
    `import fs from "node:fs";\n` +
    `const [, , file, version] = process.argv;\n` +
    `const pkg = JSON.parse(fs.readFileSync(file, "utf8"));\n` +
    `pkg.version = version;\n` +
    `fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\\n");\n`);
  const writeFakeNpm = (installExit: number, opts: { installs?: string; delayMs?: number } = {}) => {
    const bump = opts.installs
      ? `"${process.execPath}" "${bumpScript}" "${pkgJsonPath}" "${opts.installs}"`
      : "";
    if (process.platform === "win32") {
      fs.writeFileSync(path.join(fakeBin, "npm.cmd"),
        `@echo off\r\nif "%1"=="root" (\r\necho ${fakeGlobalRoot}\r\nexit /b 0\r\n)\r\n` +
        `echo %* >> "${npmCalls}"\r\necho npm output\r\n` +
        (opts.delayMs ? `ping -n ${Math.ceil(opts.delayMs / 1000) + 1} 127.0.0.1 >nul\r\n` : "") +
        (bump ? `${bump}\r\n` : "") +
        `exit /b ${installExit}\r\n`);
    } else {
      fs.writeFileSync(path.join(fakeBin, "npm"),
        `#!/bin/sh\nif [ "$1" = "root" ]; then\n  echo "${fakeGlobalRoot}"\n  exit 0\nfi\n` +
        `echo "$@" >> "${npmCalls}"\necho "npm output"\n` +
        (opts.delayMs ? `sleep ${(opts.delayMs / 1000).toFixed(2)}\n` : "") +
        (bump ? `${bump}\n` : "") +
        `exit ${installExit}\n`,
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

  // ── 4b. single-flight: two immediate POSTs must not stack two updaters ──
  // The window the old code lost: after the first POST returns, the detached
  // child has not written its first progress record yet (node is still
  // booting). Re-reading a missing file resolved to null and cleared the live
  // in-memory run, so the second POST sailed past the guard — two global npm
  // installs and two service restarts writing one progress file.
  writeFakeNpm(1, { delayMs: 1500 });
  fs.rmSync(npmCalls, { force: true });
  fs.rmSync(path.join(globalData, "update-state.json"), { force: true });
  bootGlobal();
  await waitFor(async () => {
    try { return (await globalClient("GET", "/api/auth/session")).status < 500 ? true : null; } catch { return null; }
  });
  const racers = await Promise.all([
    globalClient("POST", "/api/update/apply"),
    globalClient("POST", "/api/update/apply"),
  ]);
  const accepted = racers.filter((r) => r.status === 202);
  const refused = racers.filter((r) => r.status === 409);
  check("exactly one of two simultaneous updates is accepted", accepted.length === 1, racers.map((r) => r.status));
  check("…and the other is refused as already running", refused.length === 1 && /already running/i.test(String(refused[0]?.body?.error)), refused[0]?.body);
  const raced = await waitFor(async () => {
    const r = await globalClient("GET", "/api/update/status");
    const run = r.body?.run;
    return run && (run.phase === "done" || run.phase === "failed") ? run : null;
  }, 40000);
  check("the single run finishes", !!raced, raced);
  await sleep(500);
  check("exactly one updater actually ran npm install", installCount() === 1, installCount());

  killAll();
  children.length = 0;
  await sleep(500);

  // ── 4c. npm exits 0 but the package on disk did not change → failed ──
  // A zero exit is npm saying "I finished", not "the new version is installed".
  // Reporting `done` from an unchanged package is the exact dishonesty the
  // progress file exists to prevent.
  writeFakeNpm(0);
  fs.rmSync(npmCalls, { force: true });
  fs.rmSync(path.join(globalData, "update-state.json"), { force: true });
  bootGlobal();
  await waitFor(async () => {
    try { return (await globalClient("GET", "/api/auth/session")).status < 500 ? true : null; } catch { return null; }
  });
  check("the update starts", (await globalClient("POST", "/api/update/apply")).status === 202);
  const lied = await waitFor(async () => {
    const r = await globalClient("GET", "/api/update/status");
    const run = r.body?.run;
    return run && (run.phase === "done" || run.phase === "failed") ? run : null;
  }, 60000);
  check("a zero-exit npm that changed nothing is reported failed, not done", lied?.phase === "failed", lied);
  check("…and the error names the version still on disk", String(lied?.error).includes(pkgVersion), lied?.error);
  check("…and never claims the new version was installed", lied?.installed !== "99.0.0", lied);

  killAll();
  children.length = 0;
  await sleep(500);

  // ── 4d. the happy path, end to end through the real converger ──
  // The fake npm now does what a real one does: it replaces the package on
  // disk. Without that the run reaches `done` with installed === current, which
  // is the state 4c proves must fail.
  writeFakeNpm(0, { installs: "99.0.0" });
  fs.rmSync(npmCalls, { force: true });
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
  check("…and reports the version that is genuinely on disk now", done?.installed === "99.0.0", done);
  check("…which is the version the package really holds",
    JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8")).version === "99.0.0");
  check("…and it ran the real converger (skill synced into the sandbox HOME)",
    fs.existsSync(path.join(globalData, "skills", "surface", "SKILL.md")));
  check("…without registering or restarting any service on this machine",
    !fs.existsSync(path.join(fakeHome, ".config", "systemd", "user", `${svcName}.service`)));
  const progress = JSON.parse(fs.readFileSync(path.join(globalData, "update-state.json"), "utf8"));
  check("the progress file survives as the record of the run", progress.phase === "done", progress);

  killAll();
  children.length = 0;
  globalReg.close();

  // Put the sandbox package back where 4e expects it: the boot-reconciliation
  // case needs a server whose own version is OLDER than the run's target.
  fs.writeFileSync(pkgJsonPath, JSON.stringify(
    { ...JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")), version: pkgVersion }, null, 2) + "\n");

  // ── 4e. boot reconciliation: a run cut short by its own restart ──
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
