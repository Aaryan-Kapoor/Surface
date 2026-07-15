import "dotenv/config";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { initDb, getDb, closeDb } from "./db.js";
import { cleanupActions } from "./actionsStore.js";
import { router } from "./routes/index.js";
import { gcArtifactStorage, listArtifactCards } from "./artifacts.js";
import { SESSION_COOKIE, createPairingToken, readCookie, verifySession } from "./auth.js";
import { jsonErrorMiddleware, sendError } from "./errors.js";
import {
  buildPairingUrl,
  formatHeadlessAccessOutput,
  resolveConnectionString,
  resolveListeningPort,
} from "./startupAccess.js";
import { setThumbServerPort, enqueueThumb, hasThumb, findChromeBin } from "./thumbs.js";
import { closeSSEClients } from "./sse.js";
import { closeCodexBridge } from "./codexBridge.js";
import { setupFileLogging } from "./logging.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Supervisors that cannot set environment variables (Windows Scheduled Tasks)
// pass flags instead. Flags win over .env and inherited env. This must run
// before any config below is read; everything downstream reads env lazily.
const ARG_TO_ENV: Record<string, string> = {
  "--port": "PORT",
  "--content-port": "SURFACE_CONTENT_PORT",
  "--bind": "SURFACE_BIND",
  "--data-dir": "SURFACE_DATA_DIR",
  "--log-file": "SURFACE_LOG_FILE",
};
for (let i = 2; i < process.argv.length; i++) {
  const envName = ARG_TO_ENV[process.argv[i]];
  const value = process.argv[i + 1];
  if (!envName || value === undefined) {
    console.error(`[startup] unknown or valueless argument ${process.argv[i]}. Accepted: ${Object.keys(ARG_TO_ENV).join(" ")}`);
    process.exit(1);
  }
  process.env[envName] = value;
  i++;
}
if (process.env.SURFACE_LOG_FILE) setupFileLogging(process.env.SURFACE_LOG_FILE);

const PORT = Number(process.env.PORT || 3000);
const BIND = process.env.SURFACE_BIND || "127.0.0.1";
// Second listener serving the same app as the *untrusted content plane*.
// Device-authored surfaces render from this origin so their JavaScript can
// never inherit system trust just by being displayed on the host. See
// docs/auth/trust-model.md and planning/content-origin-scope.md.
const CONTENT_PORT = Number(process.env.SURFACE_CONTENT_PORT || 3100);

// Both listeners must bind valid, distinct ports. The content gate keys off the
// listening port (req.socket.localPort), so a collision would resolve every
// request — including the agent plane's own — to `device`, silently breaking
// system access. Validate up front and fail fast rather than boot into a broken
// or de-privileged state.
function assertPort(name: string, value: number, raw: string | undefined) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    console.error(`[startup] ${name} must be an integer in 1..65535 (got ${JSON.stringify(raw)}). Refusing to start.`);
    process.exit(1);
  }
}
assertPort("PORT", PORT, process.env.PORT);
assertPort("SURFACE_CONTENT_PORT", CONTENT_PORT, process.env.SURFACE_CONTENT_PORT);
if (CONTENT_PORT === PORT) {
  console.error(
    `[content-origin] SURFACE_CONTENT_PORT (${CONTENT_PORT}) must differ from PORT (${PORT}): ` +
    `they share one app and a collision would de-privilege the whole server to 'device'. Refusing to start.`,
  );
  process.exit(1);
}

if (process.env.SURFACE_TOKEN) {
  console.warn(
    "[auth] SURFACE_TOKEN is no longer supported and is ignored. " +
    "Remote agents mint a system bearer instead: surface auth session issue --role system",
  );
}

const LOOPBACK_ADDRS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);
const isLoopbackBind = LOOPBACK_ADDRS.has(BIND);

// Loopback is trusted by default. Operators fronting Surface with a loopback
// reverse proxy (e.g. Tailscale Serve, Caddy) MUST set SURFACE_TRUST_LOOPBACK=0,
// otherwise every proxied request appears to originate from 127.0.0.1 and would
// be trusted unconditionally. See SECURITY.md.
const TRUST_LOOPBACK = !["0", "false", "no"].includes(
  (process.env.SURFACE_TRUST_LOOPBACK || "1").toLowerCase(),
);

// Optional externally reachable origin (e.g. a Tailscale HTTPS hostname). When
// unset and Surface binds a wildcard host, startup output resolves a concrete
// interface address instead of printing unusable 0.0.0.0.
const PUBLIC_BASE_URL = process.env.SURFACE_PUBLIC_URL?.replace(/\/$/, "");

initDb();
gcArtifactStorage(getDb());

// Inbox TTL sweep: at boot and hourly.
const sweep = () => {
  try {
    const { handled, pending } = cleanupActions(getDb());
    if (handled || pending) console.log(`[actions] TTL sweep removed ${handled} handled, ${pending} expired pending`);
  } catch (err) {
    console.error("[actions] TTL sweep failed:", err);
  }
};
sweep();
setInterval(sweep, 60 * 60 * 1000).unref();

const app = express();

function normalizeHost(value: string): string {
  const raw = value.trim().toLowerCase();
  if (!raw) return "";
  const withoutPort = raw.startsWith("[")
    ? raw.slice(1, raw.indexOf("]"))
    : raw.split(":")[0];
  return withoutPort.replace(/^::ffff:/, "");
}

function hostFromUrl(value: string | undefined): string {
  if (!value) return "";
  try { return normalizeHost(new URL(value).hostname); } catch { return ""; }
}

function originFromUrl(value: string | undefined): string {
  if (!value || value === "null") return "";
  try { return new URL(value).origin; } catch { return ""; }
}

function allowedHosts(req: express.Request): Set<string> {
  const hosts = new Set(["localhost", "127.0.0.1", "::1"]);
  if (BIND && !["0.0.0.0", "::", "[::]"].includes(BIND)) hosts.add(normalizeHost(BIND));
  const local = normalizeHost(req.socket.localAddress || "");
  if (local) hosts.add(local);
  const publicHost = hostFromUrl(PUBLIC_BASE_URL);
  if (publicHost) hosts.add(publicHost);
  const contentHost = hostFromUrl(process.env.SURFACE_CONTENT_ORIGIN);
  if (contentHost) hosts.add(contentHost);
  for (const h of (process.env.SURFACE_ALLOWED_HOSTS || "").split(",")) {
    const normalized = normalizeHost(h);
    if (normalized) hosts.add(normalized);
  }
  return hosts;
}

function allowedOrigins(req: express.Request): Set<string> {
  const origins = new Set<string>();
  const host = req.headers.host;
  if (host) origins.add(`http://${host}`);
  const port = req.socket.localPort;
  origins.add(`http://127.0.0.1:${port}`);
  origins.add(`http://localhost:${port}`);
  origins.add(`http://[::1]:${port}`);
  if (port === PORT) {
    const publicOrigin = originFromUrl(PUBLIC_BASE_URL);
    if (publicOrigin) origins.add(publicOrigin);
  }
  if (port === CONTENT_PORT) {
    const contentOrigin = originFromUrl(process.env.SURFACE_CONTENT_ORIGIN);
    if (contentOrigin) origins.add(contentOrigin);
  }
  for (const raw of (process.env.SURFACE_ALLOWED_ORIGINS || "").split(",")) {
    const origin = originFromUrl(raw.trim());
    if (origin) origins.add(origin);
  }
  return origins;
}

// Host/Origin validation must run before loopback auth. Without it, a DNS
// rebinding page can arrive over a loopback socket and inherit system trust.
app.use((req, res, next) => {
  const host = normalizeHost(req.headers.host || "");
  if (!host || !allowedHosts(req).has(host)) {
    sendError(res, 403, "Host header is not allowed");
    return;
  }
  const origins = allowedOrigins(req);
  const origin = originFromUrl(req.headers.origin);
  if (req.headers.origin && (!origin || !origins.has(origin))) {
    sendError(res, 403, "Origin is not allowed");
    return;
  }
  const referer = originFromUrl(req.headers.referer);
  if (req.headers.referer && (!referer || !origins.has(referer))) {
    sendError(res, 403, "Referer is not allowed");
    return;
  }
  next();
});

app.use(express.json({ limit: "10mb" }));

// Unauthenticated browsers can only load the bootstrap shell and exchange a
// one-time pairing token. All data/control endpoints still require auth.
const PUBLIC_BOOTSTRAP_GET_PATHS = new Set([
  "/",
  "/index.html",
  "/app.js",
  "/style.css",
  "/manifest.json",
  "/pair",
  "/pair.html",
  "/favicon.ico",
]);

function isPublicRequest(req: express.Request): boolean {
  if (req.method === "GET" && PUBLIC_BOOTSTRAP_GET_PATHS.has(req.path)) return true;
  if (req.method === "GET" && req.path === "/api/auth/session") return true;
  if (req.method === "POST" && req.path === "/api/auth/bootstrap") return true;
  return false;
}

// Auth resolution order: trusted loopback → session cookie → session bearer →
// public handshake endpoints → 401. On success `req.auth` carries the resolved
// role for downstream system-only checks. Loopback IS the agent plane: same
// uid, same machine, full power (docs/auth/trust-model.md).
app.use((req, res, next) => {
  // The content plane (CONTENT_PORT) is never system, full stop — even over
  // loopback. Device-authored surface JS runs here, so granting it system would
  // be the exact escalation this split exists to prevent. Anonymous resolves to
  // `device` so the surface runtime (state/stream/actions) still works; every
  // system-only endpoint stays 403.
  if (req.socket.localPort === CONTENT_PORT) {
    req.auth = { role: "device", via: "content-port" };
    return next();
  }

  const remote = req.socket.remoteAddress || "";
  if (TRUST_LOOPBACK && LOOPBACK_ADDRS.has(remote)) {
    req.auth = { role: "system", via: "loopback" };
    return next();
  }

  const cookieToken = readCookie(req.header("Cookie"), SESSION_COOKIE);
  if (cookieToken) {
    const session = verifySession(cookieToken);
    if (session) {
      req.auth = { role: session.role, sessionId: session.id, label: session.label, via: "cookie" };
      return next();
    }
  }

  const bearer = (req.header("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (bearer) {
    const session = verifySession(bearer);
    if (session) {
      req.auth = { role: session.role, sessionId: session.id, label: session.label, via: "bearer" };
      return next();
    }
  }

  if (isPublicRequest(req)) return next();

  res.status(401).json({ error: "Authentication required", bootstrapMethods: ["one-time-token"] });
});

// Liveness + identity for `surface service health` and the install gate.
// System plane only: the content port resolves to `device` and gets 403,
// so a TCP connect on that port is the (sufficient) content-plane probe.
const STARTED_AT = Date.now();
let versionCache: string | null = null;
function serverVersion(): string {
  if (versionCache) return versionCache;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    versionCache = String(pkg.version || "unknown");
  } catch {
    versionCache = "unknown";
  }
  return versionCache;
}
app.get("/healthz", (req, res) => {
  if (req.auth?.role !== "system") {
    sendError(res, 403, "healthz requires the system plane");
    return;
  }
  res.json({
    ok: true,
    version: serverVersion(),
    pid: process.pid,
    uptime_seconds: Math.round((Date.now() - STARTED_AT) / 1000),
    port: PORT,
    content_port: CONTENT_PORT,
  });
});

app.get("/pair", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "client", "pair.html"));
});

app.use(router);
app.use("/demos", express.static(path.join(__dirname, "..", "examples", "demos")));
app.use(express.static(path.join(__dirname, "..", "client")));
app.use(jsonErrorMiddleware);

const httpServer = app.listen(PORT, BIND, () => {
  console.log(`Surface server running on http://${BIND}:${PORT}`);
  setThumbServerPort(PORT);

  // Print a one-time pairing token when reachable beyond loopback (or when
  // explicitly requested) so a fresh browser can pair without a prior session.
  const shouldPair = !isLoopbackBind || process.env.SURFACE_PAIR_ON_START === "1";
  if (shouldPair) {
    try {
      const token = createPairingToken({ label: "startup" });
      const port = resolveListeningPort(httpServer.address(), PORT);
      const connectionString = PUBLIC_BASE_URL || resolveConnectionString(BIND, port);
      console.log("");
      console.log(formatHeadlessAccessOutput({
        connectionString,
        token: token.credential,
        pairingUrl: buildPairingUrl(connectionString, token.credential),
      }));
    } catch (err) {
      console.error("[auth] failed to mint startup pairing token:", err);
    }
  }

  if (!findChromeBin()) {
    console.warn("[thumbs] no chrome binary found; dashboards will use SVG placeholders. Set SURFACE_CHROME to override.");
    return;
  }
  try {
    const cards = listArtifactCards(getDb(), { includeHidden: true });
    let queued = 0;
    for (const card of cards) {
      if (!hasThumb(card.id)) {
        enqueueThumb(card.id);
        queued++;
      }
    }
    if (queued) console.log(`[thumbs] queued ${queued} backfill capture(s)`);
  } catch (err) {
    console.error("[thumbs] backfill scan failed:", err);
  }
});
httpServer.on("error", (err: any) => {
  console.error(`[startup] could not bind ${BIND}:${PORT} (${err?.code || err?.message}). Free the port or set PORT.`);
  process.exit(1);
});

// Content plane: same app, separate origin, never granted system (see the auth
// middleware above). Device-authored surfaces are embedded from here.
const contentServer = app.listen(CONTENT_PORT, BIND, () => {
  console.log(`Surface content origin on http://${BIND}:${CONTENT_PORT} (untrusted device plane)`);
});
contentServer.on("error", (err: any) => {
  // The content plane is the isolation boundary for device-authored surfaces.
  // If it can't bind, a still-running app would either fail to show those
  // surfaces or point them at whatever foreign service holds the port — so we
  // refuse to run degraded. Free the port or set SURFACE_CONTENT_PORT.
  console.error(
    `[content-origin] could not bind ${BIND}:${CONTENT_PORT} (${err?.code || err?.message}). ` +
    `The content plane isolates device-authored surfaces; refusing to run without it.`,
  );
  process.exit(1);
});

let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[startup] ${signal} received; shutting down`);
  closeSSEClients();
  closeCodexBridge();
  contentServer.close(() => {});
  httpServer.close(() => {
    closeDb();
    process.exit(0);
  });
  setTimeout(() => {
    try { closeDb(); } catch {}
    process.exit(1);
  }, 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
