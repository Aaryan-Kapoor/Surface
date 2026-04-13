import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "surfaces.db");

let db: Database.Database;

export type SurfaceKind = "html" | "widgets";

export interface Surface {
  id: string;
  title: string;
  html: string;
  metadata: string;
  kind: SurfaceKind;
  spec: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface SurfaceListItem {
  id: string;
  title: string;
  metadata: string;
  kind: SurfaceKind;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface SurfaceRevision {
  id: number;
  surface_id: string;
  revision: number;
  title: string;
  html: string;
  spec: string | null;
  metadata: string;
  kind: SurfaceKind;
  edit_kind: string;
  edit_summary: string | null;
  created_at: string;
}

export function initDb(): void {
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS surfaces (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      html TEXT NOT NULL,
      metadata TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  migrateSurfacesSchema();
  initActionsTable();
  initDisplayConfigTable();
  initRevisionsTable();
}

// Additive, idempotent column migrations for the surfaces table.
function migrateSurfacesSchema(): void {
  const cols = db
    .prepare(`PRAGMA table_info(surfaces)`)
    .all() as Array<{ name: string }>;
  const has = (n: string) => cols.some((c) => c.name === n);
  if (!has("kind")) {
    db.exec(`ALTER TABLE surfaces ADD COLUMN kind TEXT NOT NULL DEFAULT 'html'`);
  }
  if (!has("spec")) {
    db.exec(`ALTER TABLE surfaces ADD COLUMN spec TEXT`);
  }
  if (!has("revision")) {
    db.exec(`ALTER TABLE surfaces ADD COLUMN revision INTEGER NOT NULL DEFAULT 1`);
  }
}

function initRevisionsTable(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS surface_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      surface_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      title TEXT NOT NULL,
      html TEXT NOT NULL,
      spec TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      kind TEXT NOT NULL DEFAULT 'html',
      edit_kind TEXT NOT NULL DEFAULT 'update',
      edit_summary TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (surface_id) REFERENCES surfaces(id) ON DELETE CASCADE,
      UNIQUE(surface_id, revision)
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_revisions_surface ON surface_revisions(surface_id, revision DESC)`
  );
}

function writeRevision(
  surface: Surface,
  edit_kind: string,
  edit_summary: string | null
): void {
  db.prepare(
    `INSERT INTO surface_revisions
       (surface_id, revision, title, html, spec, metadata, kind, edit_kind, edit_summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    surface.id,
    surface.revision,
    surface.title,
    surface.html,
    surface.spec,
    surface.metadata,
    surface.kind,
    edit_kind,
    edit_summary
  );
}

export function listRevisions(surfaceId: string, limit = 50): SurfaceRevision[] {
  return db
    .prepare(
      `SELECT * FROM surface_revisions WHERE surface_id = ? ORDER BY revision DESC LIMIT ?`
    )
    .all(surfaceId, limit) as SurfaceRevision[];
}

export function getRevision(
  surfaceId: string,
  revision: number
): SurfaceRevision | undefined {
  return db
    .prepare(
      `SELECT * FROM surface_revisions WHERE surface_id = ? AND revision = ?`
    )
    .get(surfaceId, revision) as SurfaceRevision | undefined;
}

export function createSurface(params: {
  id?: string;
  title: string;
  html: string;
  metadata?: Record<string, unknown>;
  kind?: SurfaceKind;
  spec?: Record<string, unknown> | null;
}): Surface {
  const id = params.id || uuidv4();
  const metadata = JSON.stringify(params.metadata || {});
  const kind: SurfaceKind = params.kind || "html";
  const spec = params.spec ? JSON.stringify(params.spec) : null;
  db.prepare(
    `INSERT INTO surfaces (id, title, html, metadata, kind, spec, revision)
     VALUES (?, ?, ?, ?, ?, ?, 1)`
  ).run(id, params.title, params.html, metadata, kind, spec);
  const surface = getSurface(id)!;
  writeRevision(surface, "create", null);
  return surface;
}

export function getSurface(id: string): Surface | undefined {
  return db.prepare(`SELECT * FROM surfaces WHERE id = ?`).get(id) as
    | Surface
    | undefined;
}

export function listSurfaces(): SurfaceListItem[] {
  return db
    .prepare(
      `SELECT id, title, metadata, kind, revision, created_at, updated_at
         FROM surfaces ORDER BY updated_at DESC`
    )
    .all() as SurfaceListItem[];
}

export function updateSurface(
  id: string,
  params: {
    title?: string;
    html?: string;
    metadata?: Record<string, unknown>;
    kind?: SurfaceKind;
    spec?: Record<string, unknown> | null;
  },
  opts: { edit_kind?: string; edit_summary?: string | null } = {}
): Surface | undefined {
  const existing = getSurface(id);
  if (!existing) return undefined;

  const title = params.title ?? existing.title;
  const html = params.html ?? existing.html;
  const metadata =
    params.metadata !== undefined
      ? JSON.stringify(params.metadata)
      : existing.metadata;
  const kind = params.kind ?? existing.kind;
  const spec =
    params.spec === undefined
      ? existing.spec
      : params.spec === null
      ? null
      : JSON.stringify(params.spec);
  const nextRev = existing.revision + 1;

  db.prepare(
    `UPDATE surfaces
       SET title = ?, html = ?, metadata = ?, kind = ?, spec = ?,
           revision = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(title, html, metadata, kind, spec, nextRev, id);

  const updated = getSurface(id)!;
  writeRevision(updated, opts.edit_kind || "update", opts.edit_summary ?? null);
  return updated;
}

export function deleteSurface(id: string): boolean {
  const result = db.prepare(`DELETE FROM surfaces WHERE id = ?`).run(id);
  return result.changes > 0;
}

// ── Actions (surface → agent) ──

export interface SurfaceAction {
  id: string;
  surface_id: string;
  action: string;
  data: string;
  status: string;
  created_at: string;
}

export function initActionsTable(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS surface_actions (
      id TEXT PRIMARY KEY,
      surface_id TEXT NOT NULL,
      action TEXT NOT NULL,
      data TEXT DEFAULT '{}',
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (surface_id) REFERENCES surfaces(id) ON DELETE CASCADE
    )
  `);
}

export function createAction(params: {
  surface_id: string;
  action: string;
  data?: Record<string, unknown>;
}): SurfaceAction {
  const id = uuidv4();
  const data = JSON.stringify(params.data || {});
  db.prepare(
    `INSERT INTO surface_actions (id, surface_id, action, data) VALUES (?, ?, ?, ?)`
  ).run(id, params.surface_id, params.action, data);
  return db.prepare(`SELECT * FROM surface_actions WHERE id = ?`).get(id) as SurfaceAction;
}

export function getPendingActions(surfaceId?: string): SurfaceAction[] {
  if (surfaceId) {
    return db
      .prepare(`SELECT * FROM surface_actions WHERE surface_id = ? AND status = 'pending' ORDER BY created_at ASC`)
      .all(surfaceId) as SurfaceAction[];
  }
  return db
    .prepare(`SELECT * FROM surface_actions WHERE status = 'pending' ORDER BY created_at ASC`)
    .all() as SurfaceAction[];
}

export function ackAction(id: string): boolean {
  const result = db.prepare(
    `UPDATE surface_actions SET status = 'handled' WHERE id = ?`
  ).run(id);
  return result.changes > 0;
}

// ── Display Config ──

export function initDisplayConfigTable(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS display_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
}

export function getDisplayConfig(): Record<string, any> {
  const row = db.prepare(`SELECT value FROM display_config WHERE key = 'theme'`).get() as { value: string } | undefined;
  if (!row) return {};
  try { return JSON.parse(row.value); } catch { return {}; }
}

export function resetDisplayConfig(): void {
  db.prepare(`DELETE FROM display_config WHERE key = 'theme'`).run();
}

export function setDisplayConfig(config: Record<string, any>): Record<string, any> {
  const existing = getDisplayConfig();
  const merged = { ...existing, ...config };
  db.prepare(`INSERT OR REPLACE INTO display_config (key, value) VALUES ('theme', ?)`).run(JSON.stringify(merged));
  return merged;
}
