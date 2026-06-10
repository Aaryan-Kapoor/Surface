import { LOCAL_TARGET } from "../sse.js";

// Capability gate (docs/auth/trust-model.md): anything that touches the host
// filesystem, executes code, drains the agent inbox, or mints credentials
// requires the `system` role. Paired `device` sessions keep viewing, clicking,
// workspace-artifact CRUD, presence, and display control.
export function requireSystem(req: any, res: any): boolean {
  if (req.auth && req.auth.role === "system") return true;
  res.status(403).json({ error: "System role required" });
  return false;
}

// SSE delivery target for this request: the device session id, or "local"
// for the agent plane.
export function targetOf(req: any): string {
  return req.auth?.sessionId || LOCAL_TARGET;
}

export function deviceNameOf(req: any): string {
  return req.auth?.label || LOCAL_TARGET;
}

export function isSecureRequest(req: any): boolean {
  const xfproto = (req.headers["x-forwarded-proto"] || "").toString().split(",")[0].trim().toLowerCase();
  if (xfproto) return xfproto === "https";
  return req.secure === true || req.protocol === "https";
}

export function clientIp(req: any): string {
  const xff = (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim();
  return xff || req.socket?.remoteAddress || "";
}

export function baseUrlFor(req: any, override?: unknown): string {
  if (typeof override === "string" && override) return override.replace(/\/$/, "");
  if (process.env.SURFACE_PUBLIC_URL) return process.env.SURFACE_PUBLIC_URL.replace(/\/$/, "");
  const proto = isSecureRequest(req) ? "https" : "http";
  const host = req.headers.host || `127.0.0.1:${process.env.PORT || 3000}`;
  return `${proto}://${host}`;
}
