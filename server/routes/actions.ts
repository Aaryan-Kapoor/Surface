import { Router } from "express";
import type { Request } from "express";
import { getDb } from "../db.js";
import type { Artifact } from "../artifacts.js";
import type { SurfaceAction } from "../actionsStore.js";
import {
  ackAction,
  claimActionForWaiter,
  completeClaim,
  createAction,
  getAction,
  getPendingActions,
  getUnresolvedActionCount,
} from "../actionsStore.js";
import { getArtifact } from "../artifacts.js";
import { patchState } from "../state.js";
import { broadcastGlobal, broadcastToSurface, getLiveWaiter, isWaiterEligible } from "../sse.js";
import { createBinding, deleteBinding, listBindings, projectAllowsBindings, scheduleDelivery, setBindingEnabled } from "../bindings.js";
import { deviceNameOf, requireSystem, targetOf } from "./helpers.js";

export const actionsRouter = Router();

// Optional webhook fan-out for surface actions. Set SURFACE_WEBHOOK_URL and
// SURFACE_WEBHOOK_TOKEN to wake an external agent gateway when users interact
// with surfaces. OPENCLAW_GATEWAY_URL / OPENCLAW_HOOKS_TOKEN are kept as
// legacy aliases for older configs.
const WEBHOOK_URL = process.env.SURFACE_WEBHOOK_URL || process.env.OPENCLAW_GATEWAY_URL;
const WEBHOOK_TOKEN = process.env.SURFACE_WEBHOOK_TOKEN || process.env.OPENCLAW_HOOKS_TOKEN;
const WEBHOOK_PATH = process.env.SURFACE_WEBHOOK_PATH || "/hooks/agent";

// Suppress webhook-failure notifications to at most one per minute so a broken
// webhook doesn't flood the display with toasts.
let lastWebhookNotifyAt = 0;
const WEBHOOK_NOTIFY_THROTTLE_MS = 60_000;
const ACTION_RATE_LIMIT = Math.max(1, Number(process.env.SURFACE_ACTION_RATE_LIMIT || 120));
const ACTION_RATE_WINDOW_MS = 60_000;
const actionRate = new Map<string, { count: number; windowStart: number }>();

function actionRateAllowed(req: Request): { ok: true } | { ok: false; retryAfter: number } {
  if (req.auth?.role === "system") return { ok: true };
  const key = targetOf(req);
  const now = Date.now();
  const state = actionRate.get(key) || { count: 0, windowStart: now };
  if (now - state.windowStart >= ACTION_RATE_WINDOW_MS) {
    state.windowStart = now;
    state.count = 0;
  }
  state.count++;
  actionRate.set(key, state);
  if (state.count <= ACTION_RATE_LIMIT) return { ok: true };
  return { ok: false, retryAfter: Math.max(1, Math.ceil((state.windowStart + ACTION_RATE_WINDOW_MS - now) / 1000)) };
}

function notifyWebhookFailure(reason: string) {
  const now = Date.now();
  if (now - lastWebhookNotifyAt < WEBHOOK_NOTIFY_THROTTLE_MS) return;
  lastWebhookNotifyAt = now;
  broadcastGlobal("display_notify", {
    text: `Webhook fan-out failed: ${reason}`,
    duration: 5000,
    style: "warning",
  });
}

async function fanOutWebhook(payload: {
  surface_id: string;
  surface_title: string;
  action: string;
  data: unknown;
  created_at: string;
}) {
  if (!WEBHOOK_URL || !WEBHOOK_TOKEN) return;
  try {
    const res = await fetch(`${WEBHOOK_URL}${WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WEBHOOK_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "surface_action", ...payload }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`[webhook] ${WEBHOOK_URL}${WEBHOOK_PATH} returned ${res.status}: ${body}`);
      notifyWebhookFailure(`${res.status} ${res.statusText}`);
    }
  } catch (err: any) {
    console.error(`[webhook] dispatch failed:`, err);
    notifyWebhookFailure(err?.message || "network error");
  }
}

/**
 * Record a user action and run it down the delivery ladder.
 *
 * Every route that turns a human gesture into an action goes through here — an
 * in-surface click, and a press on a notification button. A second copy of this
 * sequence is how you get an action that never fans out to a webhook, or never
 * wakes a waiter, in exactly one of the two paths.
 */
export function dispatchSurfaceAction(
  artifact: Artifact,
  action: string,
  data: unknown,
  deviceName: string | null,
): SurfaceAction {
  const act = createAction(getDb(), { surface_id: artifact.id, action, data });

  // An ask surface flips to answered server-side the moment the answer action
  // lands, so the card can never be answered twice — independent of whether a
  // waiter, binding, or nothing at all is listening (docs/templates/ask.md).
  if (artifact.template === "ask" && action === "answer") {
    const answer = {
      ...(typeof data === "object" && data !== null ? data : {}),
      answered_at: new Date().toISOString(),
      device: deviceName,
    };
    const result = patchState(getDb(), artifact.id, { status: "answered", answer });
    const event = { id: artifact.id, patch: { status: "answered", answer }, state_version: result.state_version };
    broadcastGlobal("state_patch", event);
    broadcastToSurface(artifact.id, "state_patch", event);
  }

  // A whiteboard's strokes lived only in the browser that drew them, so a
  // reload kept the agent's drawing and lost the human's — exactly backwards.
  // Persist the vectors (not the PNG, which is two orders of magnitude larger
  // and reconstructible) so the board survives being closed.
  if (artifact.template === "whiteboard" && action === "snapshot") {
    const payload = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
    if (Array.isArray(payload.strokes)) {
      const result = patchState(getDb(), artifact.id, { user_strokes: payload.strokes });
      const event = { id: artifact.id, patch: { user_strokes: payload.strokes }, state_version: result.state_version };
      broadcastGlobal("state_patch", event);
      broadcastToSurface(artifact.id, "state_patch", event);
    }
  }

  fanOutWebhook({
    surface_id: artifact.id,
    surface_title: artifact.title,
    action: act.action,
    data: data ?? {},
    created_at: act.created_at,
  });
  broadcastGlobal("surface_action", {
    id: act.id,
    surface_id: artifact.id,
    surface_title: artifact.title,
    // Project ownership rides on the event so a project-scoped waiter can filter
    // live actions the same way it filters its inbox drain.
    project_root: artifact.project_root,
    action: act.action,
    data: act.data,
    status: act.status,
    created_at: act.created_at,
  });

  // Run the ladder: an eligible live waiter gets a bounded first refusal, then
  // bindings fire, then the action simply waits in the inbox (server/bindings.ts).
  scheduleDelivery(artifact.id, act.action);
  return act;
}

// Display posts a user action (iframe postMessage → PWA → here).
actionsRouter.post("/artifacts/:id/actions", (req, res) => {
  const artifact = getArtifact(getDb(), req.params.id);
  if (!artifact) {
    res.status(404).json({ error: "Artifact not found" });
    return;
  }
  const gate = actionRateAllowed(req);
  if (!gate.ok) {
    res.setHeader("Retry-After", String(gate.retryAfter));
    res.status(429).json({ error: `action rate limit exceeded (${ACTION_RATE_LIMIT}/min)`, retry_after: gate.retryAfter });
    return;
  }
  const { action, data } = req.body;
  if (typeof action !== "string" || !action.trim()) {
    res.status(400).json({ error: "action is required" });
    return;
  }
  const act = dispatchSurfaceAction(artifact, action, data, deviceNameOf(req));
  res.status(201).json(act);
});


// ── Bindings (layer 2 registration — system plane only) ──

actionsRouter.post("/artifacts/:id/bindings", (req, res) => {
  if (!requireSystem(req, res)) return;
  const artifact = getArtifact(getDb(), req.params.id);
  if (!artifact) {
    res.status(404).json({ error: "Artifact not found" });
    return;
  }
  if (!projectAllowsBindings(artifact.project_root)) {
    res.status(403).json({
      error: "Wake bindings require recorded project consent",
      hint: "Set .surface/config.json bindings.enabled to true after asking the user.",
    });
    return;
  }
  try {
    const binding = createBinding(getDb(), {
      surface_id: req.params.id,
      action_pattern: typeof req.body?.action_pattern === "string" ? req.body.action_pattern : undefined,
      run: typeof req.body?.run === "string" ? req.body.run : undefined,
      webhook_url: typeof req.body?.webhook_url === "string" ? req.body.webhook_url : undefined,
      cwd: typeof req.body?.cwd === "string" ? req.body.cwd : undefined,
      timeout_seconds: Number.isFinite(req.body?.timeout_seconds) ? Number(req.body.timeout_seconds) : undefined,
    });
    res.status(201).json(binding);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

actionsRouter.get("/artifacts/:id/bindings", (req, res) => {
  if (!requireSystem(req, res)) return;
  res.json(listBindings(getDb(), req.params.id));
});

actionsRouter.get("/bindings", (req, res) => {
  if (!requireSystem(req, res)) return;
  res.json(listBindings(getDb()));
});

actionsRouter.delete("/bindings/:id", (req, res) => {
  if (!requireSystem(req, res)) return;
  if (!deleteBinding(getDb(), req.params.id)) {
    res.status(404).json({ error: "Binding not found" });
    return;
  }
  res.json({ deleted: true });
});

actionsRouter.patch("/bindings/:id", (req, res) => {
  if (!requireSystem(req, res)) return;
  if (typeof req.body?.enabled !== "boolean") {
    res.status(400).json({ error: "enabled (boolean) is required" });
    return;
  }
  if (!setBindingEnabled(getDb(), req.params.id, req.body.enabled)) {
    res.status(404).json({ error: "Binding not found" });
    return;
  }
  res.json({ updated: true });
});

// Agent reads pending actions — the inbox belongs to the agent plane; a device
// must never drain it.
// ?project=<root> narrows the drain to one repo, so a waiter armed in project B
// never claims project A's backlog. Actions on surfaces with no project_root are
// excluded from a project-scoped read by design (see getPendingActions).
actionsRouter.get("/actions", (req, res) => {
  if (!requireSystem(req, res)) return;
  const projectRoot = typeof req.query.project === "string" && req.query.project ? req.query.project : undefined;
  res.json(getPendingActions(getDb(), undefined, { projectRoot }));
});

actionsRouter.get("/artifacts/:id/actions", (req, res) => {
  if (!requireSystem(req, res)) return;
  res.json(getPendingActions(getDb(), req.params.id));
});

// Take or settle an action.
//
// With a `claimant`, this is a CLAIM: an atomic take of a still-pending action,
// which is how `surface wait` decides that it — and not one of the other waiters
// that received the same broadcast — owns the work. Re-claiming with the same
// claimant succeeds (`replay: true`), so a lost response can be retried without
// stranding the action: without that, the retry would read as "someone else has
// it", the true winner would stay silent, and the click would vanish.
//
// Without a `claimant`, this is the original ACK: "I handled this", which also
// settles an action parked in `claimed` by a binding.
//
// 409 (not 404) when another handler already has it — an action that exists but
// is taken is a different thing from an id that was never real, and the waiter
// has to tell them apart to know whether to stay silent.
// Phase 1 of the delivery handshake: one waiter takes exclusive permission to
// hand this action to its consumer. Every waiter on the machine received the
// same broadcast; this is where the database decides which one owns it.
//
// The claim is a short delivery lease (30s), not a work lease — it covers the
// claim response, the stdout flush, and the completing ack, nothing more. If the
// CLI wedges or its connection dies, the action returns to the queue instead of
// being silently consumed.
actionsRouter.post("/actions/:id/claim", (req, res) => {
  if (!requireSystem(req, res)) return;
  const db = getDb();
  const token = typeof req.body?.token === "string" ? req.body.token.slice(0, 200) : "";
  const clientId = typeof req.body?.client_id === "string" ? req.body.client_id.slice(0, 200) : "";
  if (!token || !clientId) {
    res.status(400).json({ error: "invalid_request", message: "token and client_id are required" });
    return;
  }

  const action = getAction(db, req.params.id);
  if (!action) {
    res.status(404).json({ error: "action_not_found" });
    return;
  }
  if (!getLiveWaiter(clientId)) {
    res.status(409).json({ error: "waiter_not_live" });
    return;
  }
  const artifact = getArtifact(db, action.surface_id);
  // Scope is enforced here, not in the CLI: a waiter must not be able to take
  // work outside the scope it registered just by asking for it by id.
  if (!isWaiterEligible(clientId, {
    surfaceId: action.surface_id,
    projectRoot: artifact?.project_root ?? null,
    action: action.action,
  })) {
    res.status(403).json({ error: "waiter_not_eligible" });
    return;
  }

  const result = claimActionForWaiter(db, { actionId: req.params.id, token, clientId });
  if (!result.ok) {
    const status = result.reason === "action_not_found" ? 404 : 409;
    res.status(status).json({
      error: result.reason,
      status: result.action?.status,
      claimed_at: result.action?.claimed_at,
      deadline_at: result.action?.claim_deadline_at,
      handled_at: result.action?.handled_at,
    });
    return;
  }

  broadcastGlobal("actions_acked", {
    surface_id: result.action.surface_id,
    pending_actions: getUnresolvedActionCount(db, result.action.surface_id),
  });
  res.json({
    claimed: true,
    replayed: result.replayed,
    claim: {
      token,
      owner_kind: "waiter",
      owner_id: clientId,
      claimed_at: result.action.claimed_at,
      deadline_at: result.action.claim_deadline_at,
    },
    action: {
      id: result.action.id,
      surface_id: result.action.surface_id,
      surface_title: artifact?.title ?? null,
      project_root: artifact?.project_root ?? null,
      action: result.action.action,
      data: result.action.data,
      status: result.action.status,
      created_at: result.action.created_at,
    },
  });
});

// Phase 2: the handoff completed. With a `token` this closes a specific delivery
// claim (idempotent for that token, so a retry after a lost response is safe).
// Without one it is the original manual `surface ack <id>` — an agent declaring a
// click done, including one a binding parked in `claimed`.
//
// 409 rather than 404 when the action exists but is no longer the caller's: an
// action that is taken is a different thing from an id that was never real, and
// the waiter must tell them apart to know whether to stay silent.
actionsRouter.post("/actions/:id/ack", (req, res) => {
  if (!requireSystem(req, res)) return;
  const db = getDb();
  const token = typeof req.body?.token === "string" && req.body.token ? req.body.token : null;

  const row = getAction(db, req.params.id);
  if (!row) {
    res.status(404).json({ error: "action_not_found" });
    return;
  }

  let replayed = false;
  if (token) {
    const result = completeClaim(db, { actionId: req.params.id, token });
    if (!result.ok) {
      res.status(409).json({
        error: "claim_lost",
        status: result.action?.status,
        handled_at: result.action?.handled_at,
      });
      return;
    }
    replayed = result.replayed;
  } else if (!ackAction(db, req.params.id)) {
    res.status(409).json({ error: "already_handled", handled_at: row.handled_at });
    return;
  }

  broadcastGlobal("actions_acked", {
    surface_id: row.surface_id,
    pending_actions: getUnresolvedActionCount(db, row.surface_id),
  });
  res.json({ acknowledged: true, replayed });
});

// Agent replies to a surface (shown as toast in the PWA)
actionsRouter.post("/artifacts/:id/reply", (req, res) => {
  if (!requireSystem(req, res)) return;
  if (!getArtifact(getDb(), req.params.id)) {
    res.status(404).json({ error: "Artifact not found" });
    return;
  }
  const { text } = req.body;
  if (!text) {
    res.status(400).json({ error: "text is required" });
    return;
  }
  broadcastToSurface(req.params.id, "agent_reply", { text });
  broadcastGlobal("agent_reply", { surface_id: req.params.id, text });
  res.json({ sent: true });
});

// Execute JS in a surface iframe — code execution, system plane only.
actionsRouter.post("/artifacts/:id/exec", (req, res) => {
  if (!requireSystem(req, res)) return;
  if (!getArtifact(getDb(), req.params.id)) {
    res.status(404).json({ error: "Artifact not found" });
    return;
  }
  const { js } = req.body;
  if (!js) {
    res.status(400).json({ error: "js is required" });
    return;
  }
  broadcastToSurface(req.params.id, "surface_exec", { js });
  broadcastGlobal("surface_exec", { surface_id: req.params.id, js });
  res.json({ executed: true, delivered: "unknown", note: "exec is delivered only to live same-origin surface iframes" });
});
