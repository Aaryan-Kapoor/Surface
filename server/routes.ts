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
        message: `[Surface Action] User triggered "${actionName}" on surface "${surfaceTitle}" (id: ${surfaceId}). Data: ${data}. Use the Surface MCP tools (artifact_read, artifact_update, surface_exec, reply) to respond.`,
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
  getDb,
  getSurface,
  deleteSurface,
  createAction,
  getPendingActions,
  ackAction,
  getDisplayConfig,
  setDisplayConfig,
  resetDisplayConfig,
} from "./db.js";
import {
  createArtifact,
  deleteArtifact,
  getArtifact,
  getArtifactFile,
  getArtifactFiles,
  getCurrentArtifactVersion,
  inferMime,
  listArtifactCards,
  listArtifacts,
  listArtifactVersions,
  presentFile,
  readArtifact,
  readArtifactFileContent,
  setCurrentArtifactVersion,
  updateArtifact,
} from "./artifacts.js";
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
  const artifact = getArtifact(getDb(), req.params.id);
  const surface = artifact ? undefined : getSurface(req.params.id);
  if (!artifact && !surface) {
    res.status(404).json({ error: "Surface not found" });
    return;
  }
  addSurfaceClient(req.params.id, res);
});

// List surfaces
router.get("/surfaces", (_req, res) => {
  res.json(listArtifactCards(getDb()));
});

// Serve surface HTML as a standalone page (used by iframe src= instead of srcdoc)
router.get("/surfaces/:id/html", (req, res) => {
  const artifact = getArtifact(getDb(), req.params.id);
  const version = artifact ? getCurrentArtifactVersion(getDb(), artifact.id) : undefined;
  const files = version ? getArtifactFiles(getDb(), version.id) : [];
  const htmlFile = files.find((file) => file.mime === "text/html" || file.path.endsWith(".html"));
  if (artifact && htmlFile) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(readArtifactFileContent(htmlFile));
    return;
  }

  const surface = getSurface(req.params.id);
  if (surface) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(surface.html);
    return;
  }

  res.status(404).send("Surface not found");
});

// Get surface
router.get("/surfaces/:id", (req, res) => {
  const artifactInfo = readArtifact(getDb(), req.params.id);
  if (artifactInfo) {
    res.json(surfaceResponseFromArtifact(artifactInfo));
    return;
  }

  const surface = getSurface(req.params.id);
  if (!surface) {
    res.status(404).json({ error: "Surface not found" });
    return;
  }
  res.json({
    ...surface,
    preview_url: `/surfaces/${surface.id}/html`,
    view_url: `/surfaces/${surface.id}/html`,
  });
});

// Create a displayable HTML artifact through the legacy surface route.
router.post("/surfaces", (req, res) => {
  const { id, title, html, metadata } = req.body;
  if (!title || !html) {
    res.status(400).json({ error: "title and html are required" });
    return;
  }
  try {
    const result = createArtifact(getDb(), {
      id,
      title,
      kind: "html",
      mime: "text/html",
      source_type: "generated",
      metadata,
      files: [{ path: "index.html", content: html, mime: "text/html" }],
      reason: "surface_create_compat",
    });
    broadcastGlobal("surface_created", cardPayload(result.artifact.id));
    res.status(201).json(surfaceResponseFromArtifact(result));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Update the artifact behind a surface. Legacy surface rows are only read as a migration fallback.
router.put("/surfaces/:id", (req, res) => {
  const { title, html, metadata } = req.body;
  const existingArtifact = readArtifact(getDb(), req.params.id);
  const legacySurface = existingArtifact ? undefined : getSurface(req.params.id);
  if (!existingArtifact && !legacySurface) {
    res.status(404).json({ error: "Surface not found" });
    return;
  }
  try {
    const result = existingArtifact
      ? updateArtifact(getDb(), req.params.id, {
          title,
          kind: html !== undefined ? "html" : undefined,
          mime: html !== undefined ? "text/html" : undefined,
          source_type: html !== undefined ? "generated" : undefined,
          metadata,
          files: html !== undefined ? [{ path: "index.html", content: html, mime: "text/html" }] : undefined,
          reason: "surface_update_compat",
        })
      : createArtifact(getDb(), {
          id: req.params.id,
          title: title ?? legacySurface!.title,
          kind: "html",
          mime: "text/html",
          source_type: "generated",
          metadata: metadata ?? parseMetadataObject(legacySurface!.metadata),
          files: [{ path: "index.html", content: html ?? legacySurface!.html, mime: "text/html" }],
          reason: "surface_update_compat",
        });
    if (!result) {
      res.status(404).json({ error: "Surface not found" });
      return;
    }
    broadcastGlobal("surface_updated", cardPayload(result.artifact.id));
    broadcastToSurface(req.params.id, "surface_updated", {
      id: result.artifact.id,
      title: result.artifact.title,
      metadata: result.artifact.metadata,
      updated_at: result.artifact.updated_at,
      version_id: result.version?.id,
      reload: true,
    });
    res.json(surfaceResponseFromArtifact(result));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Delete surface
router.delete("/surfaces/:id", (req, res) => {
  const artifactDeleted = deleteArtifact(getDb(), req.params.id);
  const legacyDeleted = artifactDeleted ? false : deleteSurface(req.params.id);
  if (!artifactDeleted && !legacyDeleted) {
    res.status(404).json({ error: "Surface not found" });
    return;
  }
  broadcastGlobal("surface_deleted", { id: req.params.id });
  res.json({ deleted: true });
});

// ─── Artifacts ───

router.get("/artifacts", (_req, res) => {
  res.json(listArtifacts(getDb()));
});

router.post("/artifacts/present-file", (req, res) => {
  const { path: filePath, title, metadata, copy, open } = req.body;
  if (!filePath) {
    res.status(400).json({ error: "path is required" });
    return;
  }
  try {
    const result = presentFile(getDb(), { filePath, title, metadata, copy, open });
    broadcastGlobal("surface_created", cardPayload(result.artifact.id));
    if (open !== false) broadcastGlobal("display_navigate", { surface_id: result.artifact.id });
    res.status(201).json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/artifacts", (req, res) => {
  const { id, title, kind, mime, renderer, source_type, metadata, files, content, path: filePath } = req.body;
  if (!title) {
    res.status(400).json({ error: "title is required" });
    return;
  }
  const inputFiles = Array.isArray(files)
    ? files
    : content !== undefined
      ? [{ path: filePath || defaultPathForMime(mime), content, mime }]
      : [];
  try {
    const result = createArtifact(getDb(), {
      id,
      title,
      kind,
      mime,
      renderer,
      source_type,
      metadata,
      files: inputFiles,
      reason: "artifact_create",
    });
    broadcastGlobal("surface_created", cardPayload(result.artifact.id));
    res.status(201).json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/artifacts/:id", (req, res) => {
  const result = readArtifact(getDb(), req.params.id);
  if (!result) {
    res.status(404).json({ error: "Artifact not found" });
    return;
  }
  res.json(result);
});

router.get("/artifacts/:id/versions", (req, res) => {
  if (!getArtifact(getDb(), req.params.id)) {
    res.status(404).json({ error: "Artifact not found" });
    return;
  }
  res.json(listArtifactVersions(getDb(), req.params.id));
});

router.post("/artifacts/:id/rollback", (req, res) => {
  const { version } = req.body;
  if (version === undefined) {
    res.status(400).json({ error: "version is required" });
    return;
  }
  const result = setCurrentArtifactVersion(getDb(), req.params.id, version);
  if (!result) {
    res.status(404).json({ error: "Artifact version not found" });
    return;
  }
  broadcastGlobal("surface_updated", cardPayload(result.artifact.id));
  broadcastToSurface(result.artifact.id, "surface_updated", {
    id: result.artifact.id,
    title: result.artifact.title,
    metadata: result.artifact.metadata,
    updated_at: result.artifact.updated_at,
    version_id: result.version?.id,
    reload: true,
  });
  res.json(result);
});

router.put("/artifacts/:id", (req, res) => {
  const { title, kind, mime, renderer, source_type, metadata, files, content, path: filePath, reason } = req.body;
  const inputFiles = Array.isArray(files)
    ? files
    : content !== undefined
      ? [{ path: filePath || defaultPathForMime(mime), content, mime }]
      : undefined;
  try {
    const result = updateArtifact(getDb(), req.params.id, {
      title,
      kind,
      mime,
      renderer,
      source_type,
      metadata,
      files: inputFiles,
      reason: reason || "artifact_update",
    });
    if (!result) {
      res.status(404).json({ error: "Artifact not found" });
      return;
    }
    broadcastGlobal("surface_updated", cardPayload(result.artifact.id));
    broadcastToSurface(result.artifact.id, "surface_updated", {
      id: result.artifact.id,
      title: result.artifact.title,
      metadata: result.artifact.metadata,
      updated_at: result.artifact.updated_at,
      version_id: result.version?.id,
      reload: true,
    });
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.delete("/artifacts/:id", (req, res) => {
  const deleted = deleteArtifact(getDb(), req.params.id);
  if (!deleted) {
    res.status(404).json({ error: "Artifact not found" });
    return;
  }
  broadcastGlobal("surface_deleted", { id: req.params.id });
  res.json({ deleted: true });
});

router.get("/artifacts/:id/manifest", (req, res) => {
  const version = getCurrentArtifactVersion(getDb(), req.params.id);
  if (!version) {
    res.status(404).json({ error: "Artifact version not found" });
    return;
  }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.send(version.manifest_json);
});

router.get("/artifacts/:id/view", (req, res) => {
  const result = readArtifact(getDb(), req.params.id);
  if (!result || !result.version) {
    res.status(404).send("Artifact not found");
    return;
  }
  const preferred = pickRenderableFile(result.files, result.artifact.mime);
  if (!preferred) {
    res.status(404).send("Artifact has no files");
    return;
  }
  const isPreview = req.query.preview === "1";
  const fileUrl = `/artifacts/${encodeURIComponent(result.artifact.id)}/files/${preferred.path.split("/").map(encodeURIComponent).join("/")}`;

  if (preferred.mime === "text/html") {
    res.redirect(fileUrl);
    return;
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderArtifactShell({
    artifactId: result.artifact.id,
    title: result.artifact.title,
    mime: preferred.mime || result.artifact.mime || inferMime(preferred.path),
    filePath: preferred.path,
    fileUrl,
    preview: isPreview,
  }));
});

router.get(/^\/artifacts\/([^/]+)\/files\/(.+)$/, (req, res) => {
  const artifactId = req.params[0];
  const filePath = req.params[1].split("/").map(decodeURIComponent).join("/");
  try {
    const file = getArtifactFile(getDb(), artifactId, filePath);
    if (!file) {
      res.status(404).send("Artifact file not found");
      return;
    }
    const contentType = file.mime || inferMime(file.path);
    const charset = contentType.startsWith("text/") || contentType === "application/json" || contentType === "image/svg+xml";
    res.setHeader("Content-Type", charset ? `${contentType}; charset=utf-8` : contentType);
    res.send(readArtifactFileContent(file));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── Actions (surface → agent) ──

// Surface posts an action (called by iframe via parent postMessage → PWA → here)
router.post("/surfaces/:id/actions", (req, res) => {
  const artifactInfo = readArtifact(getDb(), req.params.id);
  const surface = artifactInfo ? undefined : getSurface(req.params.id);
  if (!artifactInfo && !surface) {
    res.status(404).json({ error: "Surface not found" });
    return;
  }
  const { action, data } = req.body;
  if (!action) {
    res.status(400).json({ error: "action is required" });
    return;
  }
  const act = createAction({ surface_id: req.params.id, action, data });
  const title = surface?.title || artifactInfo!.artifact.title;
  fanOutToOpenClaw(req.params.id, title, action, JSON.stringify(data || {}));
  broadcastGlobal("surface_action", {
    id: act.id,
    surface_id: req.params.id,
    surface_title: title,
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
  const artifact = surface ? undefined : getArtifact(getDb(), req.params.id);
  if (!surface && !artifact) {
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
  const artifact = getArtifact(getDb(), req.params.id);
  const surface = artifact ? undefined : getSurface(req.params.id);
  if (!artifact && !surface) {
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
  const surfaces = listArtifactCards(getDb());
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
window.previewUrl = (id) => {
  const surface = window.__surfaces.find(s => s.id === id);
  return surface && surface.preview_url ? surface.preview_url : '/surfaces/'+id+'/html';
};

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
    const existing = getArtifact(getDb(), item.id) || getSurface(item.id);
    if (existing) {
      res.json({ action: "exists", id: existing.id });
      return;
    }
    const result = createArtifact(getDb(), {
      id: item.id,
      title: item.title,
      kind: "html",
      mime: "text/html",
      source_type: "generated",
      metadata: { icon: item.icon, description: item.description },
      files: [{ path: "index.html", content: item.html!, mime: "text/html" }],
      reason: "marketplace_install",
    });
    broadcastGlobal("surface_created", cardPayload(result.artifact.id));
    res.status(201).json({ action: "installed", id: result.artifact.id, type: "surface" });
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

function cardPayload(id: string) {
  const card = listArtifactCards(getDb()).find((item) => item.id === id);
  return card || { id };
}

function surfaceResponseFromArtifact(result: NonNullable<ReturnType<typeof readArtifact>>) {
  const htmlFile = result.files.find((file) => file.mime === "text/html" || file.path.endsWith(".html"));
  const html = htmlFile ? readArtifactFileContent(htmlFile).toString("utf8") : "";
  return {
    id: result.artifact.id,
    title: result.artifact.title,
    html,
    metadata: result.artifact.metadata,
    created_at: result.artifact.created_at,
    updated_at: result.artifact.updated_at,
    artifact: result.artifact,
    version: result.version,
    files: result.files,
    preview_url: `/artifacts/${result.artifact.id}/view?preview=1`,
    view_url: `/artifacts/${result.artifact.id}/view`,
  };
}

function parseMetadataObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function defaultPathForMime(mime?: string): string {
  if (mime === "text/markdown") return "document.md";
  if (mime === "application/pdf") return "document.pdf";
  if (mime === "image/svg+xml") return "image.svg";
  if (mime?.startsWith("image/")) return "image";
  if (mime?.startsWith("video/")) return "video";
  if (mime?.startsWith("audio/")) return "audio";
  if (mime === "application/vnd.mermaid") return "diagram.mmd";
  return "index.html";
}

function pickRenderableFile(files: Array<{ path: string; mime: string | null }>, artifactMime: string | null) {
  if (files.length === 0) return undefined;
  const preferredMime = artifactMime || files[0].mime;
  return (
    files.find((file) => file.path === "index.html") ||
    files.find((file) => file.mime === preferredMime) ||
    files[0]
  );
}

function renderArtifactShell(params: {
  artifactId: string;
  title: string;
  mime: string;
  filePath: string;
  fileUrl: string;
  preview: boolean;
}): string {
  const title = escapeHtml(params.title);
  const fileUrl = escapeHtml(params.fileUrl);
  const mime = escapeHtml(params.mime);
  const filePath = escapeHtml(params.filePath);
  const previewClass = params.preview ? " preview" : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    * { box-sizing: border-box; }
    html, body { margin: 0; width: 100%; height: 100%; background: #0b0b0f; color: #f4f4f5; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
    body { display: flex; flex-direction: column; overflow: hidden; }
    .bar { display: ${params.preview ? "none" : "flex"}; align-items: center; gap: 12px; padding: 10px 14px; border-bottom: 1px solid rgba(255,255,255,.1); background: rgba(255,255,255,.04); font-size: 12px; color: rgba(255,255,255,.62); }
    .bar strong { color: rgba(255,255,255,.9); font-weight: 500; }
    .viewer { flex: 1; min-height: 0; display: flex; align-items: stretch; justify-content: stretch; overflow: auto; }
    .viewer.preview { overflow: hidden; }
    img, video { display: block; max-width: 100%; max-height: 100%; margin: auto; }
    audio { margin: auto; width: min(720px, 90vw); }
    iframe { width: 100%; height: 100%; border: 0; background: white; }
    pre { width: 100%; margin: 0; padding: 24px; white-space: pre-wrap; overflow: auto; line-height: 1.55; font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .markdown { width: min(880px, calc(100% - 32px)); margin: 0 auto; padding: 28px 0 48px; line-height: 1.65; color: #e5e7eb; }
    .markdown h1, .markdown h2, .markdown h3 { color: white; line-height: 1.2; }
    .markdown code { background: rgba(255,255,255,.08); padding: 2px 4px; border-radius: 4px; }
    .markdown pre code { background: transparent; padding: 0; }
  </style>
</head>
<body>
  <div class="bar"><strong>${title}</strong><span>${mime}</span><span>${filePath}</span></div>
  <main id="viewer" class="viewer${previewClass}"></main>
  <script>
    const mime = ${JSON.stringify(params.mime)};
    const fileUrl = ${JSON.stringify(params.fileUrl)};
    const viewer = document.getElementById("viewer");
    window.parent && window.parent.postMessage({ surfaceProtocol: 1, artifactId: ${JSON.stringify(params.artifactId)}, type: "READY" }, "*");

    const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
    const markdownToHtml = (text) => {
      let escaped = escapeHtml(text);
      escaped = escaped.replace(/^### (.*)$/gm, "<h3>$1</h3>")
        .replace(/^## (.*)$/gm, "<h2>$1</h2>")
        .replace(/^# (.*)$/gm, "<h1>$1</h1>")
        .replace(/\\*\\*(.*?)\\*\\*/g, "<strong>$1</strong>")
        .replace(/\\\`([^\\\`]+)\\\`/g, "<code>$1</code>")
        .replace(/\\n\\n/g, "</p><p>")
        .replace(/\\n/g, "<br>");
      return "<p>" + escaped + "</p>";
    };

    async function render() {
      if (mime.startsWith("image/")) {
        const img = document.createElement("img");
        img.src = fileUrl;
        viewer.appendChild(img);
        return;
      }
      if (mime.startsWith("video/")) {
        const video = document.createElement("video");
        video.src = fileUrl;
        video.controls = true;
        viewer.appendChild(video);
        return;
      }
      if (mime.startsWith("audio/")) {
        const audio = document.createElement("audio");
        audio.src = fileUrl;
        audio.controls = true;
        viewer.appendChild(audio);
        return;
      }
      if (mime === "application/pdf") {
        const frame = document.createElement("iframe");
        frame.src = fileUrl;
        viewer.appendChild(frame);
        return;
      }
      const text = await fetch(fileUrl).then((r) => r.text());
      if (mime === "text/markdown") {
        const div = document.createElement("article");
        div.className = "markdown";
        div.innerHTML = markdownToHtml(text);
        viewer.appendChild(div);
        return;
      }
      const pre = document.createElement("pre");
      pre.textContent = text;
      viewer.appendChild(pre);
    }
    render().catch((err) => {
      viewer.textContent = err.message;
      window.parent && window.parent.postMessage({ surfaceProtocol: 1, artifactId: ${JSON.stringify(params.artifactId)}, type: "ERROR", message: err.message }, "*");
    });
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return char;
    }
  });
}
