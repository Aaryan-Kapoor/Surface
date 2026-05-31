import "dotenv/config";
import crypto from "crypto";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { initDb, getDb } from "./db.js";
import { router } from "./routes.js";
import { listArtifactCards } from "./artifacts.js";
import { createPairingToken, verifySession } from "./auth.js";
import { setThumbServerPort, enqueueThumb, hasThumb, findChromeBin } from "./thumbs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const BIND = process.env.SURFACE_BIND || "127.0.0.1";
// SURFACE_TOKEN remains valid as a static "owner" bearer credential alongside
// the pairing/session system, so existing CLI/agent configs keep working.
const STATIC_TOKEN = process.env.SURFACE_TOKEN || "";

const LOOPBACK_ADDRS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);
const isLoopbackBind = LOOPBACK_ADDRS.has(BIND);

// Loopback is trusted by default. Operators fronting Surface with a loopback
// reverse proxy (e.g. Tailscale Serve, Caddy) MUST set SURFACE_TRUST_LOOPBACK=0,
// otherwise every proxied request appears to originate from 127.0.0.1 and would
// be trusted unconditionally. See SECURITY.md.
const TRUST_LOOPBACK = !["0", "false", "no"].includes(
  (process.env.SURFACE_TRUST_LOOPBACK || "1").toLowerCase(),
);

// Public base URL used to build pairing links. Set SURFACE_PUBLIC_URL to the
// externally reachable origin (e.g. the Tailscale HTTPS hostname) so printed
// pairing URLs are clickable from another device.
const PUBLIC_BASE_URL = (process.env.SURFACE_PUBLIC_URL || `http://${BIND}:${PORT}`).replace(/\/$/, "");

initDb();

const app = express();
app.use(express.json({ limit: "10mb" }));

// Endpoints reachable without authentication. These are the minimum needed for
// an unpaired browser to load the pair page and complete the handshake.
const PUBLIC_GET_PATHS = new Set([
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
  if (req.method === "GET" && PUBLIC_GET_PATHS.has(req.path)) return true;
  if (req.method === "GET" && req.path === "/api/auth/session") return true;
  if (req.method === "POST" && req.path === "/api/auth/bootstrap") return true;
  return false;
}

function parseCookie(req: express.Request, name: string): string {
  const header = req.header("Cookie") || "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : "";
}

function constantTimeEquals(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Match the static SURFACE_TOKEN via Bearer header, ?token= query, or the
// legacy surface_token cookie. A valid query token also (re)sets the cookie so
// a browser opening `http://host:port/?token=...` once keeps working.
function staticTokenMatch(req: express.Request, res: express.Response): boolean {
  if (!STATIC_TOKEN) return false;
  const bearer = (req.header("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const query = typeof req.query.token === "string" ? req.query.token : "";
  const legacyCookie = parseCookie(req, "surface_token");
  const ok =
    constantTimeEquals(bearer, STATIC_TOKEN) ||
    constantTimeEquals(query, STATIC_TOKEN) ||
    constantTimeEquals(legacyCookie, STATIC_TOKEN);
  if (!ok) return false;
  if (constantTimeEquals(query, STATIC_TOKEN) && !constantTimeEquals(legacyCookie, STATIC_TOKEN)) {
    res.append(
      "Set-Cookie",
      `surface_token=${encodeURIComponent(STATIC_TOKEN)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`,
    );
  }
  return true;
}

// Auth resolution order: trusted loopback → session cookie → session bearer →
// static SURFACE_TOKEN → public handshake endpoints → 401. On success
// `req.auth` carries the resolved role for downstream owner-only checks.
app.use((req, res, next) => {
  const remote = req.socket.remoteAddress || "";
  if (TRUST_LOOPBACK && LOOPBACK_ADDRS.has(remote)) {
    (req as any).auth = { role: "owner", via: "loopback" };
    return next();
  }

  const cookieToken = parseCookie(req, "surface_session");
  if (cookieToken) {
    const session = verifySession(cookieToken);
    if (session) {
      (req as any).auth = { role: session.role, sessionId: session.id, via: "cookie" };
      return next();
    }
  }

  const bearer = (req.header("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (bearer) {
    const session = verifySession(bearer);
    if (session) {
      (req as any).auth = { role: session.role, sessionId: session.id, via: "bearer" };
      return next();
    }
  }

  if (staticTokenMatch(req, res)) {
    (req as any).auth = { role: "owner", via: "static-token" };
    return next();
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

app.listen(PORT, BIND, () => {
  console.log(`Surface server running on http://${BIND}:${PORT}`);
  setThumbServerPort(PORT);

  // Print a one-time pairing token when reachable beyond loopback (or when
  // explicitly requested) so a fresh browser can pair without a prior session.
  const shouldPair = !isLoopbackBind || process.env.SURFACE_PAIR_ON_START === "1";
  if (shouldPair) {
    try {
      const token = createPairingToken({ label: "startup" });
      console.log(
        [
          "",
          "Surface server is ready.",
          `Connection string: ${PUBLIC_BASE_URL}`,
          `Token: ${token.credential}`,
          `Pairing URL: ${PUBLIC_BASE_URL}/pair#token=${token.credential}`,
          "",
        ].join("\n"),
      );
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
