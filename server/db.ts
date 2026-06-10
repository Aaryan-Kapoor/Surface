import Database from "better-sqlite3";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import { bootstrapDataDir, getDbPath } from "./paths.js";
import { isPreBaseline, runMigrations } from "./migrations.js";

let db: Database.Database;

// Fresh-start policy (decided 2026-06): a pre-baseline database is archived to
// db.sqlite.bak (plus -wal/-shm), never row-migrated. Agents re-link or
// re-create their surfaces against the clean schema.
function archivePreBaselineDb(): void {
  const dbPath = getDbPath();
  let suffix = "";
  let n = 0;
  while (fs.existsSync(`${dbPath}.bak${suffix}`)) {
    n++;
    suffix = `.${n}`;
  }
  console.log(`[surface] pre-baseline database found; archiving to ${dbPath}.bak${suffix}`);
  fs.renameSync(dbPath, `${dbPath}.bak${suffix}`);
  for (const ext of ["-wal", "-shm"]) {
    if (fs.existsSync(dbPath + ext)) fs.renameSync(dbPath + ext, `${dbPath}.bak${suffix}${ext}`);
  }
}

export function initDb(): void {
  bootstrapDataDir();
  db = new Database(getDbPath());
  if (isPreBaseline(db)) {
    db.close();
    archivePreBaselineDb();
    db = new Database(getDbPath());
  }
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
}

export function getDb(): Database.Database {
  if (!db) throw new Error("Database has not been initialized");
  return db;
}

// ── Actions (surface → agent) ──

export interface SurfaceAction {
  id: string;
  surface_id: string;
  action: string;
  data: string;
  status: string;
  created_at: string;
  handled_at: string | null;
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
    `UPDATE surface_actions SET status = 'handled', handled_at = datetime('now') WHERE id = ? AND status = 'pending'`
  ).run(id);
  return result.changes > 0;
}

// ── Display Config ──

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
