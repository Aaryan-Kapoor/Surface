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

// Reserve a headless Codex batch durably before sending turn/start. Leased
// actions disappear from the ordinary pending inbox so no second consumer can
// claim them, but can be restored after any uncertain delivery outcome.
export function leaseCodexActions(
  db: Database.Database,
  surfaceId: string,
  threadId: string,
  actionIds: string[],
): string[] {
  return db.transaction(() => {
    const leased: string[] = [];
    const reserve = db.prepare(
      `UPDATE surface_actions SET status = 'delivering', handled_at = NULL
       WHERE id = ? AND surface_id = ? AND status = 'pending'`,
    );
    const record = db.prepare(
      `INSERT INTO codex_action_deliveries (action_id, surface_id, thread_id) VALUES (?, ?, ?)`,
    );
    for (const id of actionIds) {
      if (reserve.run(id, surfaceId).changes === 0) continue;
      record.run(id, surfaceId, threadId);
      leased.push(id);
    }
    return leased;
  })();
}

export function setCodexDeliveryTurn(db: Database.Database, actionIds: string[], turnId: string): void {
  const update = db.prepare(`UPDATE codex_action_deliveries SET turn_id = ? WHERE action_id = ?`);
  db.transaction(() => {
    for (const id of actionIds) update.run(turnId, id);
  })();
}

export function completeCodexActions(db: Database.Database, actionIds: string[]): void {
  const complete = db.prepare(
    `UPDATE surface_actions SET status = 'handled', handled_at = datetime('now')
     WHERE id = ? AND status = 'delivering'`,
  );
  const remove = db.prepare(`DELETE FROM codex_action_deliveries WHERE action_id = ?`);
  db.transaction(() => {
    for (const id of actionIds) {
      complete.run(id);
      remove.run(id);
    }
  })();
}

export function restoreCodexActions(db: Database.Database, actionIds: string[]): void {
  const restore = db.prepare(
    `UPDATE surface_actions SET status = 'pending', handled_at = NULL
     WHERE id = ? AND status = 'delivering'`,
  );
  const remove = db.prepare(`DELETE FROM codex_action_deliveries WHERE action_id = ?`);
  db.transaction(() => {
    for (const id of actionIds) {
      restore.run(id);
      remove.run(id);
    }
  })();
}

// A previous process cannot know whether its headless turn completed after it
// disconnected. Prefer at-least-once delivery over silently losing the click.
export function recoverCodexActions(db: Database.Database): number {
  return db.transaction(() => {
    const rows = db.prepare(`SELECT action_id FROM codex_action_deliveries`).all() as Array<{ action_id: string }>;
    const restore = db.prepare(
      `UPDATE surface_actions SET status = 'pending', handled_at = NULL
       WHERE id = ? AND status = 'delivering'`,
    );
    for (const row of rows) restore.run(row.action_id);
    db.prepare(`DELETE FROM codex_action_deliveries`).run();
    return rows.length;
  })();
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
