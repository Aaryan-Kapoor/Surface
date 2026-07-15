import type Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";

export interface SurfaceAction {
  id: string;
  surface_id: string;
  action: string;
  data: string;
  status: string;
  created_at: string;
  handled_at: string | null;
}

export function createAction(
  db: Database.Database,
  params: {
    surface_id: string;
    action: string;
    data?: unknown;
  },
): SurfaceAction {
  const id = uuidv4();
  const data = JSON.stringify(params.data || {});
  db.prepare(
    `INSERT INTO surface_actions (id, surface_id, action, data) VALUES (?, ?, ?, ?)`,
  ).run(id, params.surface_id, params.action, data);
  return db.prepare(`SELECT * FROM surface_actions WHERE id = ?`).get(id) as SurfaceAction;
}

export function getAction(db: Database.Database, id: string): SurfaceAction | undefined {
  return db.prepare(`SELECT * FROM surface_actions WHERE id = ?`).get(id) as SurfaceAction | undefined;
}

export function getPendingActions(db: Database.Database, surfaceId?: string): SurfaceAction[] {
  if (surfaceId) {
    return db
      .prepare(`SELECT * FROM surface_actions WHERE surface_id = ? AND status = 'pending' ORDER BY created_at ASC`)
      .all(surfaceId) as SurfaceAction[];
  }
  return db
    .prepare(`SELECT * FROM surface_actions WHERE status = 'pending' ORDER BY created_at ASC`)
    .all() as SurfaceAction[];
}

export function ackAction(db: Database.Database, id: string): boolean {
  const result = db.prepare(
    `UPDATE surface_actions SET status = 'handled', handled_at = datetime('now') WHERE id = ? AND status = 'pending'`,
  ).run(id);
  return result.changes > 0;
}

// Return a delivered action to the inbox — used when delivery was optimistic
// and the handling turn demonstrably failed (codex bridge, failed wake turn).
export function unackAction(db: Database.Database, id: string): boolean {
  const result = db.prepare(
    `UPDATE surface_actions SET status = 'pending', handled_at = NULL WHERE id = ? AND status = 'handled'`,
  ).run(id);
  return result.changes > 0;
}

export function cleanupActions(db: Database.Database): { handled: number; pending: number } {
  const handled = db.prepare(
    `DELETE FROM surface_actions WHERE status = 'handled' AND handled_at < datetime('now', '-7 days')`,
  ).run().changes;
  const pending = db.prepare(
    `DELETE FROM surface_actions WHERE status = 'pending' AND created_at < datetime('now', '-30 days')`,
  ).run().changes;
  return { handled, pending };
}
