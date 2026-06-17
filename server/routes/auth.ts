import { Router } from "express";
import {
  DEFAULT_SESSION_TTL_SECONDS,
  SESSION_COOKIE,
  consumePairingToken,
  createPairingToken,
  createSession,
  getSessionById,
  listPairingTokens,
  readCookie,
  listSessions,
  revokePairingToken,
  revokeSession,
  revokeSessionByToken,
} from "../auth.js";
import { getPresence } from "../presence.js";
import { connectedTargets } from "../sse.js";
import { baseUrlFor, clientIp, isSecureRequest, requireSystem } from "./helpers.js";

export const authRouter = Router();

function setSessionCookie(req: any, res: any, token: string, ttlSeconds: number) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${ttlSeconds}`,
  ];
  if (isSecureRequest(req)) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(req: any, res: any) {
  const parts = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (isSecureRequest(req)) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}

function sessionPayload(sessionId: string) {
  const s = getSessionById(sessionId);
  if (!s) return null;
  return {
    authenticated: true as const,
    role: s.role,
    sessionId: s.id,
    expiresAt: s.expires_at,
    client: { label: s.label, userAgent: s.user_agent, ip: s.client_ip },
  };
}

authRouter.get("/api/auth/session", (req: any, res) => {
  const auth = req.auth;
  if (!auth) {
    res.json({ authenticated: false, bootstrapMethods: ["one-time-token"] });
    return;
  }
  if (auth.sessionId) {
    const payload = sessionPayload(auth.sessionId);
    if (payload) {
      res.json(payload);
      return;
    }
  }
  // Loopback callers are authenticated but have no session row.
  res.json({ authenticated: true, role: auth.role, via: auth.via });
});

authRouter.post("/api/auth/bootstrap", (req: any, res) => {
  const credential = typeof req.body?.credential === "string" ? req.body.credential.trim() : "";
  const label = typeof req.body?.label === "string" ? req.body.label : null;
  if (!credential) {
    res.status(400).json({ error: "Missing credential" });
    return;
  }
  const consumed = consumePairingToken(credential);
  if (!consumed) {
    res.status(401).json({ error: "Invalid, expired, or already-used pairing token" });
    return;
  }
  const session = createSession({
    role: consumed.role,
    label: label || consumed.label,
    clientIp: clientIp(req),
    userAgent: req.headers["user-agent"] || null,
    ttlSeconds: DEFAULT_SESSION_TTL_SECONDS,
  });
  setSessionCookie(req, res, session.token, DEFAULT_SESSION_TTL_SECONDS);
  res.json(sessionPayload(session.id));
});

authRouter.post("/api/auth/pairing-token", (req: any, res) => {
  if (!requireSystem(req, res)) return;
  const label = typeof req.body?.label === "string" ? req.body.label : null;
  const ttlSeconds = Number.isFinite(req.body?.ttlSeconds) ? Number(req.body.ttlSeconds) : undefined;
  const token = createPairingToken({ label, ttlSeconds });
  res.json({
    id: token.id,
    credential: token.credential,
    role: token.role,
    pairingUrl: `${baseUrlFor(req, req.body?.baseUrl)}/pair#token=${token.credential}`,
    expiresAt: token.expiresAt,
  });
});

authRouter.get("/api/auth/pairing-tokens", (req: any, res) => {
  if (!requireSystem(req, res)) return;
  res.json(listPairingTokens());
});

authRouter.post("/api/auth/pairing-tokens/revoke", (req: any, res) => {
  if (!requireSystem(req, res)) return;
  const id = typeof req.body?.id === "string" ? req.body.id : "";
  if (!id) {
    res.status(400).json({ error: "Missing id" });
    return;
  }
  res.json({ revoked: revokePairingToken(id) });
});

authRouter.post("/api/auth/sessions", (req: any, res) => {
  if (!requireSystem(req, res)) return;
  const label = typeof req.body?.label === "string" ? req.body.label : null;
  const ttlSeconds = Number.isFinite(req.body?.ttlSeconds) ? Number(req.body.ttlSeconds) : undefined;
  // The one legitimate remote-agent path: mint a system bearer from the system
  // plane (e.g. loopback) and carry it to the SSH box / container.
  const role = req.body?.role === "system" ? "system" as const : "device" as const;
  const session = createSession({
    role,
    label,
    clientIp: clientIp(req),
    userAgent: req.headers["user-agent"] || null,
    ttlSeconds,
  });
  res.json({ id: session.id, token: session.token, role: session.role, expiresAt: session.expiresAt });
});

authRouter.get("/api/auth/clients", (req: any, res) => {
  if (!requireSystem(req, res)) return;
  res.json(listSessions());
});

authRouter.post("/api/auth/clients/revoke", (req: any, res) => {
  if (!requireSystem(req, res)) return;
  const id = typeof req.body?.id === "string" ? req.body.id : "";
  if (!id) {
    res.status(400).json({ error: "Missing id" });
    return;
  }
  res.json({ revoked: revokeSession(id) });
});

authRouter.post("/api/auth/logout", (req: any, res) => {
  const cookieToken = readCookie(req.header("Cookie"), SESSION_COOKIE);
  const bearer = (req.header("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  let revoked = false;
  if (cookieToken) revoked = revokeSessionByToken(cookieToken) || revoked;
  if (bearer) revoked = revokeSessionByToken(bearer) || revoked;
  clearSessionCookie(req, res);
  res.json({ revoked });
});

// ── Devices (paired display sessions) ──

authRouter.get("/api/auth/devices", (req: any, res) => {
  if (!requireSystem(req, res)) return;
  const live = connectedTargets();
  res.json(listSessions({ role: "device" }).map((s) => {
    const presence = getPresence(s.id);
    return {
      id: s.id,
      label: s.label,
      client_ip: s.client_ip,
      user_agent: s.user_agent,
      created_at: s.created_at,
      last_seen_at: s.last_seen_at,
      expires_at: s.expires_at,
      connected: live.has(s.id),
      viewing: presence && !presence.stale
        ? (presence.current_view === "surface" ? `surface: ${presence.current_surface_id}` : presence.current_view)
        : null,
    };
  }));
});

// Revoke by exact id, exact label, or unambiguous case-insensitive label
// prefix. Ambiguity errors out with the candidate list rather than guessing.
authRouter.post("/api/auth/devices/revoke", (req: any, res) => {
  if (!requireSystem(req, res)) return;
  const target = typeof req.body?.device === "string" ? req.body.device.trim() : "";
  if (!target) {
    res.status(400).json({ error: "Missing device (id or label)" });
    return;
  }
  const devices = listSessions({ role: "device" });
  const lower = target.toLowerCase();
  let matches = devices.filter((d) => d.id === target || (d.label || "").toLowerCase() === lower);
  if (matches.length === 0) {
    matches = devices.filter((d) => (d.label || "").toLowerCase().startsWith(lower));
  }
  if (matches.length === 0) {
    res.status(404).json({ error: `No device matches "${target}"`, devices: devices.map((d) => d.label || d.id) });
    return;
  }
  if (matches.length > 1) {
    res.status(400).json({ error: `"${target}" is ambiguous`, matches: matches.map((d) => d.label || d.id) });
    return;
  }
  res.json({ revoked: revokeSession(matches[0].id), device: matches[0].label || matches[0].id });
});
