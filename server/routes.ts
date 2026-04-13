import { Router } from "express";

// OpenClaw fan-out (optional — set OPENCLAW_GATEWAY_URL and OPENCLAW_HOOKS_TOKEN in .env)
const OPENCLAW_GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL;
const OPENCLAW_HOOKS_TOKEN = process.env.OPENCLAW_HOOKS_TOKEN;

async function fanOutToOpenClaw(surfaceId: string, surfaceTitle: string, actionName: string, data: string) {
  if (!OPENCLAW_GATEWAY_URL || !OPENCLAW_HOOKS_TOKEN) return;
  try {
    const res = await fetch(`${OPENCLAW_GATEWAY_URL}/hooks/agent`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENCLAW_HOOKS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: `[Surface Action] User triggered "${actionName}" on surface "${surfaceTitle}" (id: ${surfaceId}). Data: ${data}. Use the surface MCP tools (surface_read, surface_update, reply) to respond.`,
        name: "SurfaceAction",
      }),
    });
    if (!res.ok) {
      console.error(`[OpenClaw] hook returned ${res.status}: ${await res.text()}`);
    } else {
      console.log(`[OpenClaw] hook dispatched: ${actionName} on ${surfaceTitle}`);
    }
  } catch (err) {
    console.error(`[OpenClaw] hook failed:`, err);
  }
}
import {
  createSurface,
  getSurface,
  listSurfaces,
  updateSurface,
  deleteSurface,
  createAction,
  getPendingActions,
  ackAction,
  getDisplayConfig,
  setDisplayConfig,
  resetDisplayConfig,
} from "./db.js";
import {
  addGlobalClient,
  addSurfaceClient,
  broadcastGlobal,
  broadcastToSurface,
} from "./sse.js";

export const router = Router();

// ── Display presence (in-memory) ──
let displayPresence: Record<string, any> = {
  current_view: "grid",
  current_surface_id: null,
  viewport_width: 0,
  viewport_height: 0,
  last_activity: new Date().toISOString(),
};

// Global SSE stream
router.get("/stream", (req, res) => {
  addGlobalClient(res);
});

// Per-surface SSE stream
router.get("/surfaces/:id/stream", (req, res) => {
  const surface = getSurface(req.params.id);
  if (!surface) {
    res.status(404).json({ error: "Surface not found" });
    return;
  }
  addSurfaceClient(req.params.id, res);
});

// List surfaces
router.get("/surfaces", (_req, res) => {
  const surfaces = listSurfaces();
  res.json(surfaces);
});

// Serve surface HTML as a standalone page (used by iframe src= instead of srcdoc)
router.get("/surfaces/:id/html", (req, res) => {
  const surface = getSurface(req.params.id);
  if (!surface) {
    res.status(404).send("Surface not found");
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(surface.html);
});

// Get surface
router.get("/surfaces/:id", (req, res) => {
  const surface = getSurface(req.params.id);
  if (!surface) {
    res.status(404).json({ error: "Surface not found" });
    return;
  }
  res.json(surface);
});

// Create surface
router.post("/surfaces", (req, res) => {
  const { id, title, html, metadata, kind, spec } = req.body;
  if (!title) {
    res.status(400).json({ error: "title is required" });
    return;
  }
  if (kind === "widgets") {
    if (!spec || typeof spec !== "object") {
      res.status(400).json({ error: "spec is required for kind=widgets" });
      return;
    }
  } else {
    if (!html) {
      res.status(400).json({ error: "html is required" });
      return;
    }
  }
  const surface = createSurface({
    id,
    title,
    html: html || "",
    metadata,
    kind: kind === "widgets" ? "widgets" : "html",
    spec: kind === "widgets" ? spec : null,
  });
  broadcastGlobal("surface_created", {
    id: surface.id,
    title: surface.title,
    metadata: surface.metadata,
    kind: surface.kind,
    revision: surface.revision,
    created_at: surface.created_at,
    updated_at: surface.updated_at,
  });
  res.status(201).json(surface);
});

// Update surface
router.put("/surfaces/:id", (req, res) => {
  const { title, html, metadata, kind, spec } = req.body;
  const surface = updateSurface(
    req.params.id,
    { title, html, metadata, kind, spec },
    { edit_kind: "update" }
  );
  if (!surface) {
    res.status(404).json({ error: "Surface not found" });
    return;
  }
  broadcastGlobal("surface_updated", {
    id: surface.id,
    title: surface.title,
    metadata: surface.metadata,
    kind: surface.kind,
    revision: surface.revision,
    updated_at: surface.updated_at,
  });
  broadcastToSurface(req.params.id, "surface_updated", {
    id: surface.id,
    title: surface.title,
    html: surface.html,
    metadata: surface.metadata,
    kind: surface.kind,
    spec: surface.spec,
    revision: surface.revision,
    updated_at: surface.updated_at,
  });
  res.json(surface);
});

// Delete surface
router.delete("/surfaces/:id", (req, res) => {
  const deleted = deleteSurface(req.params.id);
  if (!deleted) {
    res.status(404).json({ error: "Surface not found" });
    return;
  }
  broadcastGlobal("surface_deleted", { id: req.params.id });
  res.json({ deleted: true });
});

// ── Actions (surface → agent) ──

// Surface posts an action (called by iframe via parent postMessage → PWA → here)
router.post("/surfaces/:id/actions", (req, res) => {
  const surface = getSurface(req.params.id);
  if (!surface) {
    res.status(404).json({ error: "Surface not found" });
    return;
  }
  const { action, data } = req.body;
  if (!action) {
    res.status(400).json({ error: "action is required" });
    return;
  }
  const act = createAction({ surface_id: req.params.id, action, data });
  fanOutToOpenClaw(req.params.id, surface.title, action, JSON.stringify(data || {}));
  broadcastGlobal("surface_action", {
    id: act.id,
    surface_id: req.params.id,
    surface_title: surface.title,
    action: act.action,
    data: act.data,
    created_at: act.created_at,
  });
  res.status(201).json(act);
});

// Agent reads pending actions
router.get("/actions", (_req, res) => {
  const actions = getPendingActions();
  res.json(actions);
});

router.get("/surfaces/:id/actions", (req, res) => {
  const actions = getPendingActions(req.params.id);
  res.json(actions);
});

// Agent acknowledges an action
router.post("/actions/:id/ack", (req, res) => {
  const acked = ackAction(req.params.id);
  if (!acked) {
    res.status(404).json({ error: "Action not found" });
    return;
  }
  res.json({ acknowledged: true });
});

// Agent replies to a surface (shown as toast in the PWA)
router.post("/surfaces/:id/reply", (req, res) => {
  const surface = getSurface(req.params.id);
  if (!surface) {
    res.status(404).json({ error: "Surface not found" });
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

// ── Display Control ──

// Get display theme config
router.get("/display/config", (_req, res) => {
  res.json(getDisplayConfig());
});

// Update display theme config
router.put("/display/config", (req, res) => {
  const config = setDisplayConfig(req.body);
  broadcastGlobal("display_theme", config);
  res.json(config);
});

// Reset display theme to default
router.post("/display/reset", (_req, res) => {
  resetDisplayConfig();
  broadcastGlobal("display_theme", {});
  res.json({ reset: true });
});

// Get display status (presence + connection info)
router.get("/display/status", (_req, res) => {
  res.json(displayPresence);
});

// PWA reports presence
router.post("/display/presence", (req, res) => {
  const { current_view, current_surface_id, viewport_width, viewport_height } = req.body;
  if (current_view) displayPresence.current_view = current_view;
  if (current_surface_id !== undefined) displayPresence.current_surface_id = current_surface_id;
  if (viewport_width) displayPresence.viewport_width = viewport_width;
  if (viewport_height) displayPresence.viewport_height = viewport_height;
  displayPresence.last_activity = new Date().toISOString();
  res.json({ ok: true });
});

// Agent forces navigation
router.post("/display/navigate", (req, res) => {
  const { surface_id } = req.body;
  broadcastGlobal("display_navigate", { surface_id: surface_id || null });
  res.json({ navigated: true });
});

// Agent sends notification
router.post("/display/notify", (req, res) => {
  const { text, duration, style } = req.body;
  if (!text) {
    res.status(400).json({ error: "text is required" });
    return;
  }
  broadcastGlobal("display_notify", { text, duration: duration || 5000, style: style || "info" });
  res.json({ sent: true });
});

// Execute JS in a surface iframe
router.post("/surfaces/:id/exec", (req, res) => {
  const surface = getSurface(req.params.id);
  if (!surface) {
    res.status(404).json({ error: "Surface not found" });
    return;
  }
  const { js } = req.body;
  if (!js) {
    res.status(400).json({ error: "js is required" });
    return;
  }
  broadcastToSurface(req.params.id, "surface_exec", { js });
  res.json({ executed: true });
});

// ── Display home widget / overlay HTML ──

router.get("/display/renderer/html", (_req, res) => {
  const config = getDisplayConfig();
  if (!config.renderer) { res.status(404).send(""); return; }
  const surfaces = listSurfaces();
  const inject = `<script>
// ── Surface Renderer API ──
// Surfaces array: [{id, title, metadata (JSON string), created_at, updated_at}, ...]
window.__surfaces = ${JSON.stringify(surfaces)};

// Navigation — call these to switch views
window.navigate = (id) => parent.postMessage({type:'surface_navigate',surface_id:id},'*');
window.navigateHome = () => parent.postMessage({type:'surface_navigate'},'*');

// Fetch full surface data (includes html field)
window.getSurface = (id) => fetch('/surfaces/'+id).then(r=>r.json());

// Parse metadata helper — metadata is a JSON string with {icon, description, ...}
window.parseMeta = (s) => { try { return typeof s.metadata === 'string' ? JSON.parse(s.metadata) : (s.metadata||{}); } catch { return {}; } };

// Live preview iframe URL — use as <iframe src="/surfaces/{id}/html"></iframe>
window.previewUrl = (id) => '/surfaces/'+id+'/html';

// SSE live updates — call to get notified of surface changes
window.onSurfaceChange = (handlers) => {
  const sse = new EventSource('/stream');
  if (handlers.created) sse.addEventListener('surface_created', (e) => {
    const d = JSON.parse(e.data);
    fetch('/surfaces/'+d.id).then(r=>r.json()).then(s => { window.__surfaces.unshift(s); handlers.created(s); });
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
  res.send(inject + config.renderer);
});

router.get("/display/home/html", (_req, res) => {
  const config = getDisplayConfig();
  if (!config.home) { res.status(404).send(""); return; }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(config.home);
});

router.get("/display/overlay/html", (_req, res) => {
  const config = getDisplayConfig();
  if (!config.overlay) { res.status(404).send(""); return; }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(config.overlay);
});

// ── Marketplace (The Grid) ──

import { catalog } from "../registry/catalog.js";

// List marketplace items (optional category filter)
router.get("/marketplace", (req, res) => {
  const category = req.query.category as string | undefined;
  const type = req.query.type as string | undefined;
  const q = (req.query.q as string || "").toLowerCase();
  let items = catalog.map(({ html, renderer, overlay, theme, ...rest }) => rest);
  if (category) items = items.filter(i => i.category === category);
  if (type) items = items.filter(i => i.type === type);
  if (q) items = items.filter(i => i.title.toLowerCase().includes(q) || i.description.toLowerCase().includes(q) || i.tags.some(t => t.includes(q)));
  res.json(items);
});

// Get single marketplace item (full, with html/theme/etc)
router.get("/marketplace/:id", (req, res) => {
  const item = catalog.find(i => i.id === req.params.id);
  if (!item) { res.status(404).json({ error: "Not found" }); return; }
  res.json(item);
});

// Preview a marketplace surface HTML
router.get("/marketplace/:id/preview", (req, res) => {
  const item = catalog.find(i => i.id === req.params.id);
  if (!item) { res.status(404).send("Not found"); return; }
  const html = item.html || item.renderer || item.overlay || "";
  if (!html) { res.status(404).send("No preview"); return; }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

// Install a marketplace item
router.post("/marketplace/:id/install", (req, res) => {
  const item = catalog.find(i => i.id === req.params.id);
  if (!item) { res.status(404).json({ error: "Not found" }); return; }

  if (item.type === "surface") {
    // Check if already installed
    const existing = getSurface(item.id);
    if (existing) {
      res.json({ action: "exists", id: existing.id });
      return;
    }
    const surface = createSurface({
      id: item.id,
      title: item.title,
      html: item.html!,
      metadata: { icon: item.icon, description: item.description },
    });
    broadcastGlobal("surface_created", {
      id: surface.id, title: surface.title,
      metadata: surface.metadata,
      created_at: surface.created_at, updated_at: surface.updated_at,
    });
    res.status(201).json({ action: "installed", id: surface.id, type: "surface" });
  } else if (item.type === "theme") {
    const config = setDisplayConfig(item.theme!);
    broadcastGlobal("display_theme", config);
    res.json({ action: "applied", type: "theme" });
  } else if (item.type === "renderer") {
    const config = setDisplayConfig({ renderer: item.renderer });
    broadcastGlobal("display_theme", config);
    res.json({ action: "applied", type: "renderer" });
  } else if (item.type === "overlay") {
    const config = setDisplayConfig({ overlay: item.overlay });
    broadcastGlobal("display_theme", config);
    res.json({ action: "applied", type: "overlay" });
  } else {
    res.status(400).json({ error: "Unknown type" });
  }
});

// ── Nexlayer proxy ──

const NEXLAYER_API = "https://app.nexlayer.io";

router.post("/api/nexlayer/deploy", async (req, res) => {
  try {
    const yaml = req.body.yaml;
    if (!yaml) { res.status(400).json({ error: "yaml is required" }); return; }
    const url = req.body.sessionToken
      ? `${NEXLAYER_API}/startUserDeployment?sessionToken=${req.body.sessionToken}`
      : `${NEXLAYER_API}/startUserDeployment`;
    const upstream = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/x-yaml" },
      body: yaml,
    });
    const data = await upstream.text();
    res.status(upstream.status).setHeader("Content-Type", "application/json").send(data);
  } catch (err: any) {
    res.status(502).json({ error: err.message });
  }
});

router.post("/api/nexlayer/extend", async (req, res) => {
  try {
    const { applicationName, sessionToken } = req.body;
    const upstream = await fetch(`${NEXLAYER_API}/extendDeployment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ applicationName, sessionToken }),
    });
    const data = await upstream.text();
    res.status(upstream.status).send(data);
  } catch (err: any) {
    res.status(502).json({ error: err.message });
  }
});

router.get("/api/nexlayer/status", async (req, res) => {
  try {
    const token = req.query.sessionToken as string;
    if (!token) { res.status(400).json({ error: "sessionToken required" }); return; }
    const upstream = await fetch(`${NEXLAYER_API}/getReservations?sessionToken=${token}`);
    const data = await upstream.text();
    res.status(upstream.status).setHeader("Content-Type", "application/json").send(data);
  } catch (err: any) {
    res.status(502).json({ error: err.message });
  }
});

// ── LLM completions proxy (OpenRouter) ──

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4";

router.post("/api/chat", async (req, res) => {
  if (!OPENROUTER_API_KEY) {
    res.status(500).json({ error: "OPENROUTER_API_KEY not configured" });
    return;
  }
  const { messages, model, stream } = req.body;
  if (!messages) {
    res.status(400).json({ error: "messages is required" });
    return;
  }
  try {
    const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model || OPENROUTER_MODEL,
        messages,
        stream: stream || false,
      }),
    });
    if (!upstream.ok) {
      const err = await upstream.text();
      res.status(upstream.status).json({ error: err });
      return;
    }
    if (stream && upstream.body) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      const reader = upstream.body.getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { res.end(); return; }
          res.write(Buffer.from(value));
        }
      };
      pump().catch(() => res.end());
    } else {
      const data = await upstream.json();
      res.json(data);
    }
  } catch (err: any) {
    res.status(502).json({ error: err.message });
  }
});

// PDF proxy — bypasses X-Frame-Options so surfaces can embed PDFs
router.get("/proxy/pdf", async (req, res) => {
  const url = req.query.url as string;
  if (!url || !/^https?:\/\//.test(url)) {
    res.status(400).json({ error: "url query param required" });
    return;
  }
  try {
    const upstream = await fetch(url, {
      headers: { "User-Agent": "Surface/1.0" },
    });
    if (!upstream.ok) {
      res.status(upstream.status).send(`Upstream ${upstream.status}`);
      return;
    }
    const ct = upstream.headers.get("content-type") || "application/pdf";
    res.setHeader("Content-Type", ct);
    res.setHeader("Cache-Control", "public, max-age=3600");
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.send(buf);
  } catch (err: any) {
    res.status(502).json({ error: err.message });
  }
});
