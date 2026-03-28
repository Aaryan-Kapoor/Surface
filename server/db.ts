import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "surfaces.db");

let db: Database.Database;

export interface Surface {
  id: string;
  title: string;
  html: string;
  metadata: string;
  created_at: string;
  updated_at: string;
}

export interface SurfaceListItem {
  id: string;
  title: string;
  metadata: string;
  created_at: string;
  updated_at: string;
}

export function initDb(): void {
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
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
  initActionsTable();
  initDisplayConfigTable();
}

export function createSurface(params: {
  id?: string;
  title: string;
  html: string;
  metadata?: Record<string, unknown>;
}): Surface {
  const id = params.id || uuidv4();
  const metadata = JSON.stringify(params.metadata || {});
  db.prepare(
    `INSERT INTO surfaces (id, title, html, metadata) VALUES (?, ?, ?, ?)`
  ).run(id, params.title, params.html, metadata);
  return getSurface(id)!;
}

export function getSurface(id: string): Surface | undefined {
  return db.prepare(`SELECT * FROM surfaces WHERE id = ?`).get(id) as
    | Surface
    | undefined;
}

export function listSurfaces(): SurfaceListItem[] {
  return db
    .prepare(
      `SELECT id, title, metadata, created_at, updated_at FROM surfaces ORDER BY updated_at DESC`
    )
    .all() as SurfaceListItem[];
}

export function updateSurface(
  id: string,
  params: {
    title?: string;
    html?: string;
    metadata?: Record<string, unknown>;
  }
): Surface | undefined {
  const existing = getSurface(id);
  if (!existing) return undefined;

  const title = params.title ?? existing.title;
  const html = params.html ?? existing.html;
  const metadata =
    params.metadata !== undefined
      ? JSON.stringify(params.metadata)
      : existing.metadata;

  db.prepare(
    `UPDATE surfaces SET title = ?, html = ?, metadata = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(title, html, metadata, id);

  return getSurface(id)!;
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
