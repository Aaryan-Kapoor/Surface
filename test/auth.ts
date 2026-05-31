import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Acceptance tests for the pairing/session auth system. We spawn a real server
// with SURFACE_TRUST_LOOPBACK=0 so the auth gate is exercised even though the
// test client connects over loopback. A static SURFACE_TOKEN is set so the test
// can mint pairing tokens through the owner-only API to bootstrap the flow.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const STATIC_TOKEN = "test-owner-static-token";

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
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
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

async function main() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "surface-auth-"));
  const req = makeClient(base);

  console.log(`\n=== Surface Auth Acceptance Tests ===`);
  console.log(`Port: ${port}  DataDir: ${dataDir}\n`);

  const child: ChildProcess = spawn("npx", ["tsx", "server/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      SURFACE_DATA_DIR: dataDir,
      SURFACE_TRUST_LOOPBACK: "0",
      SURFACE_TOKEN: STATIC_TOKEN,
      SURFACE_BIND: "127.0.0.1",
      SURFACE_PAIR_ON_START: "0",
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", (d) => process.env.SURFACE_TEST_VERBOSE && process.stderr.write(d));

  const cleanup = () => {
    try { child.kill("SIGKILL"); } catch {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  };

  try {
    await waitForReady(req);

    // ── Unauthenticated baseline ──
    const sess0 = await req("GET", "/api/auth/session");
    check("unauthenticated session reports authenticated:false", sess0.body?.authenticated === false, sess0.body);

    const surf401 = await req("GET", "/surfaces");
    check("unauthenticated GET /surfaces is rejected", surf401.status === 401, surf401.status);

    const stream401 = await req("GET", "/stream");
    check("unauthenticated GET /stream is rejected", stream401.status === 401, stream401.status);

    // ── Mint + one-time consumption ──
    const mint = await req("POST", "/api/auth/pairing-token", {
      token: STATIC_TOKEN,
      body: { label: "Chrome on Test" },
    });
    check("owner can mint a pairing token", mint.status === 200 && !!mint.body?.credential, mint.body);
    check("pairing token response includes pairingUrl with fragment", typeof mint.body?.pairingUrl === "string" && mint.body.pairingUrl.includes("/pair#token="), mint.body?.pairingUrl);
    const credential = mint.body.credential as string;

    const boot1 = await req("POST", "/api/auth/bootstrap", { body: { credential, label: "Chrome on Test" } });
    check("one-time token creates a session", boot1.status === 200 && boot1.body?.authenticated === true, boot1.body);
    const sessionCookie = sessionCookieFrom(boot1);
    check("bootstrap sets surface_session cookie", !!sessionCookie, boot1.headers.get("set-cookie"));
    const bootSessionId = boot1.body?.sessionId as string;

    const boot2 = await req("POST", "/api/auth/bootstrap", { body: { credential } });
    check("reused pairing token fails", boot2.status === 401, boot2.status);

    // ── Expired token ──
    const mintExp = await req("POST", "/api/auth/pairing-token", { token: STATIC_TOKEN, body: { ttlSeconds: 1 } });
    await sleep(1300);
    const bootExp = await req("POST", "/api/auth/bootstrap", { body: { credential: mintExp.body.credential } });
    check("expired pairing token fails", bootExp.status === 401, bootExp.status);

    // ── Revoked token ──
    const mintRev = await req("POST", "/api/auth/pairing-token", { token: STATIC_TOKEN, body: {} });
    const revT = await req("POST", "/api/auth/pairing-tokens/revoke", { token: STATIC_TOKEN, body: { id: mintRev.body.id } });
    check("owner can revoke a pairing token", revT.body?.revoked === true, revT.body);
    const bootRev = await req("POST", "/api/auth/bootstrap", { body: { credential: mintRev.body.credential } });
    check("revoked pairing token fails", bootRev.status === 401, bootRev.status);

    // ── Cookie-auth ──
    const cookieReq = await req("GET", "/surfaces", { cookie: sessionCookie! });
    check("cookie-auth browser request passes", cookieReq.status === 200, cookieReq.status);

    // ── Bearer-auth (directly issued session for CLI/agents) ──
    const issued = await req("POST", "/api/auth/sessions", { token: STATIC_TOKEN, body: { label: "agent" } });
    check("owner can issue a session directly", issued.status === 200 && !!issued.body?.token, issued.body);
    const bearerReq = await req("GET", "/surfaces", { token: issued.body.token });
    check("bearer-auth CLI request passes", bearerReq.status === 200, bearerReq.status);

    // ── Paired browser can use SSE ──
    const ac = new AbortController();
    let sseStatus = 0;
    let sseType = "";
    try {
      const sseRes = await fetch(`${base}/stream`, {
        headers: { Cookie: sessionCookie!, Accept: "text/event-stream" },
        signal: ac.signal,
      });
      sseStatus = sseRes.status;
      sseType = sseRes.headers.get("content-type") || "";
      ac.abort();
    } catch {
      ac.abort();
    }
    check("paired browser can open SSE /stream", sseStatus === 200 && sseType.includes("text/event-stream"), { sseStatus, sseType });

    // ── Owner can list sessions ──
    const clients = await req("GET", "/api/auth/clients", { token: STATIC_TOKEN });
    const ids = Array.isArray(clients.body) ? clients.body.map((c: any) => c.id) : [];
    check("owner can list active sessions", clients.status === 200 && ids.includes(bootSessionId), ids);

    // ── Revoked session immediately loses access ──
    const revS = await req("POST", "/api/auth/clients/revoke", { token: STATIC_TOKEN, body: { id: bootSessionId } });
    check("owner can revoke a session", revS.body?.revoked === true, revS.body);
    const afterRevoke = await req("GET", "/surfaces", { cookie: sessionCookie! });
    check("revoked session immediately loses access", afterRevoke.status === 401, afterRevoke.status);

    // ── Logout clears the issued bearer session ──
    const logout = await req("POST", "/api/auth/logout", { token: issued.body.token });
    check("logout revokes the current session", logout.body?.revoked === true, logout.body);
    const afterLogout = await req("GET", "/surfaces", { token: issued.body.token });
    check("logged-out bearer token loses access", afterLogout.status === 401, afterLogout.status);

    console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  } finally {
    cleanup();
  }

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Auth test harness failed:", err);
  process.exit(1);
});
