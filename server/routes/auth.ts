import { Router } from "express";
import type { Request, Response } from "express";
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
import { baseUrlFor, clientIp, isSecureRequest, requireSystem, resolveDeviceTarget } from "./helpers.js";

export const authRouter = Router();

function cleanLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = value.trim();
  if (!label) return null;
  if (label.length > 80) throw new Error("label must be 80 characters or fewer");
  if (/[\u0000-\u001f\u007f]/.test(label)) throw new Error("label contains control characters");
  return label;
}

function setSessionCookie(req: Request, res: Response, token: string, ttlSeconds: number) {
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

function clearSessionCookie(req: Request, res: Response) {
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

authRouter.get("/api/auth/session", (req, res) => {
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

authRouter.post("/api/auth/bootstrap", (req, res) => {
  const credential = typeof req.body?.credential === "string" ? req.body.credential.trim() : "";
  let label: string | null;
  try { label = cleanLabel(req.body?.label); }
  catch (err: any) { res.status(400).json({ error: err.message }); return; }
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

authRouter.post("/api/auth/pairing-token", (req, res) => {
  if (!requireSystem(req, res)) return;
  let label: string | null;
  try { label = cleanLabel(req.body?.label); }
  catch (err: any) { res.status(400).json({ error: err.message }); return; }
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

authRouter.get("/api/auth/pairing-tokens", (req, res) => {
  if (!requireSystem(req, res)) return;
  res.json(listPairingTokens());
});

authRouter.post("/api/auth/pairing-tokens/revoke", (req, res) => {
  if (!requireSystem(req, res)) return;
  const id = typeof req.body?.id === "string" ? req.body.id : "";
  if (!id) {
    res.status(400).json({ error: "Missing id" });
    return;
  }
  res.json({ revoked: revokePairingToken(id) });
});

authRouter.post("/api/auth/sessions", (req, res) => {
  if (!requireSystem(req, res)) return;
  let label: string | null;
  try { label = cleanLabel(req.body?.label); }
  catch (err: any) { res.status(400).json({ error: err.message }); return; }
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

authRouter.get("/api/auth/clients", (req, res) => {
  if (!requireSystem(req, res)) return;
  res.json(listSessions());
});

authRouter.post("/api/auth/clients/revoke", (req, res) => {
  if (!requireSystem(req, res)) return;
  const id = typeof req.body?.id === "string" ? req.body.id : "";
  if (!id) {
    res.status(400).json({ error: "Missing id" });
    return;
  }
  res.json({ revoked: revokeSession(id) });
});

authRouter.post("/api/auth/logout", (req, res) => {
  const cookieToken = readCookie(req.header("Cookie"), SESSION_COOKIE);
  const bearer = (req.header("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  let revoked = false;
  if (cookieToken) revoked = revokeSessionByToken(cookieToken) || revoked;
  if (bearer) revoked = revokeSessionByToken(bearer) || revoked;
  clearSessionCookie(req, res);
  res.json({ revoked });
});

// ── Devices (paired display sessions) ──

authRouter.get("/api/auth/devices", (req, res) => {
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
authRouter.post("/api/auth/devices/revoke", (req, res) => {
  if (!requireSystem(req, res)) return;
  const target = typeof req.body?.device === "string" ? req.body.device.trim() : "";
  if (!target) {
    res.status(400).json({ error: "Missing device (id or label)" });
    return;
  }
  const resolved = resolveDeviceTarget(res, target);
  if (!resolved) return;
  res.json({ revoked: revokeSession(resolved), device: target });
});
