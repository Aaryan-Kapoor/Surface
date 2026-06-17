import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Acceptance tests for the two-plane trust model (docs/auth/trust-model.md).
//
// Boot 1 (trusted loopback — the agent plane): mint a system bearer, exactly
// how an operator prepares remote access before fronting Surface with a proxy.
// Boot 2 (SURFACE_TRUST_LOOPBACK=0 — every request must authenticate): exercise
// pairing, device sessions, and the system/device capability split using only
// that bearer and paired cookies.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.error(`  FAIL  ${name}${detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error("could not acquire port"));
      }
    });
  });
}

interface Res {
  status: number;
  headers: Headers;
  body: any;
}

function makeClient(base: string) {
  return async function req(
    method: string,
    pathname: string,
    opts: { token?: string; cookie?: string; body?: unknown; signal?: AbortSignal } = {},
  ): Promise<Res> {
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
    if (opts.cookie) headers["Cookie"] = opts.cookie;
    // Every request gets a deadline: a misbehaving endpoint (e.g. an SSE
    // stream that should have 401'd) must fail the test, not hang it.
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal ?? AbortSignal.timeout(10000),
    });
    let body: any = null;
    const text = await res.text();
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, headers: res.headers, body };
  };
}

function sessionCookieFrom(res: Res): string | null {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) return null;
  const m = setCookie.match(/surface_session=([^;]+)/);
  return m ? `surface_session=${m[1]}` : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForReady(req: ReturnType<typeof makeClient>, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await req("GET", "/api/auth/session");
      if (r.status === 200) return;
    } catch {
      // not up yet
    }
    await sleep(200);
  }
  throw new Error("server did not become ready in time");
}

// Spawn tsx directly (not through npx) in its own process group so killServer
// can take down the whole tree — killing a wrapper while the real server
// survives is how orphaned test servers kept squatting on ports.
function spawnServer(port: number, dataDir: string, env: Record<string, string>): ChildProcess {
  const tsxBin = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
  const child = spawn(tsxBin, ["server/index.ts"], {
    cwd: REPO_ROOT,
    detached: true,
    env: {
      ...process.env,
      SURFACE_DATA_DIR: dataDir,
      SURFACE_BIND: "127.0.0.1",
      SURFACE_PAIR_ON_START: "0",
      PORT: String(port),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", (d) => process.env.SURFACE_TEST_VERBOSE && process.stderr.write(d));
  return child;
}

async function killServer(child: ChildProcess, port: number): Promise<void> {
  try {
    if (child.pid) process.kill(-child.pid, "SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch {}
  }
  // Wait until the port actually refuses connections so the next boot can't
  // silently land on a survivor.
  const start = Date.now();
  while (Date.now() - start < 10000) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/auth/session`, { signal: AbortSignal.timeout(500) });
    } catch {
      return;
    }
    await sleep(150);
  }
  throw new Error("old server still answering after kill");
}

async function main() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "surface-auth-"));
  const req = makeClient(base);

  console.log(`\n=== Surface Auth Acceptance Tests ===`);
  console.log(`Port: ${port}  DataDir: ${dataDir}\n`);

  let child: ChildProcess | null = null;
  const cleanup = async () => {
    if (child) await killServer(child, port).catch(() => {});
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  };

  try {
    // ── Boot 1: trusted loopback (the agent plane) ──
    child = spawnServer(port, dataDir, {});
    await waitForReady(req);

    const loopbackSess = await req("GET", "/api/auth/session");
    check("loopback resolves to the system role", loopbackSess.body?.role === "system", loopbackSess.body);

    const sysMint = await req("POST", "/api/auth/sessions", { body: { role: "system", label: "test-admin" } });
    check("system bearer can be minted from loopback", sysMint.status === 200 && !!sysMint.body?.token && sysMint.body?.role === "system", sysMint.body);
    const SYS = sysMint.body.token as string;

    const aux = await req("POST", "/api/auth/sessions", { body: { role: "system", label: "logout-fodder" } });
    const AUX = aux.body.token as string;

    await killServer(child, port);
    child = null;

    // ── Boot 2: loopback untrusted — every request authenticates ──
    child = spawnServer(port, dataDir, { SURFACE_TRUST_LOOPBACK: "0" });
    await waitForReady(req);

    const boot2Identity = await req("GET", "/api/auth/session");
    check("boot 2 does not trust loopback", boot2Identity.body?.authenticated === false, boot2Identity.body);

    // Unauthenticated baseline
    const sess0 = await req("GET", "/api/auth/session");
    check("unauthenticated session reports authenticated:false", sess0.body?.authenticated === false, sess0.body);

    const cards401 = await req("GET", "/artifacts");
    check("unauthenticated GET /artifacts is rejected", cards401.status === 401, cards401.status);

    const stream401 = await req("GET", "/stream");
    check("unauthenticated GET /stream is rejected", stream401.status === 401, stream401.status);

    // Sessions survive restarts; the bearer minted in boot 1 still works.
    const bearerAlive = await req("GET", "/artifacts", { token: SYS });
    check("system bearer survives a server restart", bearerAlive.status === 200, bearerAlive.status);

    // ── Mint + one-time consumption (device pairing) ──
    const mint = await req("POST", "/api/auth/pairing-token", { token: SYS, body: { label: "phone" } });
    check("system can mint a pairing token", mint.status === 200 && !!mint.body?.credential, mint.body);
    check("pairing tokens mint device sessions", mint.body?.role === "device", mint.body?.role);
    check("pairing token response includes pairingUrl with fragment", typeof mint.body?.pairingUrl === "string" && mint.body.pairingUrl.includes("/pair#token="), mint.body?.pairingUrl);
    const credential = mint.body.credential as string;

    const boot1 = await req("POST", "/api/auth/bootstrap", { body: { credential, label: "phone" } });
    check("one-time token creates a session", boot1.status === 200 && boot1.body?.authenticated === true, boot1.body);
    check("paired session has the device role", boot1.body?.role === "device", boot1.body?.role);
    const sessionCookie = sessionCookieFrom(boot1);
    check("bootstrap sets surface_session cookie", !!sessionCookie, boot1.headers.get("set-cookie"));
    const bootSessionId = boot1.body?.sessionId as string;

    const boot2 = await req("POST", "/api/auth/bootstrap", { body: { credential } });
    check("reused pairing token fails", boot2.status === 401, boot2.status);

    // ── Expired token ──
    const mintExp = await req("POST", "/api/auth/pairing-token", { token: SYS, body: { ttlSeconds: 1 } });
    await sleep(1300);
    const bootExp = await req("POST", "/api/auth/bootstrap", { body: { credential: mintExp.body.credential } });
    check("expired pairing token fails", bootExp.status === 401, bootExp.status);

    // ── Revoked token ──
    const mintRev = await req("POST", "/api/auth/pairing-token", { token: SYS, body: {} });
    const revT = await req("POST", "/api/auth/pairing-tokens/revoke", { token: SYS, body: { id: mintRev.body.id } });
    check("system can revoke a pairing token", revT.body?.revoked === true, revT.body);
    const bootRev = await req("POST", "/api/auth/bootstrap", { body: { credential: mintRev.body.credential } });
    check("revoked pairing token fails", bootRev.status === 401, bootRev.status);

    // ── Device capabilities ──
    const cookieReq = await req("GET", "/artifacts", { cookie: sessionCookie! });
    check("device can list surfaces", cookieReq.status === 200, cookieReq.status);

    const devCreate = await req("POST", "/artifacts", {
      cookie: sessionCookie!,
      body: { title: "From the phone", mime: "text/html", content: "<p>hi</p>" },
    });
    check("device can create a workspace artifact", devCreate.status === 201, { status: devCreate.status, body: devCreate.body });
    const devArtifactId = devCreate.body?.artifact?.id as string;

    const devAction = await req("POST", `/artifacts/${devArtifactId}/actions`, {
      cookie: sessionCookie!,
      body: { action: "tap", data: { x: 1 } },
    });
    check("device can post an action (click)", devAction.status === 201, devAction.status);

    // A device may update the artifact IT authored.
    const devUpdateOwn = await req("PUT", `/artifacts/${devArtifactId}`, {
      cookie: sessionCookie!,
      body: { content: "<p>edited from the phone</p>" },
    });
    check("device can update its own artifact", devUpdateOwn.status === 200, devUpdateOwn.status);

    // display_role (slot assignment) is stripped from device-supplied metadata,
    // and the artifact is stamped with the device authoring plane.
    const devSlot = await req("POST", "/artifacts", {
      cookie: sessionCookie!,
      body: { title: "sneaky slot", mime: "text/html", content: "<p>x</p>", metadata: { display_role: "renderer" } },
    });
    const devSlotMeta = JSON.parse(devSlot.body?.artifact?.metadata || "{}");
    check("device cannot assign display_role", devSlotMeta.display_role === undefined, devSlotMeta);
    check("device artifact is stamped device plane", devSlotMeta.author_plane === "device", devSlotMeta);

    // A system-authored artifact cannot be modified by a device (could inject JS
    // into a surface the host display renders with system trust).
    const sysArt = await req("POST", "/artifacts", {
      token: SYS,
      body: { title: "agent made", mime: "text/html", content: "<p>sys</p>" },
    });
    const sysArtId = sysArt.body?.artifact?.id as string;
    check("system artifact is stamped system plane", JSON.parse(sysArt.body?.artifact?.metadata || "{}").author_plane === "system", sysArt.body);

    const devTamper = await req("PUT", `/artifacts/${sysArtId}`, {
      cookie: sessionCookie!,
      body: { content: "<script>steal()</script>" },
    });
    check("device cannot modify a system-authored artifact", devTamper.status === 403, devTamper.status);

    const devRollback = await req("POST", `/artifacts/${sysArtId}/rollback`, {
      cookie: sessionCookie!,
      body: { version: 1 },
    });
    check("device cannot rollback a system-authored artifact", devRollback.status === 403, devRollback.status);

    const devDeleteSys = await req("DELETE", `/artifacts/${sysArtId}`, { cookie: sessionCookie! });
    check("device cannot delete a system-authored artifact", devDeleteSys.status === 403, devDeleteSys.status);

    // ...but a device can delete an artifact it authored.
    const devDeleteOwn = await req("DELETE", `/artifacts/${devSlot.body?.artifact?.id}`, { cookie: sessionCookie! });
    check("device can delete its own artifact", devDeleteOwn.status === 200, devDeleteOwn.status);

    // Third-party proxies are system-only (spend credentials / outbound network).
    const devChat = await req("POST", "/api/chat", { cookie: sessionCookie!, body: { messages: [] } });
    check("device cannot use the LLM proxy", devChat.status === 403, devChat.status);

    const devTemplates = await req("GET", "/api/templates", { cookie: sessionCookie! });
    check("device cannot list templates (reads project FS)", devTemplates.status === 403, devTemplates.status);

    // Display control (theme/navigate/notify/reset) is an agent-plane push:
    // a device renders what it's shown but cannot drive what other screens show.
    const devTheme = await req("PUT", "/display/config", { cookie: sessionCookie!, body: { title: "Phone set this" } });
    check("device cannot use display control (theme)", devTheme.status === 403, devTheme.status);

    const devNavigate = await req("POST", "/display/navigate", { cookie: sessionCookie!, body: { surface_id: null } });
    check("device cannot force navigation", devNavigate.status === 403, devNavigate.status);

    const devNotify = await req("POST", "/display/notify", { cookie: sessionCookie!, body: { text: "hi" } });
    check("device cannot push notifications", devNotify.status === 403, devNotify.status);

    const devLink = await req("POST", "/artifacts/link", {
      cookie: sessionCookie!,
      body: { path: "/etc/hostname", title: "nope" },
    });
    check("device cannot link disk paths", devLink.status === 403, devLink.status);

    const devPresent = await req("POST", "/artifacts/present-file", {
      cookie: sessionCookie!,
      body: { path: "/etc/hostname" },
    });
    check("device cannot present files", devPresent.status === 403, devPresent.status);

    const devExec = await req("POST", `/artifacts/${devArtifactId}/exec`, {
      cookie: sessionCookie!,
      body: { js: "1+1" },
    });
    check("device cannot exec JS", devExec.status === 403, devExec.status);

    const devInbox = await req("GET", "/actions", { cookie: sessionCookie! });
    check("device cannot read the action inbox", devInbox.status === 403, devInbox.status);

    const devState = await req("PATCH", `/artifacts/${devArtifactId}/state`, {
      cookie: sessionCookie!,
      body: { hacked: true },
    });
    check("device cannot write surface state", devState.status === 403, devState.status);

    const devStateRead = await req("GET", `/artifacts/${devArtifactId}/state`, { cookie: sessionCookie! });
    check("device can read surface state", devStateRead.status === 200, devStateRead.status);

    const devPairMint = await req("POST", "/api/auth/pairing-token", { cookie: sessionCookie!, body: {} });
    check("device cannot mint pairing tokens", devPairMint.status === 403, devPairMint.status);

    // System plane can drain what the device clicked.
    const sysInbox = await req("GET", `/artifacts/${devArtifactId}/actions`, { token: SYS });
    check("system reads the pending action", sysInbox.status === 200 && sysInbox.body?.some?.((a: any) => a.action === "tap"), sysInbox.body);

    // ── Device registry ──
    const devices = await req("GET", "/api/auth/devices", { token: SYS });
    const deviceLabels = Array.isArray(devices.body) ? devices.body.map((d: any) => d.label) : [];
    check("devices list shows the paired phone", devices.status === 200 && deviceLabels.includes("phone"), deviceLabels);

    const revAmbig = await req("POST", "/api/auth/devices/revoke", { token: SYS, body: { device: "ph" } });
    check("revoke by unambiguous label prefix works", revAmbig.status === 200 && revAmbig.body?.revoked === true, revAmbig.body);

    const afterRevoke = await req("GET", "/artifacts", { cookie: sessionCookie! });
    check("revoked device immediately loses access", afterRevoke.status === 401, afterRevoke.status);

    // ── Session listing / logout ──
    const clients = await req("GET", "/api/auth/clients", { token: SYS });
    const ids = Array.isArray(clients.body) ? clients.body.map((c: any) => c.id) : [];
    check("system can list active sessions", clients.status === 200 && !ids.includes(bootSessionId), ids);

    const logout = await req("POST", "/api/auth/logout", { token: AUX });
    check("logout revokes the current session", logout.body?.revoked === true, logout.body);
    const afterLogout = await req("GET", "/artifacts", { token: AUX });
    check("logged-out bearer token loses access", afterLogout.status === 401, afterLogout.status);

    console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  } finally {
    await cleanup();
  }

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Auth test harness failed:", err);
  process.exit(1);
});
