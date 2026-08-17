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
  imageThumbPassthrough,
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
import { enqueueThumb, hasAnyThumb, removeThumbs, resolveThumbFile, thumbGenerationFor } from "../thumbs.js";
import { defaultPathForMime, injectSurfaceRuntime, pickRenderableFile, renderArtifactShell, renderThumbPlaceholder } from "../render.js";
import { previewForCard } from "../preview.js";
import { getState, patchState, setStateIfEmpty } from "../state.js";
import { appendChunks, getChunks, DEFAULT_STREAM_CAP } from "../streams.js";
import { listTemplates, renderTemplate, resolveTemplate, templateAssetFiles } from "../templates.js";
import { planeOf, requireSystem, targetOf } from "./helpers.js";
import { getAgentSession, isValidAgentSession, recordAgentLink } from "../agentSessions.js";

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

// `updated_at` is SQLite `datetime('now')`: UTC, one-second resolution. A key
// is only safe to cache forever once its second has closed — a second update
// inside the same second would reuse the string.
const VERSION_KEY_SETTLE_MS = 2000;
function versionKeySettled(updatedAt: string | null | undefined): boolean {
  if (!updatedAt) return false;
  const ms = Date.parse(`${updatedAt.replace(" ", "T")}Z`);
  if (!Number.isFinite(ms)) return false;
  return Date.now() - ms >= VERSION_KEY_SETTLE_MS;
}

// True when GET /artifacts/:id/thumb has a real picture to serve — a cached
// capture, or an image artifact it can pass through. False means the route
// would fall back to the generated placeholder.
export function hasRealThumb(
  id: string,
  mime: string | null | undefined,
  generation?: string | null,
): boolean {
  if (mime && mime.startsWith("image/") && imageThumbPassthrough(getDb(), id)) return true;
  // Any generation counts: an older capture is still a real picture, and the
  // route serves it (short-cached) while the fresh one is taken. Saying `false`
  // here would make the card paint its own cover and never call the route at
  // all — see the `has_thumb` note in docs/core/thumbnails.md.
  try { return hasAnyThumb(id, generation); } catch { return false; }
}

// Full card payload for SSE listeners. Includes hidden rows so clients can see
// a hidden=true update and remove the card themselves (the default list
// filters them out). Null when the row is gone — see broadcastCard.
export function cardPayload(id: string) {
  const card = getArtifactCard(getDb(), id);
  if (!card) return null;
  return {
    ...card,
    has_thumb: hasRealThumb(card.id, card.artifact_mime, thumbGenerationFor(card)),
    preview: previewForCard(getDb(), card),
  };
}

/**
 * Announce a card, or say nothing at all.
 *
 * The dashboard treats these payloads as whole cards: `surface_created`
 * unshifts one into the list and builds a card from it, and `surface_updated`
 * does the same for a row it has never seen. A stub carrying only `{ id }` —
 * which is what a row deleted between the write and the broadcast used to
 * produce — becomes a card with no title, no kind and no preview, and it stays
 * on every connected display until someone reloads. Not broadcasting is the
 * honest answer: the row is gone, and a `surface_deleted` is already on its way.
 */
function broadcastCard(event: string, id: string): void {
  const payload = cardPayload(id);
  if (!payload) return;
  broadcastGlobal(event, payload);
}

// Remember which agent session created (or re-rendered) a surface, so the
// delivery ladder can route actions back to it. System plane only — a paired
// device must not be able to point flowback at an arbitrary session.
function captureAgentLink(req: Request, surfaceId: string): void {
  const session = req.body?.agent_session;
  if (!session) return;
  if (planeOf(req) !== "system") return;
  if (!isValidAgentSession(session)) return;
  // A missing SessionStart registration makes TUI liveness unknowable. Fail
  // closed to the ordinary inbox rather than risk resuming a live rollout.
  if (session.kind === "codex" && !getAgentSession(getDb(), session.session_id)) return;
  recordAgentLink(getDb(), surfaceId, session);
}

/**
 * Options every `res.sendFile` in this file needs.
 *
 * `send` defaults `dotfiles` to "ignore", and with no `root` the whole absolute
 * path is checked for dot segments. Surface's default data directory is
 * `~/.surface`, so every file under it — every cached thumbnail, every stored
 * image — answered 404 on a default install. Nothing was missing and nothing was
 * unreadable; the path had a dot in it. HTML surfaces are sent with `res.send`
 * and so were never affected, which is why the dashboard looked like it worked.
 */
const SEND_FILE_OPTS = { dotfiles: "allow" } as const;

// `onError` is for callers that have a fallback. `res.sendFile` reports
// failures asynchronously — to its callback, or to `next()` when there isn't
// one — so a caller's try/catch only ever sees a synchronous throw, and a
// missing or unreadable file becomes a 500 from the error handler instead of
// whatever the caller would rather have sent.
function sendArtifactFile(
  res: Response,
  file: ArtifactFile,
  artifactId: string,
  onError?: (err: unknown) => void,
): void {
  const contentType = file.mime || inferMime(file.path);
  const charset = contentType.startsWith("text/") || contentType === "application/json" || contentType === "image/svg+xml";
  res.setHeader("Content-Type", charset ? `${contentType}; charset=utf-8` : contentType);
  res.setHeader("ETag", `"${file.sha256}"`);
  if (contentType === "text/html") {
    res.setHeader("Cache-Control", "no-cache");
    const bytes = injectSurfaceRuntime(readArtifactFileContent(file), artifactId);
    res.send(bytes);
    return;
  }
  if (onError) {
    res.sendFile(file.storage_path, SEND_FILE_OPTS, (err) => { if (err) onError(err); });
    return;
  }
  res.sendFile(file.storage_path, SEND_FILE_OPTS);
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
    listening: hasWaiter(card.id, undefined, card.project_root),
    // Whether /thumb would answer with a real picture. The dashboard uses this
    // to paint its own cover for a not-yet-captured surface instead of
    // fetching a placeholder it will replace seconds later.
    has_thumb: hasRealThumb(card.id, card.artifact_mime, thumbGenerationFor(card)),
    // The opening lines of the surface's own content, so a card with no capture
    // yet shows what it holds instead of its title a second time. Cached on
    // version + file mtime, so a warm list costs one stat per card.
    preview: previewForCard(getDb(), card),
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
    captureAgentLink(req, result.artifact.id);
    broadcastCard("surface_created", result.artifact.id);
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
    captureAgentLink(req, result.artifact.id);
    broadcastCard("surface_created", result.artifact.id);
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
  captureAgentLink(req, req.params.id);
  const artifact = getArtifact(getDb(), req.params.id);
  broadcastCard("surface_updated", req.params.id);
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
        // Content unchanged, but the calling session may be new — re-stamp so
        // flowback targets the session that just re-synced this surface.
        captureAgentLink(req, id);
        res.json({ ...readArtifact(db, id)!, unchanged: true });
        return;
      }
      result = updateArtifact(db, id, {
        title: title ?? existing.title,
        metadata: mergedMetadata,
        files: inputFiles,
        reason: "template_rerender",
      })!;
      broadcastCard("surface_updated", id);
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
      broadcastCard("surface_created", result.artifact.id);
    }
    // Re-renders re-stamp the link: `surface sync` runs at session start, so
    // the freshest session becomes the flowback target.
    captureAgentLink(req, result.artifact.id);
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
    captureAgentLink(req, result.artifact.id);
    broadcastCard("surface_created", result.artifact.id);
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
  broadcastCard("surface_updated", result.artifact.id);
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
    // Updates re-stamp too: the session that just rewrote a surface is the
    // freshest flowback target.
    captureAgentLink(req, result.artifact.id);
    broadcastCard("surface_updated", result.artifact.id);
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
  removeThumbs(req.params.id);
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
        broadcastCard("surface_created", "board");
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
    const queryStart = req.originalUrl.indexOf("?");
    const query = queryStart === -1 ? "" : req.originalUrl.slice(queryStart);
    res.setHeader("Cache-Control", "no-cache");
    res.redirect(fileUrl + query);
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
      res.setHeader("Cache-Control", "no-cache");
      res.send(injectSurfaceRuntime(Buffer.from(rendered.html, "utf8"), result.artifact.id));
      return;
    } catch (err: any) {
      console.error(`[templates] on-the-fly render failed for ${result.artifact.id}:`, err.message);
      // fall through to the generic shell
    }
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
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
  const immutableCache = "public, max-age=31536000, immutable";
  const shortCache = "public, max-age=30, stale-while-revalidate=300";
  res.setHeader("Cache-Control", shortCache);

  if (req.query.regenerate === "1") {
    if (!requireSystem(req, res)) return; // re-renders artifact content in headless Chrome
    removeThumbs(req.params.id);
    enqueueThumb(req.params.id);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    res.send(renderThumbPlaceholder({
      id: req.params.id,
      title: result.artifact.title || "Untitled",
      mime,
      preview: previewForCard(getDb(), { id: req.params.id, current_version_id: result.artifact.current_version_id, artifact_mime: mime }),
    }));
    return;
  }

  // An image surface is served as itself, ahead of any capture — a screenshot
  // of the viewer is a crop of the picture, and the card crops it again.
  //
  // The file has to be there. `res.sendFile` reports a missing or unreadable
  // file asynchronously — the try/catch below only ever caught a synchronous
  // throw — so an image whose bytes have gone (a linked file deleted under us,
  // a half-restored workspace) answered with a 500 from Express's error handler
  // instead of falling through to the cached capture or the cover. Stat first,
  // which is the case that actually happens, and pass a callback for the rest:
  // once the stream has started there is nothing to fall back to, so the most
  // honest thing left is to end the response rather than hand Express an error
  // for a request that is already half-answered.
  const passthrough = imageThumbPassthrough(getDb(), req.params.id);
  if (passthrough && fs.existsSync(passthrough.storage_path)) {
    try {
      sendArtifactFile(res, passthrough, req.params.id, () => {
        if (!res.headersSent) res.status(500).end();
        else if (!res.writableEnded) res.end();
      });
      return;
    } catch {}
  }

  // `immutable` is a promise that this exact URL will always mean these exact
  // bytes, for a year. Three things must hold before we are allowed to make it:
  //
  //  1. the request's `v` is the artifact's current revision key. The PWA sends
  //     `?v=<updated_at>`; anything else (e.g. the `?v=<epoch>` one-shot after a
  //     `thumb_ready`) is a cache-buster, not a revision.
  //  2. the capture on disk is of *that* revision — the generation baked into
  //     the filename, not merely "some file for this id exists". Right after an
  //     update the previous revision's PNG is still there, and pinning it under
  //     the new key was the year-long staleness bug.
  //  3. the revision key can no longer be reused. `updated_at` has one-second
  //     resolution, so two updates inside the same second share a key; until
  //     that second has closed we could pin revision A's picture under a key
  //     revision B is about to claim.
  //
  // Anything short of all three gets the short revalidating window — which is
  // also how an older capture keeps the card looking alive while the fresh one
  // is being taken.
  const requestedVersion = typeof req.query.v === "string" ? req.query.v : "";
  const generation = thumbGenerationFor(result.artifact);
  const cached = resolveThumbFile(req.params.id, generation);
  if (cached) {
    if (
      cached.exact &&
      requestedVersion &&
      requestedVersion === result.artifact.updated_at &&
      versionKeySettled(result.artifact.updated_at)
    ) {
      res.setHeader("Cache-Control", immutableCache);
    }
    res.setHeader("Content-Type", "image/png");
    res.sendFile(cached.path, SEND_FILE_OPTS);
    // A capture of an older revision is a stand-in: ask for the current one.
    if (!cached.exact) enqueueThumb(req.params.id);
    return;
  }

  enqueueThumb(req.params.id);
  res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
  res.send(renderThumbPlaceholder({
    id: req.params.id,
    title: result.artifact.title || "Untitled",
    mime,
    preview: previewForCard(getDb(), { id: req.params.id, current_version_id: result.artifact.current_version_id, artifact_mime: mime }),
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
        res.setHeader("Cache-Control", "no-cache");
        res.send(injectSurfaceRuntime(fs.readFileSync(realAbs), artifactId));
      } else {
        res.sendFile(realAbs, SEND_FILE_OPTS);
      }
      return;
    }
    res.status(404).send("Artifact file not found");
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});
