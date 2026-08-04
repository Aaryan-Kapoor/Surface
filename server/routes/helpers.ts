import type { Request, Response } from "express";
import { LOCAL_TARGET } from "../sse.js";
import { SESSION_COOKIE, listSessions } from "../auth.js";

// Capability gate (docs/auth/trust-model.md): anything that touches the host
// filesystem, executes code, drains the agent inbox, or mints credentials
// requires the `system` role — as does display control (navigate/notify/theme/
// reset), which is an agent-plane push. Paired `device` sessions keep viewing,
// clicking, workspace-artifact CRUD, and presence.
export function requireSystem(req: Request, res: Response): boolean {
  if (req.auth && req.auth.role === "system") return true;
  res.status(403).json({ error: "System role required" });
  return false;
}

// SSE delivery target for this request: the device session id, or "local"
// for the agent plane.
export function targetOf(req: Request): string {
  return req.auth?.sessionId || LOCAL_TARGET;
}

// The trust plane this request authored from — stamped onto artifact metadata so
// the thumbnailer and slot resolution can tell agent-made content from
// device-made content. Anything that isn't the system role is a device.
export function planeOf(req: Request): "system" | "device" {
  return req.auth?.role === "system" ? "system" : "device";
}

export function deviceNameOf(req: Request): string {
  return req.auth?.label || LOCAL_TARGET;
}

function trustProxyHeaders(): boolean {
  return ["1", "true", "yes"].includes((process.env.SURFACE_TRUST_PROXY || "").toLowerCase());
}

export function isSecureRequest(req: Request): boolean {
  if (!trustProxyHeaders()) return req.secure === true || req.protocol === "https";
  const xfproto = (req.headers["x-forwarded-proto"] || "").toString().split(",")[0].trim().toLowerCase();
  if (xfproto) return xfproto === "https";
  return req.secure === true || req.protocol === "https";
}

// Cookie emission lives here rather than in routes/auth.ts because the auth
// middleware (server/index.ts) also has to write it: rolling the session row's
// expiry without re-issuing the cookie leaves the browser expiring on the
// original deadline.
export function setSessionCookie(req: Request, res: Response, token: string, ttlSeconds: number): void {
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

export function clearSessionCookie(req: Request, res: Response): void {
  const parts = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (isSecureRequest(req)) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}

export function clientIp(req: Request): string {
  if (!trustProxyHeaders()) return req.socket?.remoteAddress || "";
  const xff = (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim();
  return xff || req.socket?.remoteAddress || "";
}

export function baseUrlFor(req: Request, override?: unknown): string {
  if (typeof override === "string" && override) return override.replace(/\/$/, "");
  if (process.env.SURFACE_PUBLIC_URL) return process.env.SURFACE_PUBLIC_URL.replace(/\/$/, "");
  const proto = isSecureRequest(req) ? "https" : "http";
  const host = req.headers.host || `127.0.0.1:${process.env.PORT || 3000}`;
  return `${proto}://${host}`;
}

export function resolveDeviceTarget(res: Response, device: unknown): string | null | undefined {
  if (typeof device !== "string" || !device.trim()) return undefined;
  const query = device.trim().toLowerCase();
  const candidates: Array<{ key: string; label: string }> = [
    { key: LOCAL_TARGET, label: LOCAL_TARGET },
    ...listSessions({ role: "device" }).map((s) => ({ key: s.id, label: (s.label || s.id) })),
  ];
  let matches = candidates.filter((c) => c.label.toLowerCase() === query || c.key === device.trim());
  if (matches.length === 0) {
    matches = candidates.filter((c) => c.label.toLowerCase().startsWith(query));
  }
  if (matches.length === 0) {
    res.status(404).json({ error: `No device matches "${device}"`, devices: candidates.map((c) => c.label) });
    return null;
  }
  if (matches.length > 1) {
    res.status(400).json({ error: `"${device}" is ambiguous`, matches: matches.map((c) => c.label) });
    return null;
  }
  return matches[0].key;
}
