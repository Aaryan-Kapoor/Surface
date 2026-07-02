import type { ErrorRequestHandler, Response } from "express";

export function sendError(
  res: Response,
  status: number,
  message: string,
  extra?: Record<string, unknown>,
): void {
  res.status(status).json({ error: message, ...(extra || {}) });
}

export const jsonErrorMiddleware: ErrorRequestHandler = (err, _req, res, _next) => {
  const status = typeof err?.status === "number" && err.status >= 400 && err.status < 600
    ? err.status
    : 500;
  const message = status === 400 && err?.type === "entity.parse.failed"
    ? "Invalid JSON body"
    : status >= 500
      ? "Internal server error"
      : err?.message || "Request failed";
  sendError(res, status, message);
};
