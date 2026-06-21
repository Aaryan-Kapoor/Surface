import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { initDb, getDb, cleanupActions } from "./db.js";
import { router } from "./routes/index.js";
import { listArtifactCards } from "./artifacts.js";
import { SESSION_COOKIE, createPairingToken, readCookie, verifySession } from "./auth.js";
import {
  buildPairingUrl,
  formatHeadlessAccessOutput,
  resolveConnectionString,
  resolveListeningPort,
} from "./startupAccess.js";
import { setThumbServerPort, enqueueThumb, hasThumb, findChromeBin } from "./thumbs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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

// Inbox TTL sweep: at boot and hourly.
const sweep = () => {
  try {
    const { handled, pending } = cleanupActions();
    if (handled || pending) console.log(`[actions] TTL sweep removed ${handled} handled, ${pending} expired pending`);
  } catch (err) {
    console.error("[actions] TTL sweep failed:", err);
  }
};
sweep();
setInterval(sweep, 60 * 60 * 1000).unref();

const app = express();
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
    (req as any).auth = { role: "device", via: "content-port" };
    return next();
  }

  const remote = req.socket.remoteAddress || "";
  if (TRUST_LOOPBACK && LOOPBACK_ADDRS.has(remote)) {
    (req as any).auth = { role: "system", via: "loopback" };
    return next();
  }

  const cookieToken = readCookie(req.header("Cookie"), SESSION_COOKIE);
  if (cookieToken) {
    const session = verifySession(cookieToken);
    if (session) {
      (req as any).auth = { role: session.role, sessionId: session.id, label: session.label, via: "cookie" };
      return next();
    }
  }

  const bearer = (req.header("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (bearer) {
    const session = verifySession(bearer);
    if (session) {
      (req as any).auth = { role: session.role, sessionId: session.id, label: session.label, via: "bearer" };
      return next();
    }
  }

  if (isPublicRequest(req)) return next();

  res.status(401).json({ error: "Authentication required", bootstrapMethods: ["one-time-token"] });
});

app.get("/pair", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "client", "pair.html"));
});

app.use(router);
app.use("/demos", express.static(path.join(__dirname, "..", "examples", "demos")));
app.use(express.static(path.join(__dirname, "..", "client")));

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
