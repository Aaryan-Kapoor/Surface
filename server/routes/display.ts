import { Router } from "express";
import type { Request, Response } from "express";
import { getDb } from "../db.js";
import { getDisplayConfig, resetDisplayConfig, setDisplayConfig } from "../displayConfig.js";
import { getArtifact, getArtifactFiles, getCurrentArtifactVersion, listArtifactCards, readArtifactFileContent } from "../artifacts.js";
import { injectSurfaceRuntime, safeJsonForScript } from "../render.js";
import type { Artifact } from "../artifacts.js";
import type { WaiterRegistration, WaiterScope } from "../sse.js";
import { addGlobalClient, broadcastGlobal, hasWaiter, sendToClient } from "../sse.js";
import { releaseWaiterClaims } from "../bindings.js";
import { listPresence, reportPresence } from "../presence.js";
import { deviceNameOf, requireSystem, resolveDeviceTarget, targetOf } from "./helpers.js";

export const displayRouter = Router();

// Throttled so a reconnecting stale waiter cannot flood the log.
let lastLegacyWaiterWarnAt = 0;
function warnLegacyWaiter(): void {
  const now = Date.now();
  if (now - lastLegacyWaiterWarnAt < 60_000) return;
  lastLegacyWaiterWarnAt = now;
  console.warn(
    "[delivery] a `surface wait` from before single-claimant delivery connected " +
    "(legacy ?wait_for). It will consume actions without claiming them, so other " +
    "waiters may see nothing. Upgrade that CLI (npm run build / reinstall surface-display).",
  );
}

// ── Display slots (decided 2026-06: slots are artifacts) ──
// The custom renderer, home widget, and overlay are ordinary artifacts whose
// metadata carries display_role: "renderer" | "home" | "overlay" — versioned,
// linkable, rollback-able. The newest non-hidden artifact with a role wins.

export type SlotRole = "renderer" | "home" | "overlay";

export function slotArtifact(role: SlotRole): Artifact | undefined {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM artifacts
       WHERE deleted_at IS NULL AND json_extract(metadata, '$.display_role') = ?
       ORDER BY updated_at DESC`,
    )
    .all(role) as Artifact[];
  return rows.find((a) => {
    try { return JSON.parse(a.metadata)?.hidden !== true; } catch { return true; }
  });
}

function slotHtml(artifact: Artifact): string | null {
  const version = getCurrentArtifactVersion(getDb(), artifact.id);
  if (!version) return null;
  const files = getArtifactFiles(getDb(), version.id);
  const entry = files.find((f) => f.mime === "text/html" || f.path.endsWith(".html"));
  if (!entry) return null;
  try { return readArtifactFileContent(entry).toString("utf8"); } catch { return null; }
}

displayRouter.get("/display/slots", (_req, res) => {
  const out: Record<string, string | null> = {};
  for (const role of ["renderer", "home", "overlay"] as SlotRole[]) {
    out[role] = slotArtifact(role)?.id ?? null;
  }
  res.json(out);
});

// Global SSE stream — connections are tagged with their delivery target so
// directed events (--on <device>) reach only the intended screen.
//
// ?wait_for=<surface-id|project:<root>|*> registers the connection as a layer-1
// waiter (system plane only): while it lives, bindings it is eligible to claim
// are suppressed and the card shows "agent listening". ?wait_action=<pattern>
// narrows that eligibility to specific action names, so a waiter armed for one
// action does not mute a binding registered for another.
//
// Only claiming consumers pass wait_for. Observers — the PWA, `surface stream`,
// `wait --no-ack`, `wait --event <non-action>` — connect without it and are
// invisible to the ladder, because a connection that will never take the work
// must not stop something else from taking it.
displayRouter.get("/stream", (req: Request, res: Response) => {
  const q = req.query;
  const asString = (v: unknown) => (typeof v === "string" && v ? v : null);
  const forSurface = asString(q.wait_for_surface);
  const forProject = asString(q.wait_for_project);
  const forAll = q.wait_for_all === "1" || q.wait_for_all === "true";

  // A pre-claim CLI registers with the old `wait_for` param and acks on delivery
  // without a claim token, so it silently consumes actions that claim-respecting
  // waiters would have shared. The server cannot tell that ack apart from a
  // legitimate `surface ack`, so warn loudly instead: the symptom (a click that
  // reaches nobody) is otherwise impossible to attribute.
  if (typeof q.wait_for === "string" && q.wait_for) {
    warnLegacyWaiter();
  }

  const supplied = [forSurface, forProject, forAll ? "all" : null].filter(Boolean);
  if (supplied.length > 1) {
    res.status(400).json({ error: "invalid_request", message: "supply exactly one wait_for_* scope" });
    return;
  }
  if (supplied.length === 1 && req.auth?.role !== "system") {
    // A paired display may click, but it may never register as a handler —
    // taking work is an agent-plane capability (docs/auth/trust-model.md).
    res.status(403).json({ error: "waiter_registration_requires_system" });
    return;
  }

  const scope: WaiterScope | null = forSurface
    ? { kind: "surface", value: forSurface }
    : forProject
      ? { kind: "project", value: forProject }
      : forAll
        ? { kind: "all", value: null }
        : null;
  const waiter: WaiterRegistration | null = scope
    ? { scope, action: asString(q.wait_action) }
    : null;

  const clientId = addGlobalClient(res, targetOf(req), {
    waiter,
    onClose: waiter
      ? (id) => {
        // Anything this waiter claimed but never handed over goes straight back
        // on the queue, rather than waiting out its delivery deadline.
        releaseWaiterClaims(id);
        announceWaiterScope(waiter.scope);
      }
      : undefined,
  });

  if (waiter) {
    // The waiter learns its server-assigned identity here and quotes it on every
    // claim, which is how the server can verify that a claimant is a live
    // registered waiter whose scope actually covers the action.
    sendToClient(clientId, "waiter_registered", {
      client_id: clientId,
      scope: { kind: waiter.scope.kind, value: waiter.scope.value },
      action: waiter.action,
    });
    announceWaiterScope(waiter.scope);
  }
});

// One waiter can now cover many cards (project scope) or all of them ("*"), but
// the PWA's "● listening" pill is per card. Resolve the scope to the surfaces it
// actually covers and report each one's current state, so the pill is driven by
// the same predicate the ladder uses rather than by a scope string the client
// would have to interpret.
function announceWaiterScope(scope: WaiterScope): void {
  const db = getDb();
  type Row = { id: string; project_root: string | null };
  let rows: Row[];
  if (scope.kind === "project") {
    rows = db
      .prepare(`SELECT id, project_root FROM artifacts WHERE deleted_at IS NULL AND project_root = ?`)
      .all(scope.value) as Row[];
  } else if (scope.kind === "all") {
    rows = db
      .prepare(`SELECT id, project_root FROM artifacts WHERE deleted_at IS NULL`)
      .all() as Row[];
  } else {
    const row = db
      .prepare(`SELECT id, project_root FROM artifacts WHERE id = ? AND deleted_at IS NULL`)
      .get(scope.value) as Row | undefined;
    rows = row ? [row] : [{ id: scope.value, project_root: null }];
  }
  for (const row of rows) {
    broadcastGlobal("waiter_status", {
      surface_id: row.id,
      listening: hasWaiter(row.id, undefined, row.project_root),
    });
  }
}

// Get display theme config
displayRouter.get("/display/config", (_req, res) => {
  // Tells the PWA which origin to embed device-authored surfaces from (the
  // untrusted content plane). Read-only, not persisted with theme. content_port
  // is the default (the PWA builds host:port); content_origin pins a full origin
  // for proxy/HTTPS deployments where the bare host:port isn't reachable.
  const cfg: Record<string, unknown> = {
    ...getDisplayConfig(getDb()),
    content_port: Number(process.env.SURFACE_CONTENT_PORT || 3100),
  };
  if (process.env.SURFACE_CONTENT_ORIGIN) {
    cfg.content_origin = process.env.SURFACE_CONTENT_ORIGIN.replace(/\/$/, "");
  }
  res.json(cfg);
});

// Update display theme config. The old raw-HTML slot keys are no longer
// config — slots are artifacts now (metadata.display_role).
displayRouter.put("/display/config", (req: Request, res: Response) => {
  if (!requireSystem(req, res)) return; // drives what every display shows
  const body = { ...req.body };
  const rejected = ["renderer", "home", "overlay"].filter((k) => k in body);
  for (const k of rejected) delete body[k];
  const config = setDisplayConfig(getDb(), body);
  broadcastGlobal("display_theme", config);
  if (rejected.length) {
    res.json({ ...config, _ignored: rejected, _hint: "slots are artifacts: set metadata.display_role on an artifact (surface slot <role> <id>)" });
    return;
  }
  res.json(config);
});

// Reset display theme to default
displayRouter.post("/display/reset", (req: Request, res: Response) => {
  if (!requireSystem(req, res)) return;
  resetDisplayConfig(getDb());
  broadcastGlobal("display_theme", {});
  res.json({ reset: true });
});

// Per-device display status. `devices` lists every display that has reported
// presence (keyed by device session, "local" for the host browser).
displayRouter.get("/display/status", (_req, res) => {
  const devices = listPresence().map((p) => ({
    device: p.device,
    target: p.target,
    current_view: p.stale ? "unknown" : p.current_view,
    current_surface_id: p.stale ? null : p.current_surface_id,
    viewport_width: p.viewport_width,
    viewport_height: p.viewport_height,
    last_activity: p.last_activity,
    stale: p.stale,
  }));
  res.json({ devices });
});

// A display reports presence; the entry is keyed by its session target.
displayRouter.post("/display/presence", (req: Request, res: Response) => {
  const { current_view, current_surface_id, viewport_width, viewport_height } = req.body;
  reportPresence(targetOf(req), deviceNameOf(req), {
    current_view,
    current_surface_id,
    viewport_width,
    viewport_height,
  });
  res.json({ ok: true });
});

// Agent forces navigation — optionally on one device only.
displayRouter.post("/display/navigate", (req: Request, res: Response) => {
  if (!requireSystem(req, res)) return; // agents drive the display; devices view + click
  const { surface_id, device } = req.body;
  const target = resolveDeviceTarget(res, device);
  if (target === null) return;
  broadcastGlobal("display_navigate", { surface_id: surface_id || null }, target);
  res.json({ navigated: true, device: target ?? "all" });
});

// Agent sends notification — optionally on one device only.
displayRouter.post("/display/notify", (req: Request, res: Response) => {
  if (!requireSystem(req, res)) return; // agents drive the display; devices view + click
  const { text, duration, style, device } = req.body;
  if (!text) {
    res.status(400).json({ error: "text is required" });
    return;
  }
  const target = resolveDeviceTarget(res, device);
  if (target === null) return;
  broadcastGlobal("display_notify", { text, duration: duration || 5000, style: style || "info" }, target);
  res.json({ sent: true, device: target ?? "all" });
});

// ── Display renderer / home widget / overlay HTML ──
// Slots are artifacts; HTML responses get the same Surface runtime injection as
// `/artifacts/:id/view` so bindings/actions work after promotion into a slot.

displayRouter.get("/display/renderer/html", (_req, res) => {
  const artifact = slotArtifact("renderer");
  const html = artifact ? slotHtml(artifact) : null;
  if (!artifact || !html) { res.status(404).send(""); return; }
  const surfaces = listArtifactCards(getDb());
  // Card fields are agent/device-authored; a literal `</script>` in any of them
  // would otherwise break out of this inline script (see safeJsonForScript).
  const surfacesJson = safeJsonForScript(surfaces);
  const inject = `<script>window.__surfaces = ${surfacesJson};</script>\n<script src="/renderer-api.js?v=62"></script>\n`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(injectSurfaceRuntime(Buffer.from(inject + html, "utf8"), artifact.id));
});

displayRouter.get("/display/home/html", (_req, res) => {
  const artifact = slotArtifact("home");
  const html = artifact ? slotHtml(artifact) : null;
  if (!html) { res.status(404).send(""); return; }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(injectSurfaceRuntime(Buffer.from(html, "utf8"), artifact!.id));
});

displayRouter.get("/display/overlay/html", (_req, res) => {
  const artifact = slotArtifact("overlay");
  const html = artifact ? slotHtml(artifact) : null;
  if (!html) { res.status(404).send(""); return; }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(injectSurfaceRuntime(Buffer.from(html, "utf8"), artifact!.id));
});
