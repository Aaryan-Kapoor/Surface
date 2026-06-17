import { LOCAL_TARGET } from "../sse.js";

// Capability gate (docs/auth/trust-model.md): anything that touches the host
// filesystem, executes code, drains the agent inbox, or mints credentials
// requires the `system` role — as does display control (navigate/notify/theme/
// reset), which is an agent-plane push. Paired `device` sessions keep viewing,
// clicking, workspace-artifact CRUD, and presence.
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

// The trust plane this request authored from — stamped onto artifact metadata so
// the thumbnailer and slot resolution can tell agent-made content from
// device-made content. Anything that isn't the system role is a device.
export function planeOf(req: any): "system" | "device" {
  return req.auth?.role === "system" ? "system" : "device";
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
