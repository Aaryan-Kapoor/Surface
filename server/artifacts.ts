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
  renderer: string | null;
  source_type: ArtifactSourceType;
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
  created_by: string | null;
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

export interface SurfaceCard {
  id: string;
  title: string;
  metadata: string;
  created_at: string;
  updated_at: string;
  artifact_id?: string;
  artifact_kind?: string;
  artifact_mime?: string | null;
  current_version_id?: string | null;
  first_file_path?: string | null;
  preview_url?: string;
  view_url?: string;
}

export interface ArtifactInputFile {
  path?: string;
  content: string | Buffer;
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

// Schema lives in server/migrations.ts (migration v1, baseline). New schema
// changes append a v2+ migration there.

export function inferMime(filePath: string, fallback = "application/octet-stream"): string {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] || fallback;
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
  db.prepare(`UPDATE surface_views SET updated_at = datetime('now') WHERE artifact_id = ?`).run(artifactId);
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

export function listArtifactCards(db: Database.Database): SurfaceCard[] {
  const artifactRows = db
    .prepare(
      `SELECT
        sv.id,
        sv.title,
        sv.metadata,
        sv.created_at,
        sv.updated_at,
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
        ) AS first_file_path
       FROM surface_views sv
       JOIN artifacts a ON a.id = sv.artifact_id
       WHERE a.deleted_at IS NULL
       ORDER BY sv.updated_at DESC`
    )
    .all() as SurfaceCard[];

  const legacyRows = db
    .prepare(
      `SELECT id, title, metadata, created_at, updated_at
       FROM surfaces
       WHERE id NOT IN (SELECT id FROM surface_views)
       ORDER BY updated_at DESC`
    )
    .all() as SurfaceCard[];

  return [...artifactRows, ...legacyRows].map((row) => ({
    ...row,
    preview_url: row.artifact_id ? `/artifacts/${row.artifact_id}/view?preview=1` : `/surfaces/${row.id}/html`,
    view_url: row.artifact_id ? `/artifacts/${row.artifact_id}/view` : `/surfaces/${row.id}/html`,
  }));
}

export function listArtifacts(db: Database.Database): Artifact[] {
  return db
    .prepare(`SELECT * FROM artifacts WHERE deleted_at IS NULL ORDER BY updated_at DESC`)
    .all() as Artifact[];
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
    renderer?: string;
    source_type?: ArtifactSourceType;
    metadata?: Record<string, unknown>;
    files: ArtifactInputFile[];
    reason?: string;
    created_by?: string;
    create_surface_view?: boolean;
  }
) {
  if (!params.title) throw new Error("title is required");
  if (!params.files.length) throw new Error("at least one file is required");

  const id = params.id || uuidv4();
  const firstPath = normalizeArtifactPath(params.files[0].path || "index.html");
  const mime = params.mime || params.files[0].mime || inferMime(firstPath);
  const kind = params.kind || (mime === "text/html" ? "html" : "file");
  const metadata = JSON.stringify(params.metadata || {});
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
      db.prepare(`DELETE FROM artifacts WHERE id = ?`).run(id);
    }
    db.prepare(
      `INSERT INTO artifacts (id, title, kind, mime, renderer, source_type, workspace_path, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      params.title,
      kind,
      mime,
      params.renderer || null,
      params.source_type || "generated",
      artifactWorkspace,
      metadata
    );
    const version = createArtifactVersion(db, id, params.files, {
      reason: params.reason,
      created_by: params.created_by,
      parent_version_id: null,
    });
    db.prepare(`UPDATE artifacts SET current_version_id = ?, updated_at = datetime('now') WHERE id = ?`).run(version.id, id);
    if (params.create_surface_view !== false) {
      db.prepare(
        `INSERT OR REPLACE INTO surface_views (id, artifact_id, title, metadata, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))`
      ).run(id, id, params.title, metadata);
    }
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
    renderer?: string | null;
    source_type?: ArtifactSourceType;
    metadata?: Record<string, unknown>;
    files?: ArtifactInputFile[];
    reason?: string;
    created_by?: string;
  }
) {
  const existing = getArtifact(db, id);
  if (!existing) return undefined;

  const currentVersion = getCurrentArtifactVersion(db, id);
  const tx = db.transaction(() => {
    if (params.files?.length) {
      const version = createArtifactVersion(db, id, params.files!, {
        reason: params.reason,
        created_by: params.created_by,
        parent_version_id: currentVersion?.id || null,
      });
      db.prepare(`UPDATE artifacts SET current_version_id = ? WHERE id = ?`).run(version.id, id);
    }
    const metadata = params.metadata !== undefined ? JSON.stringify(params.metadata) : existing.metadata;
    db.prepare(
      `UPDATE artifacts
       SET title = ?, kind = ?, mime = ?, renderer = ?, source_type = ?, metadata = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      params.title ?? existing.title,
      params.kind ?? existing.kind,
      params.mime ?? existing.mime,
      params.renderer === undefined ? existing.renderer : params.renderer,
      params.source_type ?? existing.source_type,
      metadata,
      id
    );
    db.prepare(
      `UPDATE surface_views SET title = ?, metadata = ?, updated_at = datetime('now') WHERE artifact_id = ?`
    ).run(params.title ?? existing.title, metadata, id);
  });
  tx();
  return readArtifact(db, id);
}

export function deleteArtifact(db: Database.Database, id: string): boolean {
  const result = db.prepare(`UPDATE artifacts SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL`).run(id);
  db.prepare(`DELETE FROM surface_views WHERE artifact_id = ?`).run(id);
  // Clear any pending user actions queued against this surface so they don't
  // accumulate forever or wake `surface wait` listeners after the surface
  // is gone.
  db.prepare(`DELETE FROM surface_actions WHERE surface_id = ?`).run(id);
  return result.changes > 0;
}

export function presentFile(
  db: Database.Database,
  params: {
    filePath: string;
    title?: string;
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
    metadata,
    files: [{ path: path.basename(resolved), content, mime }],
    reason: "present_file",
  });
}

export function readArtifactFileContent(file: ArtifactFile): Buffer {
  if (file.storage_kind === "external") {
    return fs.readFileSync(file.storage_path);
  }
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
  const metadataJson = JSON.stringify({
    icon: iconForMime(mime),
    description: `linked from ${absPath}`,
    original_path: absPath,
    linked: true,
    ...(params.metadata || {}),
  });

  const manifest = {
    artifact_id: artifactId,
    version: 1,
    linked: true,
    workspace_path: workspaceRoot,
    files: [{ path: entryRelPath, mime, size_bytes: data.length, sha256 }],
  };

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO artifacts (id, title, kind, mime, renderer, source_type, workspace_path, metadata, current_version_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(artifactId, params.title, kind, mime, null, "linked", workspaceRoot, metadataJson, versionId);

    db.prepare(
      `INSERT INTO artifact_versions (id, artifact_id, parent_version_id, version, reason, created_by, manifest_json, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(versionId, artifactId, null, 1, "link", null, JSON.stringify(manifest), sha256);

    db.prepare(
      `INSERT INTO artifact_files (id, artifact_version_id, path, mime, size_bytes, sha256, storage_kind, storage_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(fileId, versionId, entryRelPath, mime, data.length, sha256, "external", entryAbsPath);

    db.prepare(
      `INSERT OR REPLACE INTO surface_views (id, artifact_id, title, metadata, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))`
    ).run(artifactId, artifactId, params.title, metadataJson);
  });
  tx();

  return readArtifact(db, artifactId)!;
}

export function touchArtifact(db: Database.Database, id: string): boolean {
  const artifact = getArtifact(db, id);
  if (!artifact) return false;
  db.prepare(`UPDATE artifacts SET updated_at = datetime('now') WHERE id = ?`).run(id);
  db.prepare(`UPDATE surface_views SET updated_at = datetime('now') WHERE artifact_id = ?`).run(id);
  return true;
}

function createArtifactVersion(
  db: Database.Database,
  artifactId: string,
  inputFiles: ArtifactInputFile[],
  options: {
    parent_version_id: string | null;
    reason?: string;
    created_by?: string;
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
    const data = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content);
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
      mime: file.mime || inferMime(artifactPath),
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
    `INSERT INTO artifact_versions (id, artifact_id, parent_version_id, version, reason, created_by, manifest_json, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    versionId,
    artifactId,
    options.parent_version_id,
    nextVersion,
    options.reason || null,
    options.created_by || null,
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

function iconForMime(mime: string): string {
  if (mime === "application/pdf") return "PDF";
  if (mime.startsWith("image/")) return "IMG";
  if (mime.startsWith("video/")) return "VID";
  if (mime.startsWith("audio/")) return "AUD";
  if (mime === "text/markdown") return "MD";
  if (mime === "text/html") return "HTML";
  return "FILE";
}
