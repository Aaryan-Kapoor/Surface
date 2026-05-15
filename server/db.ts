import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import { deleteArtifact, ensureArtifactTables } from "./artifacts.js";
import { bootstrapDataDir, getDbPath } from "./paths.js";
import { runMigrations } from "./migrations.js";

let db: Database.Database;

// The legacy `surfaces` table is now read-only fallback. `getSurface` and
// `deleteSurface` below are still used to migrate / clean up rows created
// before the artifact model existed.
export interface Surface {
  id: string;
  title: string;
  html: string;
  metadata: string;
  created_at: string;
  updated_at: string;
}

export function initDb(): void {
  bootstrapDataDir();
  db = new Database(getDbPath());
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
  ensureArtifactTables(db);
  initActionsTable();
  initDisplayConfigTable();
  runMigrations(db);
}

export function getDb(): Database.Database {
  if (!db) throw new Error("Database has not been initialized");
  return db;
}

export function getSurface(id: string): Surface | undefined {
  return db.prepare(`SELECT * FROM surfaces WHERE id = ?`).get(id) as
    | Surface
    | undefined;
}

export function deleteSurface(id: string): boolean {
  const result = db.prepare(`DELETE FROM surfaces WHERE id = ?`).run(id);
  if (result.changes > 0) deleteArtifact(db, id);
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
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  const foreignKeys = db.prepare(`PRAGMA foreign_key_list(surface_actions)`).all() as Array<{ table: string }>;
  if (foreignKeys.some((key) => key.table === "surfaces")) {
    db.exec(`
      ALTER TABLE surface_actions RENAME TO surface_actions_old;
      CREATE TABLE surface_actions (
        id TEXT PRIMARY KEY,
        surface_id TEXT NOT NULL,
        action TEXT NOT NULL,
        data TEXT DEFAULT '{}',
        status TEXT DEFAULT 'pending',
        created_at TEXT DEFAULT (datetime('now'))
      );
      INSERT INTO surface_actions (id, surface_id, action, data, status, created_at)
        SELECT id, surface_id, action, data, status, created_at FROM surface_actions_old;
      DROP TABLE surface_actions_old;
    `);
  }
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
