import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { initDb, getDb } from "./db.js";
import { router } from "./routes.js";
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
