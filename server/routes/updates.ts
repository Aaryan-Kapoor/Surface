import { Router } from "express";
import type { Request, Response } from "express";
import { sendError } from "../errors.js";
import { applyBlockedReason, applyUpdate, updateStatusFor } from "../updates.js";
import { planeOf } from "./helpers.js";

export const updatesRouter = Router();

// Release awareness. Cache-only by contract: this handler never touches the
// network, so an offline host answers instantly with the last known good
// value and a page load is never held up by the npm registry.
//
// Readable from both planes — the *notification* is information a paired
// display should see (the version is already visible in the UI anyway). What
// the plane changes is `can_apply`, and how much of a failure it is told:
// updateStatusFor() keeps host-side diagnostics (which can name the configured
// npm registry) on the system plane.
updatesRouter.get("/api/update/status", (req: Request, res: Response) => {
  const role = planeOf(req);
  const blocked = applyBlockedReason(role);
  res.setHeader("Cache-Control", "no-store");
  res.json({ ...updateStatusFor(role), can_apply: blocked === null, apply_blocked_reason: blocked });
});

// Install the new release and restart the service. System plane only — this
// fetches and runs new code on the host, which docs/auth/trust-model.md
// reserves for loopback/system bearers. See applyUpdate() in server/updates.ts
// for the full reasoning.
updatesRouter.post("/api/update/apply", (req: Request, res: Response) => {
  const result = applyUpdate(planeOf(req));
  if (!result.started) {
    sendError(res, result.status, result.error || "Update refused");
    return;
  }
  res.status(202).json({ started: true, ...updateStatusFor(planeOf(req)) });
});
