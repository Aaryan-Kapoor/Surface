import { Router } from "express";
import type { Request } from "express";
import { getDb } from "../db.js";
import { ackAction, createAction, getAction, getPendingActions } from "../actionsStore.js";
import { getArtifact } from "../artifacts.js";
import { patchState } from "../state.js";
import { broadcastGlobal, broadcastToSurface } from "../sse.js";
import { createBinding, deleteBinding, dispatchAction, listBindings, projectAllowsBindings, setBindingEnabled } from "../bindings.js";
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
  const act = createAction(getDb(), { surface_id: req.params.id, action, data });

  // An ask surface flips to answered server-side the moment the answer action
  // lands, so the card can never be answered twice — independent of whether a
  // waiter, binding, or nothing at all is listening (docs/templates/ask.md).
  if (artifact.template === "ask" && action === "answer") {
    const answer = {
      ...(typeof data === "object" && data !== null ? data : {}),
      answered_at: new Date().toISOString(),
      device: deviceNameOf(req),
    };
    const result = patchState(getDb(), req.params.id, { status: "answered", answer });
    const event = { id: req.params.id, patch: { status: "answered", answer }, state_version: result.state_version };
    broadcastGlobal("state_patch", event);
    broadcastToSurface(req.params.id, "state_patch", event);
  }
  fanOutWebhook({
    surface_id: req.params.id,
    surface_title: artifact.title,
    action: act.action,
    data: data ?? {},
    created_at: act.created_at,
  });
  broadcastGlobal("surface_action", {
    id: act.id,
    surface_id: req.params.id,
    surface_title: artifact.title,
    action: act.action,
    data: act.data,
    created_at: act.created_at,
  });

  // Delivery ladder layer 2: when no live waiter is connected, fire the
  // surface's bindings (single-flight, coalesced; see server/bindings.ts).
  dispatchAction(req.params.id, act.action);

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
actionsRouter.get("/actions", (req, res) => {
  if (!requireSystem(req, res)) return;
  res.json(getPendingActions(getDb()));
});

actionsRouter.get("/artifacts/:id/actions", (req, res) => {
  if (!requireSystem(req, res)) return;
  res.json(getPendingActions(getDb(), req.params.id));
});

// Agent acknowledges an action
actionsRouter.post("/actions/:id/ack", (req, res) => {
  if (!requireSystem(req, res)) return;
  const row = getAction(getDb(), req.params.id);
  const acked = ackAction(getDb(), req.params.id);
  if (!acked) {
    res.status(404).json({ error: "Action not found" });
    return;
  }
  if (row) {
    broadcastGlobal("actions_acked", {
      surface_id: row.surface_id,
      pending_actions: getPendingActions(getDb(), row.surface_id).length,
    });
  }
  res.json({ acknowledged: true });
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
  res.json({ executed: true, delivered: "unknown", note: "exec is delivered only to live same-origin surface iframes" });
});
