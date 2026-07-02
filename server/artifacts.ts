import type Database from "better-sqlite3";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getWorkspaceDir } from "./paths.js";

export type ArtifactKind = "file" | "html" | "project" | "external";
export type ArtifactSourceType = "generated" | "presented_file" | "imported_url" | "project" | "linked";
export type ArtifactStorageKind = "workspace" | "external";

export interface Artifact {
  id: string;
  title: string;
  kind: ArtifactKind;
  mime: string | null;
  source_type: ArtifactSourceType;
  template: string | null;
  project_root: string | null;
  current_version_id: string | null;
  workspace_path: string | null;
  metadata: string;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ArtifactVersion {
  id: string;
  artifact_id: string;
  parent_version_id: string | null;
  version: number;
  reason: string | null;
  manifest_json: string;
  content_hash: string | null;
  created_at: string;
}

export interface ArtifactFile {
  id: string;
  artifact_version_id: string;
  path: string;
  mime: string | null;
  size_bytes: number;
  sha256: string;
  storage_kind: ArtifactStorageKind;
  storage_path: string;
  created_at: string;
}

// Full card payload — everything the dashboard grid needs in one row, so the
// list endpoint is a single fetch (no per-card follow-ups).
export interface SurfaceCard {
  id: string;
  title: string;
  metadata: string;
  project_root: string | null;
  agent: string | null;
  template: string | null;
  created_at: string;
  updated_at: string;
  artifact_id: string;
  artifact_kind: string;
  artifact_mime: string | null;
  current_version_id: string | null;
  first_file_path: string | null;
  pending_actions: number;
  preview_url?: string;
  view_url?: string;
}

export interface ArtifactInputFile {
  path?: string;
  content?: string | Buffer;
  content_base64?: string;
  mime?: string;
}

const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".ts": "text/typescript",
  ".tsx": "text/typescript-jsx",
  ".jsx": "text/javascript-jsx",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mermaid": "application/vnd.mermaid",
  ".mmd": "application/vnd.mermaid",
};

// Schema lives in server/migrations.ts (baseline). New schema changes append a
// post-baseline migration there.

export function inferMime(filePath: string, fallback = "application/octet-stream"): string {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] || fallback;
}

// An artifact id is used verbatim to build filesystem paths (workspace dir,
// thumbnail file). It can arrive from a client JSON body (`POST /artifacts`,
// reachable by the device plane), so it must never contain path separators or
// traversal segments. Allow only the characters uuidv4 and template/user ids
// actually use.
export function assertSafeArtifactId(id: string): void {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    throw new Error(`Invalid artifact id: ${id}`);
  }
}

export type ArtifactPlane = "system" | "device";

// `metadata.author_plane` records which trust plane authored the current bytes;
// the thumbnailer reads it to decide whether running the artifact's JS is safe
// (see server/thumbs.ts). It is server-authoritative — never trust a value from
// the request body — and `display_role` (slot assignment) is system-only. This
// is the one chokepoint that enforces both, so every create/update path that
// stores metadata must route through it.
export function sealArtifactMetadata(
  metadata: Record<string, unknown> | undefined,
  plane: ArtifactPlane,
): Record<string, unknown> {
  const sealed = { ...(metadata || {}) };
  delete sealed.author_plane; // server sets this, clients never do
  if (plane !== "system") delete sealed.display_role; // slots are system-only
  sealed.author_plane = plane;
  return sealed;
}

// Reads the authoring plane of an existing artifact. Pre-plane (legacy) rows and
// anything unparseable default to "system" — the conservative choice: devices
// can't mutate them and their JS is treated as trusted (they were loopback-made).
export function artifactAuthorPlane(artifact: { metadata: string } | undefined): ArtifactPlane {
  if (!artifact) return "system";
  try {
    return JSON.parse(artifact.metadata)?.author_plane === "device" ? "device" : "system";
  } catch {
    return "system";
  }
}

export function normalizeArtifactPath(input: string): string {
  const raw = (input || "index.html").replace(/\\/g, "/").trim();
  if (!raw || raw.startsWith("/") || /^[a-zA-Z]:\//.test(raw)) {
    throw new Error(`Invalid artifact path: ${input}`);
  }
  const parts = raw.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Invalid artifact path: ${input}`);
  }
  return parts.join("/");
}

export function getArtifact(db: Database.Database, id: string): Artifact | undefined {
  return db.prepare(`SELECT * FROM artifacts WHERE id = ? AND deleted_at IS NULL`).get(id) as Artifact | undefined;
}

export function getArtifactVersion(db: Database.Database, id: string): ArtifactVersion | undefined {
  return db.prepare(`SELECT * FROM artifact_versions WHERE id = ?`).get(id) as ArtifactVersion | undefined;
}

export function getCurrentArtifactVersion(db: Database.Database, artifactId: string): ArtifactVersion | undefined {
  return db
    .prepare(
      `SELECT av.*
       FROM artifact_versions av
       JOIN artifacts a ON a.current_version_id = av.id
       WHERE a.id = ?`
    )
    .get(artifactId) as ArtifactVersion | undefined;
}

export function listArtifactVersions(db: Database.Database, artifactId: string): ArtifactVersion[] {
  return db
    .prepare(`SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY version DESC`)
    .all(artifactId) as ArtifactVersion[];
}

export function setCurrentArtifactVersion(
  db: Database.Database,
  artifactId: string,
  version: string | number
): ReturnType<typeof readArtifact> | undefined {
  const artifact = getArtifact(db, artifactId);
  if (!artifact) return undefined;
  const versionRow =
    typeof version === "number" || /^\d+$/.test(String(version))
      ? (db.prepare(`SELECT * FROM artifact_versions WHERE artifact_id = ? AND version = ?`).get(artifactId, Number(version)) as ArtifactVersion | undefined)
      : getArtifactVersion(db, String(version));
  if (!versionRow || versionRow.artifact_id !== artifactId) return undefined;
  db.prepare(`UPDATE artifacts SET current_version_id = ?, updated_at = datetime('now') WHERE id = ?`).run(versionRow.id, artifactId);
  return readArtifact(db, artifactId);
}

export function getArtifactFiles(db: Database.Database, versionId: string): ArtifactFile[] {
  return db
    .prepare(`SELECT * FROM artifact_files WHERE artifact_version_id = ? ORDER BY path ASC`)
    .all(versionId) as ArtifactFile[];
}

export function getArtifactFile(db: Database.Database, artifactId: string, filePath: string, version?: string): ArtifactFile | undefined {
  const normalized = normalizeArtifactPath(filePath);
  if (version) {
    const versionRow = /^\d+$/.test(version)
      ? (db.prepare(`SELECT * FROM artifact_versions WHERE artifact_id = ? AND version = ?`).get(artifactId, Number(version)) as ArtifactVersion | undefined)
      : getArtifactVersion(db, version);
    if (!versionRow) return undefined;
    return db.prepare(`SELECT * FROM artifact_files WHERE artifact_version_id = ? AND path = ?`).get(versionRow.id, normalized) as ArtifactFile | undefined;
  }

  return db
    .prepare(
      `SELECT af.*
       FROM artifact_files af
       JOIN artifacts a ON a.current_version_id = af.artifact_version_id
       WHERE a.id = ? AND af.path = ?`
    )
    .get(artifactId, normalized) as ArtifactFile | undefined;
}

export function listArtifactCards(
  db: Database.Database,
  opts?: { includeHidden?: boolean; project?: string; agent?: string }
): SurfaceCard[] {
  const where: string[] = ["a.deleted_at IS NULL"];
  const params: unknown[] = [];
  if (opts?.project) {
    where.push("a.project_root = ?");
    params.push(opts.project);
  }
  if (opts?.agent) {
    where.push("json_extract(a.metadata, '$.agent') = ?");
    params.push(opts.agent);
  }
  const rows = db
    .prepare(
      `SELECT
        a.id,
        a.title,
        a.metadata,
        a.project_root,
        json_extract(a.metadata, '$.agent') AS agent,
        a.template,
        a.created_at,
        a.updated_at,
        a.id AS artifact_id,
        a.kind AS artifact_kind,
        a.mime AS artifact_mime,
        a.current_version_id AS current_version_id,
        (
          SELECT af.path
          FROM artifact_files af
          WHERE af.artifact_version_id = a.current_version_id
          ORDER BY CASE WHEN af.path = 'index.html' THEN 0 ELSE 1 END, af.path
          LIMIT 1
        ) AS first_file_path,
        (
          SELECT count(*)
          FROM surface_actions sa
          WHERE sa.surface_id = a.id AND sa.status = 'pending'
        ) AS pending_actions
       FROM artifacts a
       WHERE ${where.join(" AND ")}
       ORDER BY a.updated_at DESC`
    )
    .all(...params) as SurfaceCard[];

  const all = rows.map((row) => ({
    ...row,
    preview_url: `/artifacts/${row.id}/view?preview=1`,
    view_url: `/artifacts/${row.id}/view`,
  }));
  if (opts?.includeHidden) return all;
  return all.filter((row) => {
    try {
      const meta = typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata;
      return !(meta && (meta as any).hidden === true);
    } catch { return true; }
  });
}

export function getArtifactCard(db: Database.Database, id: string): SurfaceCard | undefined {
  const row = db
    .prepare(
      `SELECT
        a.id,
        a.title,
        a.metadata,
        a.project_root,
        json_extract(a.metadata, '$.agent') AS agent,
        a.template,
        a.created_at,
        a.updated_at,
        a.id AS artifact_id,
        a.kind AS artifact_kind,
        a.mime AS artifact_mime,
        a.current_version_id AS current_version_id,
        (
          SELECT af.path
          FROM artifact_files af
          WHERE af.artifact_version_id = a.current_version_id
          ORDER BY CASE WHEN af.path = 'index.html' THEN 0 ELSE 1 END, af.path
          LIMIT 1
        ) AS first_file_path,
        (
          SELECT count(*)
          FROM surface_actions sa
          WHERE sa.surface_id = a.id AND sa.status = 'pending'
        ) AS pending_actions
       FROM artifacts a
       WHERE a.deleted_at IS NULL AND a.id = ?`,
    )
    .get(id) as SurfaceCard | undefined;
  return row ? {
    ...row,
    preview_url: `/artifacts/${row.id}/view?preview=1`,
    view_url: `/artifacts/${row.id}/view`,
  } : undefined;
}

export function readArtifact(db: Database.Database, id: string) {
  const artifact = getArtifact(db, id);
  if (!artifact) return undefined;
  const version = getCurrentArtifactVersion(db, id);
  const files = version ? getArtifactFiles(db, version.id) : [];
  return { artifact, version, files };
}

export function createArtifact(
  db: Database.Database,
  params: {
    id?: string;
    title: string;
    kind?: ArtifactKind;
    mime?: string;
    source_type?: ArtifactSourceType;
    template?: string;
    project_root?: string;
    metadata?: Record<string, unknown>;
    files: ArtifactInputFile[];
    reason?: string;
    author_plane?: ArtifactPlane;
  }
) {
  if (!params.title) throw new Error("title is required");
  if (!params.files.length) throw new Error("at least one file is required");

  const id = params.id || uuidv4();
  assertSafeArtifactId(id);
  const firstPath = normalizeArtifactPath(params.files[0].path || "index.html");
  const mime = params.mime || params.files[0].mime || inferMime(firstPath);
  const kind = params.kind || (mime === "text/html" ? "html" : "file");
  const metadata = JSON.stringify(sealArtifactMetadata(params.metadata, params.author_plane || "system"));
  const artifactWorkspace = path.join(getWorkspaceDir(), "artifacts", id);

  const tx = db.transaction(() => {
    // Existence + soft-delete recycle must happen inside the transaction so two
    // concurrent creates with the same id don't both pass the check and step on
    // each other's version rows.
    const existingAny = db
      .prepare(`SELECT id, deleted_at FROM artifacts WHERE id = ?`)
      .get(id) as { id: string; deleted_at: string | null } | undefined;
    if (existingAny && !existingAny.deleted_at) {
      throw new Error(`Artifact already exists: ${id}`);
    }
    if (existingAny?.deleted_at) {
      removeArtifactWorkspace(id);
      db.prepare(`DELETE FROM artifacts WHERE id = ?`).run(id);
    }
    db.prepare(
      `INSERT INTO artifacts (id, title, kind, mime, source_type, template, project_root, workspace_path, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      params.title,
      kind,
      mime,
      params.source_type || "generated",
      params.template || null,
      params.project_root || null,
      artifactWorkspace,
      metadata
    );
    const version = createArtifactVersion(db, id, params.files, {
      reason: params.reason,
      parent_version_id: null,
    });
    db.prepare(`UPDATE artifacts SET current_version_id = ?, updated_at = datetime('now') WHERE id = ?`).run(version.id, id);
  });
  tx();
  return readArtifact(db, id)!;
}

export function updateArtifact(
  db: Database.Database,
  id: string,
  params: {
    title?: string;
    kind?: ArtifactKind;
    mime?: string;
    metadata?: Record<string, unknown>;
    files?: ArtifactInputFile[];
    reason?: string;
    author_plane?: ArtifactPlane;
  }
) {
  const existing = getArtifact(db, id);
  if (!existing) return undefined;

  const currentVersion = getCurrentArtifactVersion(db, id);
  const plane = params.author_plane || "system";
  const tx = db.transaction(() => {
    if (params.files?.length) {
      const version = createArtifactVersion(db, id, params.files!, {
        reason: params.reason,
        parent_version_id: currentVersion?.id || null,
      });
      db.prepare(`UPDATE artifacts SET current_version_id = ? WHERE id = ?`).run(version.id, id);
    }
    // Re-seal: a caller-supplied metadata replaces the doc; otherwise carry the
    // existing one forward. Either way the plane is re-stamped, so a device
    // touching an artifact downgrades it (its JS stops being thumbnail-trusted).
    let baseMeta: Record<string, unknown>;
    if (params.metadata !== undefined) {
      baseMeta = params.metadata;
    } else {
      try { baseMeta = JSON.parse(existing.metadata) || {}; } catch { baseMeta = {}; }
    }
    const metadata = JSON.stringify(sealArtifactMetadata(baseMeta, plane));
    db.prepare(
      `UPDATE artifacts
       SET title = ?, kind = ?, mime = ?, metadata = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      params.title ?? existing.title,
      params.kind ?? existing.kind,
      params.mime ?? existing.mime,
      metadata,
      id
    );
  });
  tx();
  return readArtifact(db, id);
}

export function deleteArtifact(db: Database.Database, id: string): boolean {
  let changed = 0;
  const tx = db.transaction(() => {
    const result = db.prepare(`UPDATE artifacts SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL`).run(id);
    changed = result.changes;
    if (!changed) return;
    // Clear any pending user actions queued against this surface so they don't
    // accumulate forever or wake `surface wait` listeners after the surface
    // is gone.
    db.prepare(`DELETE FROM surface_actions WHERE surface_id = ?`).run(id);
    db.prepare(`DELETE FROM surface_state WHERE artifact_id = ?`).run(id);
    db.prepare(`DELETE FROM surface_bindings WHERE surface_id = ?`).run(id);
    db.prepare(`DELETE FROM surface_stream_chunks WHERE artifact_id = ?`).run(id);
    db.prepare(`DELETE FROM artifact_files WHERE artifact_version_id IN (SELECT id FROM artifact_versions WHERE artifact_id = ?)`).run(id);
    db.prepare(`DELETE FROM artifact_versions WHERE artifact_id = ?`).run(id);
  });
  tx();
  if (changed) removeArtifactWorkspace(id);
  return changed > 0;
}

export function presentFile(
  db: Database.Database,
  params: {
    filePath: string;
    title?: string;
    project_root?: string;
    metadata?: Record<string, unknown>;
    copy?: boolean;
    open?: boolean;
  }
) {
  if (params.copy === false) {
    throw new Error("copy=false live-linked artifacts are not supported yet; omit copy or set copy=true for deterministic presentation");
  }
  const resolved = path.resolve(params.filePath);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error(`Not a file: ${resolved}`);
  const title = params.title || path.basename(resolved);
  const mime = inferMime(resolved);
  const content = fs.readFileSync(resolved);
  const metadata = {
    icon: iconForMime(mime),
    description: `${mime} file presented from ${resolved}`,
    original_path: resolved,
    ...(params.metadata || {}),
  };
  return createArtifact(db, {
    title,
    kind: mime === "text/html" ? "html" : "file",
    mime,
    source_type: "presented_file",
    project_root: params.project_root,
    metadata,
    files: [{ path: path.basename(resolved), content, mime }],
    reason: "present_file",
  });
}

export function readArtifactFileContent(file: ArtifactFile): Buffer {
  return fs.readFileSync(file.storage_path);
}

export function isLinkedArtifact(artifact: Artifact | undefined): boolean {
  return artifact?.source_type === "linked";
}

export function linkArtifact(
  db: Database.Database,
  params: {
    path: string;
    entry?: string;
    title: string;
    project_root?: string;
    template?: string;
    metadata?: Record<string, unknown>;
  }
) {
  if (!params.path) throw new Error("path is required");
  if (!params.title) throw new Error("title is required");

  const absPath = path.resolve(params.path);
  if (!fs.existsSync(absPath)) throw new Error(`Path does not exist: ${absPath}`);

  // Resolve symlinks before any containment check so a symlink can't smuggle the
  // real target past SURFACE_LINK_ROOTS or out of a linked directory root.
  let realPath: string;
  try {
    realPath = fs.realpathSync(absPath);
  } catch {
    throw new Error(`Path does not exist: ${absPath}`);
  }

  const rootsEnv = process.env.SURFACE_LINK_ROOTS;
  if (rootsEnv) {
    const roots = rootsEnv
      .split(":")
      .map((r) => r.trim())
      .filter(Boolean)
      .map((r) => {
        try { return fs.realpathSync(path.resolve(r)); }
        catch { return path.resolve(r); }
      });
    const allowed = roots.some((root) => {
      const sep = root.endsWith(path.sep) ? root : root + path.sep;
      return realPath === root || realPath.startsWith(sep);
    });
    if (!allowed) {
      throw new Error(`Path ${absPath} is not under any SURFACE_LINK_ROOTS root`);
    }
  }

  const stat = fs.statSync(realPath);
  const isDirectory = stat.isDirectory();

  let workspaceRoot: string;
  let entryRelPath: string;
  let entryAbsPath: string;

  if (isDirectory) {
    if (!params.entry) throw new Error("entry is required when linking a directory");
    workspaceRoot = realPath;
    entryRelPath = normalizeArtifactPath(params.entry);
    const candidate = path.resolve(workspaceRoot, entryRelPath);
    const sep = workspaceRoot.endsWith(path.sep) ? workspaceRoot : workspaceRoot + path.sep;
    if (candidate !== workspaceRoot && !candidate.startsWith(sep)) {
      throw new Error(`Entry escapes linked root: ${entryRelPath}`);
    }
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
      throw new Error(`Entry file not found: ${candidate}`);
    }
    // Re-verify against symlink-resolved paths.
    let realEntry: string;
    try { realEntry = fs.realpathSync(candidate); }
    catch { throw new Error(`Entry file not found: ${candidate}`); }
    if (realEntry !== workspaceRoot && !realEntry.startsWith(sep)) {
      throw new Error(`Entry escapes linked root via symlink: ${entryRelPath}`);
    }
    entryAbsPath = realEntry;
  } else {
    workspaceRoot = path.dirname(realPath);
    entryRelPath = path.basename(realPath);
    entryAbsPath = realPath;
  }

  const data = fs.readFileSync(entryAbsPath);
  const mime = inferMime(entryAbsPath);
  const sha256 = crypto.createHash("sha256").update(data).digest("hex");
  const kind: ArtifactKind = mime === "text/html" ? "html" : "file";

  const artifactId = uuidv4();
  const versionId = uuidv4();
  const fileId = uuidv4();
  // Sealed through the same chokepoint as create/update: linking is system-only
  // today, but stamping author_plane keeps every metadata-writing path consistent.
  const metadataJson = JSON.stringify(sealArtifactMetadata({
    icon: iconForMime(mime),
    description: `linked from ${absPath}`,
    original_path: absPath,
    linked: true,
    ...(params.metadata || {}),
  }, "system"));

  const manifest = {
    artifact_id: artifactId,
    version: 1,
    linked: true,
    workspace_path: workspaceRoot,
    files: [{ path: entryRelPath, mime, size_bytes: data.length, sha256 }],
  };

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO artifacts (id, title, kind, mime, source_type, template, project_root, workspace_path, metadata, current_version_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(artifactId, params.title, kind, mime, "linked", params.template || null, params.project_root || null, workspaceRoot, metadataJson, versionId);

    db.prepare(
      `INSERT INTO artifact_versions (id, artifact_id, parent_version_id, version, reason, manifest_json, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(versionId, artifactId, null, 1, "link", JSON.stringify(manifest), sha256);

    db.prepare(
      `INSERT INTO artifact_files (id, artifact_version_id, path, mime, size_bytes, sha256, storage_kind, storage_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(fileId, versionId, entryRelPath, mime, data.length, sha256, "external", entryAbsPath);
  });
  tx();

  return readArtifact(db, artifactId)!;
}

export function touchArtifact(db: Database.Database, id: string): boolean {
  const artifact = getArtifact(db, id);
  if (!artifact) return false;
  db.prepare(`UPDATE artifacts SET updated_at = datetime('now') WHERE id = ?`).run(id);
  return true;
}

function createArtifactVersion(
  db: Database.Database,
  artifactId: string,
  inputFiles: ArtifactInputFile[],
  options: {
    parent_version_id: string | null;
    reason?: string;
  }
): ArtifactVersion {
  const nextVersion =
    ((db.prepare(`SELECT max(version) AS version FROM artifact_versions WHERE artifact_id = ?`).get(artifactId) as { version: number | null }).version || 0) + 1;
  const versionId = uuidv4();
  const versionDir = path.join(getWorkspaceDir(), "artifacts", artifactId, "versions", String(nextVersion));
  const filesDir = path.join(versionDir, "files");
  fs.mkdirSync(filesDir, { recursive: true });

  const fileRows = inputFiles.map((file) => {
    const artifactPath = normalizeArtifactPath(file.path || "index.html");
    const mime = file.mime || inferMime(artifactPath);
    const data = decodeInputFile(file, mime);
    const sha256 = crypto.createHash("sha256").update(data).digest("hex");
    const diskPath = path.join(filesDir, ...artifactPath.split("/"));
    const resolvedDiskPath = path.resolve(diskPath);
    const resolvedFilesDir = path.resolve(filesDir);
    if (!resolvedDiskPath.startsWith(resolvedFilesDir + path.sep) && resolvedDiskPath !== resolvedFilesDir) {
      throw new Error(`Artifact path escapes workspace: ${artifactPath}`);
    }
    fs.mkdirSync(path.dirname(resolvedDiskPath), { recursive: true });
    fs.writeFileSync(resolvedDiskPath, data);
    return {
      id: uuidv4(),
      artifact_version_id: versionId,
      path: artifactPath,
      mime,
      size_bytes: data.length,
      sha256,
      storage_kind: "workspace" as const,
      storage_path: resolvedDiskPath,
    };
  });

  const contentHash = crypto
    .createHash("sha256")
    .update(fileRows.map((file) => `${file.path}:${file.sha256}`).sort().join("\n"))
    .digest("hex");
  const manifest = {
    artifact_id: artifactId,
    version: nextVersion,
    files: fileRows.map(({ path: filePath, mime, size_bytes, sha256 }) => ({ path: filePath, mime, size_bytes, sha256 })),
  };
  fs.writeFileSync(path.join(versionDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  db.prepare(
    `INSERT INTO artifact_versions (id, artifact_id, parent_version_id, version, reason, manifest_json, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    versionId,
    artifactId,
    options.parent_version_id,
    nextVersion,
    options.reason || null,
    JSON.stringify(manifest),
    contentHash
  );

  const insertFile = db.prepare(
    `INSERT INTO artifact_files (id, artifact_version_id, path, mime, size_bytes, sha256, storage_kind, storage_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const file of fileRows) {
    insertFile.run(file.id, file.artifact_version_id, file.path, file.mime, file.size_bytes, file.sha256, file.storage_kind, file.storage_path);
  }

  return getArtifactVersion(db, versionId)!;
}

function isTextLikeMime(mime: string): boolean {
  return mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/javascript" ||
    mime === "text/javascript" ||
    mime === "image/svg+xml" ||
    mime.endsWith("+json") ||
    mime.endsWith("+xml");
}

function decodeInputFile(file: ArtifactInputFile, mime: string): Buffer {
  if (typeof file.content_base64 === "string") {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(file.content_base64.replace(/\s+/g, ""))) {
      throw new Error("content_base64 must be valid base64");
    }
    return Buffer.from(file.content_base64, "base64");
  }
  if (Buffer.isBuffer(file.content)) return file.content;
  if (typeof file.content === "string") {
    if (!isTextLikeMime(mime)) {
      throw new Error(`Binary MIME ${mime} requires content_base64 in JSON artifact APIs`);
    }
    return Buffer.from(file.content, "utf8");
  }
  throw new Error(`content or content_base64 is required for ${file.path || "index.html"}`);
}

function removeArtifactWorkspace(id: string): void {
  try {
    assertSafeArtifactId(id);
    fs.rmSync(path.join(getWorkspaceDir(), "artifacts", id), { recursive: true, force: true, maxRetries: 3 });
  } catch {}
}

export function gcArtifactStorage(db: Database.Database): void {
  const root = path.join(getWorkspaceDir(), "artifacts");
  let artifactDirs: string[];
  try { artifactDirs = fs.readdirSync(root); } catch { return; }
  const liveRows = db
    .prepare(`SELECT id FROM artifacts WHERE deleted_at IS NULL`)
    .all() as Array<{ id: string }>;
  const live = new Set(liveRows.map((r) => r.id));
  for (const id of artifactDirs) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || !live.has(id)) {
      try { fs.rmSync(path.join(root, id), { recursive: true, force: true, maxRetries: 3 }); } catch {}
      continue;
    }
    const versionRoot = path.join(root, id, "versions");
    let versionDirs: string[];
    try { versionDirs = fs.readdirSync(versionRoot); } catch { continue; }
    const referenced = db
      .prepare(
        `SELECT av.version
         FROM artifact_versions av
         WHERE av.artifact_id = ?
           AND EXISTS (SELECT 1 FROM artifact_files af WHERE af.artifact_version_id = av.id AND af.storage_kind = 'workspace')`,
      )
      .all(id) as Array<{ version: number }>;
    const keep = new Set(referenced.map((r) => String(r.version)));
    for (const v of versionDirs) {
      if (!keep.has(v)) {
        try { fs.rmSync(path.join(versionRoot, v), { recursive: true, force: true, maxRetries: 3 }); } catch {}
      }
    }
  }
}

function iconForMime(mime: string): string {
  if (mime === "application/pdf") return "PDF";
  if (mime.startsWith("image/")) return "IMG";
  if (mime.startsWith("video/")) return "VID";
  if (mime.startsWith("audio/")) return "AUD";
  if (mime === "text/markdown") return "MD";
  if (mime === "text/html") return "HTML";
  return "FILE";
}
