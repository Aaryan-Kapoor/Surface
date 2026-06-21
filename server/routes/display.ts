import { Router } from "express";
import { getDb, getDisplayConfig, setDisplayConfig, resetDisplayConfig } from "../db.js";
import { getArtifact, getArtifactFiles, getCurrentArtifactVersion, listArtifactCards, readArtifactFileContent } from "../artifacts.js";
import { safeJsonForScript } from "../render.js";
import type { Artifact } from "../artifacts.js";
import { listSessions } from "../auth.js";
import { addGlobalClient, broadcastGlobal, hasWaiter, LOCAL_TARGET } from "../sse.js";
import { listPresence, reportPresence } from "../presence.js";
import { deviceNameOf, requireSystem, targetOf } from "./helpers.js";

export const displayRouter = Router();

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
// ?wait_for=<surface-id|*> registers the connection as a layer-1 waiter
// (system plane only): while it lives, bindings for that surface are
// suppressed and the card shows "agent listening".
displayRouter.get("/stream", (req: any, res) => {
  const waitFor = typeof req.query.wait_for === "string" && req.query.wait_for && req.auth?.role === "system"
    ? req.query.wait_for
    : null;
  addGlobalClient(res, targetOf(req), {
    waiterFor: waitFor,
    onClose: waitFor
      ? () => broadcastGlobal("waiter_status", { surface_id: waitFor, listening: hasWaiter(waitFor) })
      : undefined,
  });
  if (waitFor) {
    broadcastGlobal("waiter_status", { surface_id: waitFor, listening: true });
  }
});

// Get display theme config
displayRouter.get("/display/config", (_req, res) => {
  // Tells the PWA which origin to embed device-authored surfaces from (the
  // untrusted content plane). Read-only, not persisted with theme. content_port
  // is the default (the PWA builds host:port); content_origin pins a full origin
  // for proxy/HTTPS deployments where the bare host:port isn't reachable.
  const cfg: Record<string, unknown> = {
    ...getDisplayConfig(),
    content_port: Number(process.env.SURFACE_CONTENT_PORT || 3100),
  };
  if (process.env.SURFACE_CONTENT_ORIGIN) {
    cfg.content_origin = process.env.SURFACE_CONTENT_ORIGIN.replace(/\/$/, "");
  }
  res.json(cfg);
});

// Update display theme config. The old raw-HTML slot keys are no longer
// config — slots are artifacts now (metadata.display_role).
displayRouter.put("/display/config", (req: any, res) => {
  if (!requireSystem(req, res)) return; // drives what every display shows
  const body = { ...req.body };
  const rejected = ["renderer", "home", "overlay"].filter((k) => k in body);
  for (const k of rejected) delete body[k];
  const config = setDisplayConfig(body);
  broadcastGlobal("display_theme", config);
  if (rejected.length) {
    res.json({ ...config, _ignored: rejected, _hint: "slots are artifacts: set metadata.display_role on an artifact (surface slot <role> <id>)" });
    return;
  }
  res.json(config);
});

// Reset display theme to default
displayRouter.post("/display/reset", (req: any, res) => {
  if (!requireSystem(req, res)) return;
  resetDisplayConfig();
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
displayRouter.post("/display/presence", (req: any, res) => {
  const { current_view, current_surface_id, viewport_width, viewport_height } = req.body;
  reportPresence(targetOf(req), deviceNameOf(req), {
    current_view,
    current_surface_id,
    viewport_width,
    viewport_height,
  });
  res.json({ ok: true });
});

// Resolve an optional `device` parameter into an SSE delivery target.
// Returns undefined when no device was named (broadcast), a target string on a
// match, or null after writing an error response.
function resolveDeviceTarget(res: any, device: unknown): string | null | undefined {
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

// Agent forces navigation — optionally on one device only.
displayRouter.post("/display/navigate", (req: any, res) => {
  if (!requireSystem(req, res)) return; // agents drive the display; devices view + click
  const { surface_id, device } = req.body;
  const target = resolveDeviceTarget(res, device);
  if (target === null) return;
  broadcastGlobal("display_navigate", { surface_id: surface_id || null }, target);
  res.json({ navigated: true, device: target ?? "all" });
});

// Agent sends notification — optionally on one device only.
displayRouter.post("/display/notify", (req: any, res) => {
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
// Raw HTML blobs in display config today; they become first-class artifacts in
// Phase 4 (docs/display/theming.md).

displayRouter.get("/display/renderer/html", (_req, res) => {
  const artifact = slotArtifact("renderer");
  const html = artifact ? slotHtml(artifact) : null;
  if (!html) { res.status(404).send(""); return; }
  const surfaces = listArtifactCards(getDb());
  // Card fields are agent/device-authored; a literal `</script>` in any of them
  // would otherwise break out of this inline script (see safeJsonForScript).
  const surfacesJson = safeJsonForScript(surfaces);
  const inject = `<script>
// ── Surface Renderer API ──
// Surfaces array: full card payloads [{id, title, metadata (JSON string), created_at, updated_at, ...}, ...]
window.__surfaces = ${surfacesJson};

// Navigation — call these to switch views
window.navigate = (id) => parent.postMessage({type:'surface_navigate',surface_id:id},'*');
window.navigateHome = () => parent.postMessage({type:'surface_navigate'},'*');

// Fetch full artifact data ({artifact, version, files, view_url})
window.getSurface = (id) => fetch('/artifacts/'+id).then(r=>r.json());

// Parse metadata helper — metadata is a JSON string with {icon, description, ...}
window.parseMeta = (s) => { try { return typeof s.metadata === 'string' ? JSON.parse(s.metadata) : (s.metadata||{}); } catch { return {}; } };

// Live preview iframe URL — use as <iframe src="/artifacts/{id}/view"></iframe>
window.previewUrl = (id) => {
  const surface = window.__surfaces.find(s => s.id === id);
  return surface && surface.preview_url ? surface.preview_url : '/artifacts/'+id+'/view';
};

// SSE live updates — call to get notified of surface changes
window.onSurfaceChange = (handlers) => {
  const sse = new EventSource('/stream');
  if (handlers.created) sse.addEventListener('surface_created', (e) => {
    const d = JSON.parse(e.data);
    window.__surfaces.unshift(d);
    handlers.created(d);
  });
  if (handlers.updated) sse.addEventListener('surface_updated', (e) => {
    const d = JSON.parse(e.data);
    const i = window.__surfaces.findIndex(s=>s.id===d.id);
    if (i!==-1) window.__surfaces[i] = {...window.__surfaces[i],...d};
    handlers.updated(d);
  });
  if (handlers.deleted) sse.addEventListener('surface_deleted', (e) => {
    const d = JSON.parse(e.data);
    window.__surfaces = window.__surfaces.filter(s=>s.id!==d.id);
    handlers.deleted(d);
  });
  return sse;
};
</script>\n`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(inject + html);
});

displayRouter.get("/display/home/html", (_req, res) => {
  const artifact = slotArtifact("home");
  const html = artifact ? slotHtml(artifact) : null;
  if (!html) { res.status(404).send(""); return; }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

displayRouter.get("/display/overlay/html", (_req, res) => {
  const artifact = slotArtifact("overlay");
  const html = artifact ? slotHtml(artifact) : null;
  if (!html) { res.status(404).send(""); return; }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});
