import { Router } from "express";
import type { Request, Response } from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getDb } from "../db.js";
import {
  type ArtifactFile,
  createArtifact,
  deleteArtifact,
  getArtifact,
  getArtifactCard,
  getArtifactFile,
  getCurrentArtifactVersion,
  artifactAuthorPlane,
  inferMime,
  isLinkedArtifact,
  linkArtifact,
  listArtifactCards,
  listArtifactVersions,
  normalizeArtifactPath,
  presentFile,
  readArtifact,
  readArtifactFileContent,
  setCurrentArtifactVersion,
  touchArtifact,
  updateArtifact,
} from "../artifacts.js";
import { addSurfaceClient, broadcastGlobal, broadcastToSurface, hasWaiter } from "../sse.js";
import { enqueueThumb, hasThumb, getThumbPath } from "../thumbs.js";
import { defaultPathForMime, injectSurfaceRuntime, pickRenderableFile, renderArtifactShell, renderThumbPlaceholder } from "../render.js";
import { getState, patchState, setStateIfEmpty } from "../state.js";
import { appendChunks, getChunks, DEFAULT_STREAM_CAP } from "../streams.js";
import { listTemplates, renderTemplate, resolveTemplate, templateAssetFiles } from "../templates.js";
import { planeOf, requireSystem, targetOf } from "./helpers.js";

// Devices may freely CRUD their own (device-authored) artifacts, but must not
// mutate system-authored ones: a system artifact can hold a display_role slot
// or trusted JS that runs in the host display. Returns true if the request may
// proceed; writes a 403 and returns false otherwise.
function canMutateArtifact(req: Request, res: Response, existing: { metadata: string } | undefined): boolean {
  if (!existing) return true; // not-found is handled downstream
  if (req.auth?.role === "system") return true;
  if (artifactAuthorPlane(existing) === "system") {
    res.status(403).json({ error: "Devices cannot modify system-authored artifacts" });
    return false;
  }
  return true;
}

export const artifactsRouter = Router();

// Full card payload for SSE listeners. Includes hidden rows so clients can see
// a hidden=true update and remove the card themselves (the default list
// filters them out).
export function cardPayload(id: string) {
  const card = getArtifactCard(getDb(), id);
  return card || { id };
}

function sendArtifactFile(res: Response, file: ArtifactFile, artifactId: string): void {
  const contentType = file.mime || inferMime(file.path);
  const charset = contentType.startsWith("text/") || contentType === "application/json" || contentType === "image/svg+xml";
  res.setHeader("Content-Type", charset ? `${contentType}; charset=utf-8` : contentType);
  res.setHeader("ETag", `"${file.sha256}"`);
  if (contentType === "text/html") {
    const bytes = injectSurfaceRuntime(readArtifactFileContent(file), artifactId);
    res.send(bytes);
    return;
  }
  res.sendFile(file.storage_path);
}

// Per-surface SSE stream
artifactsRouter.get("/artifacts/:id/stream", (req, res) => {
  if (!getArtifact(getDb(), req.params.id)) {
    res.status(404).json({ error: "Artifact not found" });
    return;
  }
  addSurfaceClient(req.params.id, res, targetOf(req));
});

// Card list — the one fetch the dashboard grid needs. `listening` reflects a
// connected layer-1 waiter (in-memory, so it's annotated here, not in SQL).
artifactsRouter.get("/artifacts", (req, res) => {
  const includeHidden = req.query.include_hidden === "1" || req.query.include_hidden === "true";
  const project = typeof req.query.project === "string" && req.query.project ? req.query.project : undefined;
  const agent = typeof req.query.agent === "string" && req.query.agent ? req.query.agent : undefined;
  res.json(listArtifactCards(getDb(), { includeHidden, project, agent }).map((card) => ({
    ...card,
    listening: hasWaiter(card.id),
  })));
});

artifactsRouter.post("/artifacts/present-file", (req, res) => {
  if (!requireSystem(req, res)) return; // reads the host filesystem
  const { path: filePath, title, metadata, copy, open, project_root } = req.body;
  if (!filePath) {
    res.status(400).json({ error: "path is required" });
    return;
  }
  try {
    const result = presentFile(getDb(), { filePath, title, metadata, copy, open, project_root });
    broadcastGlobal("surface_created", cardPayload(result.artifact.id));
    if (open !== false) broadcastGlobal("display_navigate", { surface_id: result.artifact.id });
    enqueueThumb(result.artifact.id);
    res.status(201).json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

artifactsRouter.post("/artifacts/link", (req, res) => {
  if (!requireSystem(req, res)) return; // serves files straight off the disk
  const { path: linkPath, entry, title, metadata, open, project_root, template, params } = req.body;
  if (!linkPath) {
    res.status(400).json({ error: "path is required" });
    return;
  }
  if (!title) {
    res.status(400).json({ error: "title is required" });
    return;
  }
  try {
    if (template) resolveTemplate(template, project_root); // fail fast on unknown templates
    const mergedMetadata = template
      ? { ...(metadata || {}), template_params: params || {} }
      : metadata;
    const result = linkArtifact(getDb(), { path: linkPath, entry, title, metadata: mergedMetadata, project_root, template });
    broadcastGlobal("surface_created", cardPayload(result.artifact.id));
    if (open !== false) broadcastGlobal("display_navigate", { surface_id: result.artifact.id });
    enqueueThumb(result.artifact.id);
    res.status(201).json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

artifactsRouter.post("/artifacts/:id/touch", (req, res) => {
  const ok = touchArtifact(getDb(), req.params.id);
  if (!ok) {
    res.status(404).json({ error: "Artifact not found" });
    return;
  }
  const artifact = getArtifact(getDb(), req.params.id);
  broadcastGlobal("surface_updated", cardPayload(req.params.id));
  broadcastToSurface(req.params.id, "surface_updated", {
    id: req.params.id,
    title: artifact?.title,
    metadata: artifact?.metadata,
    updated_at: artifact?.updated_at,
    reload: true,
  });
  enqueueThumb(req.params.id);
  res.json({ touched: true });
});

// ── Templates ──

artifactsRouter.get("/api/templates", (req, res) => {
  if (!requireSystem(req, res)) return; // reads .surface/templates from a caller-supplied project root
  const project = typeof req.query.project === "string" && req.query.project ? req.query.project : undefined;
  res.json(listTemplates(project));
});

artifactsRouter.get("/api/templates/:name", (req, res) => {
  if (!requireSystem(req, res)) return; // reads template files from a caller-supplied project root
  const project = typeof req.query.project === "string" && req.query.project ? req.query.project : undefined;
  try {
    const tpl = resolveTemplate(req.params.name, project);
    res.json({ name: tpl.name, source: tpl.source, dir: tpl.dir, contract: tpl.contract });
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

// Instantiate a template into normal artifact files. Re-running with the same
// id updates params and re-renders (docs/templates/overview.md).
function instantiateTemplate(req: Request, res: Response): void {
  const { id, title, metadata, project_root, template, params } = req.body;
  try {
    const tpl = resolveTemplate(template, project_root);
    const rendered = renderTemplate(tpl, params || {}, { title: title || "" });
    const inputFiles = [
      { path: "index.html", content: rendered.html, mime: "text/html" },
      ...templateAssetFiles(tpl),
    ];
    const mergedMetadata = { ...(metadata || {}), template_params: rendered.params };
    const existing = id ? getArtifact(getDb(), id) : undefined;
    const db = getDb();
    let result;
    if (existing) {
      // Idempotent re-render: identical output and title creates no version,
      // so `surface sync` can run on every session start for free.
      const currentEntry = getArtifactFile(db, id, "index.html");
      const renderedSha = crypto.createHash("sha256").update(rendered.html).digest("hex");
      if (currentEntry?.sha256 === renderedSha && (title ?? existing.title) === existing.title) {
        res.json({ ...readArtifact(db, id)!, unchanged: true });
        return;
      }
      result = updateArtifact(db, id, {
        title: title ?? existing.title,
        metadata: mergedMetadata,
        files: inputFiles,
        reason: "template_rerender",
      })!;
      broadcastGlobal("surface_updated", cardPayload(id));
      broadcastToSurface(id, "surface_updated", { id, reload: true, updated_at: result.artifact.updated_at });
    } else {
      result = createArtifact(db, {
        id,
        title: title || tpl.name,
        kind: "html",
        mime: "text/html",
        source_type: "generated",
        template: tpl.name,
        project_root,
        metadata: mergedMetadata,
        files: inputFiles,
        reason: "template_instantiate",
      });
      if (Object.keys(rendered.stateDefaults).length) {
        setStateIfEmpty(db, result.artifact.id, rendered.stateDefaults);
      }
      broadcastGlobal("surface_created", cardPayload(result.artifact.id));
    }
    enqueueThumb(result.artifact.id);
    res.status(existing ? 200 : 201).json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
}

artifactsRouter.post("/artifacts", (req, res) => {
  const { id, title, kind, mime, source_type, metadata, files, content, content_base64, path: filePath, template } = req.body;
  if (template) {
    // Template instantiation renders server-side template files from disk.
    if (!requireSystem(req, res)) return;
    instantiateTemplate(req, res);
    return;
  }
  if (!title) {
    res.status(400).json({ error: "title is required" });
    return;
  }
  if (source_type === "linked") {
    res.status(400).json({ error: "Use POST /artifacts/link to create linked artifacts" });
    return;
  }
  const inputFiles = Array.isArray(files)
    ? files
    : content !== undefined || content_base64 !== undefined
      ? [{ path: filePath || defaultPathForMime(mime), content, content_base64, mime }]
      : [];
  try {
    const result = createArtifact(getDb(), {
      id,
      title,
      kind,
      mime,
      source_type,
      project_root: req.body.project_root,
      metadata,
      files: inputFiles,
      reason: "artifact_create",
      author_plane: planeOf(req),
    });
    broadcastGlobal("surface_created", cardPayload(result.artifact.id));
    enqueueThumb(result.artifact.id);
    res.status(201).json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── Stream chunks (docs/templates/stream.md) ──

artifactsRouter.get("/artifacts/:id/chunks", (req, res) => {
  if (!getArtifact(getDb(), req.params.id)) {
    res.status(404).json({ error: "Artifact not found" });
    return;
  }
  res.json({ chunks: getChunks(getDb(), req.params.id) });
});

artifactsRouter.post("/artifacts/:id/append", (req, res) => {
  if (!requireSystem(req, res)) return;
  const artifact = getArtifact(getDb(), req.params.id);
  if (!artifact) {
    res.status(404).json({ error: "Artifact not found" });
    return;
  }
  const body = req.body || {};
  const chunks: Array<{ kind?: string; content: string }> = Array.isArray(body.chunks)
    ? body.chunks
    : body.content !== undefined
      ? [{ kind: body.kind, content: body.content }]
      : [];
  if (!chunks.length) {
    res.status(400).json({ error: "content or chunks[] is required" });
    return;
  }
  let cap = DEFAULT_STREAM_CAP;
  try {
    const meta = JSON.parse(artifact.metadata);
    if (Number.isFinite(meta?.stream_cap) && meta.stream_cap > 0) cap = Number(meta.stream_cap);
  } catch {}
  const inserted = appendChunks(getDb(), req.params.id, chunks, cap);
  for (const chunk of inserted) {
    const event = { id: req.params.id, seq: chunk.seq, chunk: { kind: chunk.kind, content: chunk.content, created_at: chunk.created_at } };
    broadcastGlobal("stream_append", event);
    broadcastToSurface(req.params.id, "stream_append", event);
  }
  res.status(201).json({ appended: inserted.length, last_seq: inserted[inserted.length - 1]?.seq });
});

artifactsRouter.get("/artifacts/:id", (req, res) => {
  const result = readArtifact(getDb(), req.params.id);
  if (!result) {
    res.status(404).json({ error: "Artifact not found" });
    return;
  }
  res.json({
    ...result,
    preview_url: `/artifacts/${result.artifact.id}/view?preview=1`,
    view_url: `/artifacts/${result.artifact.id}/view`,
  });
});

artifactsRouter.get("/artifacts/:id/versions", (req, res) => {
  if (!getArtifact(getDb(), req.params.id)) {
    res.status(404).json({ error: "Artifact not found" });
    return;
  }
  res.json(listArtifactVersions(getDb(), req.params.id));
});

artifactsRouter.post("/artifacts/:id/rollback", (req, res) => {
  const { version } = req.body;
  if (version === undefined) {
    res.status(400).json({ error: "version is required" });
    return;
  }
  const existing = getArtifact(getDb(), req.params.id);
  if (!canMutateArtifact(req, res, existing)) return;
  if (isLinkedArtifact(existing)) {
    res.status(409).json({ error: "Linked artifacts have no version history; git is the source of truth." });
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
  enqueueThumb(result.artifact.id);
  res.json(result);
});

artifactsRouter.put("/artifacts/:id", (req, res) => {
  const { title, kind, mime, metadata, files, content, content_base64, path: filePath, reason } = req.body;
  const inputFiles = Array.isArray(files)
    ? files
    : content !== undefined || content_base64 !== undefined
      ? [{ path: filePath || defaultPathForMime(mime), content, content_base64, mime }]
      : undefined;
  const existing = getArtifact(getDb(), req.params.id);
  if (!canMutateArtifact(req, res, existing)) return;
  if (isLinkedArtifact(existing) && inputFiles) {
    res.status(409).json({
      error: "Linked artifacts are edited on disk. Use POST /artifacts/:id/touch after editing.",
    });
    return;
  }
  // Optional concurrency guard: If-Match pins the version this update was
  // computed against; a mismatch means someone published in between.
  const ifMatch = req.headers["if-match"];
  if (existing && typeof ifMatch === "string" && ifMatch.trim()) {
    const expected = ifMatch.trim().replace(/^"|"$/g, "");
    if (expected !== existing.current_version_id) {
      res.status(412).json({
        error: "Version mismatch: the artifact changed since you read it",
        current_version_id: existing.current_version_id,
      });
      return;
    }
  }
  try {
    const result = updateArtifact(getDb(), req.params.id, {
      title,
      kind,
      mime,
      metadata,
      files: inputFiles,
      reason: reason || "artifact_update",
      author_plane: planeOf(req),
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
    if (inputFiles) enqueueThumb(result.artifact.id);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

artifactsRouter.delete("/artifacts/:id", (req, res) => {
  const existing = getArtifact(getDb(), req.params.id);
  if (!canMutateArtifact(req, res, existing)) return; // devices can't delete system-authored artifacts
  const deleted = deleteArtifact(getDb(), req.params.id);
  if (!deleted) {
    res.status(404).json({ error: "Artifact not found" });
    return;
  }
  try { fs.rmSync(getThumbPath(req.params.id), { force: true }); } catch {}
  broadcastGlobal("surface_deleted", { id: req.params.id });
  res.json({ deleted: true });
});

// ── Surface state (docs/state/stateful-surfaces.md) ──
// One JSON doc per surface; reads are open to devices, writes are system-only.

artifactsRouter.get("/artifacts/:id/state", (req, res) => {
  if (!getArtifact(getDb(), req.params.id)) {
    res.status(404).json({ error: "Artifact not found" });
    return;
  }
  res.json(getState(getDb(), req.params.id));
});

artifactsRouter.patch("/artifacts/:id/state", (req, res) => {
  if (!requireSystem(req, res)) return;
  if (!getArtifact(getDb(), req.params.id)) {
    // The default global board materializes on first write
    // (docs/templates/board.md): `surface set board <agent> …` just works.
    if (req.params.id === "board") {
      try {
        const tpl = resolveTemplate("board", req.body?.__project_root);
        const rendered = renderTemplate(tpl, {});
        createArtifact(getDb(), {
          id: "board",
          title: "Agent Board",
          kind: "html",
          mime: "text/html",
          source_type: "generated",
          template: "board",
          metadata: { template_params: rendered.params },
          files: [
            { path: "index.html", content: rendered.html, mime: "text/html" },
            ...templateAssetFiles(tpl),
          ],
          reason: "board_first_write",
        });
        broadcastGlobal("surface_created", cardPayload("board"));
        enqueueThumb("board");
      } catch (err: any) {
        res.status(400).json({ error: `Could not create the board: ${err.message}` });
        return;
      }
    } else {
      res.status(404).json({ error: "Artifact not found" });
      return;
    }
  }
  try {
    let patch = req.body;
    // Board sections get a server-stamped updated_at so staleness dimming
    // doesn't depend on agents remembering to send timestamps.
    const artifact = getArtifact(getDb(), req.params.id);
    if (artifact?.template === "board" && patch && typeof patch === "object") {
      const stamped: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
        stamped[key] = value && typeof value === "object" && !Array.isArray(value)
          ? { ...(value as object), updated_at: new Date().toISOString() }
          : value;
      }
      patch = stamped;
    }
    const result = patchState(getDb(), req.params.id, patch);
    const event = { id: req.params.id, patch, state_version: result.state_version };
    broadcastGlobal("state_patch", event);
    broadcastToSurface(req.params.id, "state_patch", event);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

artifactsRouter.get("/artifacts/:id/manifest", (req, res) => {
  const version = getCurrentArtifactVersion(getDb(), req.params.id);
  if (!version) {
    res.status(404).json({ error: "Artifact version not found" });
    return;
  }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.send(version.manifest_json);
});

artifactsRouter.get("/artifacts/:id/view", (req, res) => {
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

  // A templated artifact whose entry isn't HTML (e.g. `surface doc` wrapping a
  // linked markdown file) renders its template on the fly: the template gets
  // content_url and fetches the live bytes itself, so touch-reload keeps
  // working without any stored render.
  if (result.artifact.template) {
    try {
      const tpl = resolveTemplate(result.artifact.template, result.artifact.project_root || undefined);
      let params: Record<string, unknown> = {};
      try { params = JSON.parse(result.artifact.metadata)?.template_params || {}; } catch {}
      const rendered = renderTemplate(tpl, params, {
        title: result.artifact.title,
        content_url: fileUrl,
        file_path: preferred.path,
        preview: isPreview,
      });
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(injectSurfaceRuntime(Buffer.from(rendered.html, "utf8"), result.artifact.id));
      return;
    } catch (err: any) {
      console.error(`[templates] on-the-fly render failed for ${result.artifact.id}:`, err.message);
      // fall through to the generic shell
    }
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

artifactsRouter.get("/artifacts/:id/thumb", (req, res) => {
  const result = readArtifact(getDb(), req.params.id);
  if (!result || !result.version) {
    res.status(404).send("Artifact not found");
    return;
  }
  const mime = result.artifact.mime || "";
  res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=600");

  if (req.query.regenerate === "1") {
    if (!requireSystem(req, res)) return; // re-renders artifact content in headless Chrome
    try { fs.rmSync(getThumbPath(req.params.id), { force: true }); } catch {}
    enqueueThumb(req.params.id);
    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    res.send(renderThumbPlaceholder({
      title: result.artifact.title || "Untitled",
      mime,
    }));
    return;
  }

  if (hasThumb(req.params.id)) {
    try {
      res.setHeader("Content-Type", "image/png");
      res.sendFile(getThumbPath(req.params.id));
      return;
    } catch {}
  }

  if (mime.startsWith("image/")) {
    const preferred =
      result.files.find((f) => f.path === "index.html") ||
      result.files.find((f) => f.mime === mime) ||
      result.files[0];
    if (preferred) {
      try {
        sendArtifactFile(res, preferred, req.params.id);
        return;
      } catch {}
    }
  }

  enqueueThumb(req.params.id);
  res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
  res.send(renderThumbPlaceholder({
    title: result.artifact.title || "Untitled",
    mime,
  }));
});

artifactsRouter.get(/^\/artifacts\/([^/]+)\/files\/(.+)$/, (req, res) => {
  const artifactId = req.params[0];
  const filePath = req.params[1].split("/").map(decodeURIComponent).join("/");
  try {
    const file = getArtifactFile(getDb(), artifactId, filePath);
    if (file) {
      sendArtifactFile(res, file, artifactId);
      return;
    }
    // Linked-artifact fallback: serve any file under workspace_path that wasn't pre-registered.
    const artifact = getArtifact(getDb(), artifactId);
    if (isLinkedArtifact(artifact) && artifact!.workspace_path) {
      let normalized: string;
      try {
        normalized = normalizeArtifactPath(filePath);
      } catch {
        res.status(400).send("Invalid path");
        return;
      }
      const root = path.resolve(artifact!.workspace_path);
      const abs = path.resolve(root, normalized);
      const sep = root.endsWith(path.sep) ? root : root + path.sep;
      if (abs !== root && !abs.startsWith(sep)) {
        res.status(403).send("Path escapes linked root");
        return;
      }
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        res.status(404).send("File not found");
        return;
      }
      // Resolve symlinks and re-verify containment — a symlink inside the linked
      // dir that points outside it must not leak host files.
      let realAbs: string;
      let realRoot: string;
      try {
        realAbs = fs.realpathSync(abs);
        realRoot = fs.realpathSync(root);
      } catch {
        res.status(404).send("File not found");
        return;
      }
      const realSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
      if (realAbs !== realRoot && !realAbs.startsWith(realSep)) {
        res.status(403).send("Path escapes linked root");
        return;
      }
      const mime = inferMime(realAbs);
      const charset = mime.startsWith("text/") || mime === "application/json" || mime === "image/svg+xml";
      res.setHeader("Content-Type", charset ? `${mime}; charset=utf-8` : mime);
      if (mime === "text/html") {
        res.send(injectSurfaceRuntime(fs.readFileSync(realAbs), artifactId));
      } else {
        res.sendFile(realAbs);
      }
      return;
    }
    res.status(404).send("Artifact file not found");
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});
