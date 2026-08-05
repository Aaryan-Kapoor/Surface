// The notification log.
//
// A notification is the agent talking to the human outside any one surface —
// "the build finished", "should I deploy this?". It used to be a pure SSE
// frame, which meant it existed only for whoever happened to be looking. That
// is fine for "build finished" and wrong for anything with a button on it: an
// unanswered question has to survive a reload, a restart, and the agent that
// asked it going away, exactly as a click does (docs/interaction/delivery-ladder.md).
//
// Answering is deliberately NOT implemented here. Pressing a button records a
// normal surface action through the normal store; this table only remembers
// that the question was asked and that it has since been answered. One inbox,
// one claim model, one set of rules.
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export interface NotificationAction {
  label: string;
  action: string;
  data?: unknown;
}

export interface NotificationRow {
  id: string;
  text: string;
  style: string;
  surface_id: string | null;
  device: string | null;
  actions: NotificationAction[];
  sticky: boolean;
  created_at: string;
  seen_at: string | null;
  answered_at: string | null;
  answer: string | null;
  dismissed_at: string | null;
}

// The log is a convenience, not an archive. Two hundred is far more than a
// person will scroll and small enough that the tray query stays trivial.
const KEEP_ROWS = 200;

interface DbRow {
  id: string;
  text: string;
  style: string;
  surface_id: string | null;
  device: string | null;
  actions_json: string;
  sticky: number;
  created_at: string;
  seen_at: string | null;
  answered_at: string | null;
  answer: string | null;
  dismissed_at: string | null;
}

function hydrate(row: DbRow): NotificationRow {
  let actions: NotificationAction[] = [];
  try {
    const parsed = JSON.parse(row.actions_json || "[]");
    if (Array.isArray(parsed)) actions = parsed;
  } catch { /* a malformed row still deserves to render its text */ }
  return {
    id: row.id,
    text: row.text,
    style: row.style,
    surface_id: row.surface_id,
    device: row.device,
    actions,
    sticky: !!row.sticky,
    created_at: row.created_at,
    seen_at: row.seen_at,
    answered_at: row.answered_at,
    answer: row.answer,
    dismissed_at: row.dismissed_at,
  };
}

export function recordNotification(
  db: Database.Database,
  input: {
    text: string;
    style?: string;
    surface_id?: string | null;
    device?: string | null;
    actions?: NotificationAction[];
    sticky?: boolean;
  },
): NotificationRow {
  const id = randomUUID();
  const actions = input.actions ?? [];
  db.prepare(`
    INSERT INTO notifications (id, text, style, surface_id, device, actions_json, sticky)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.text,
    input.style || "info",
    input.surface_id ?? null,
    input.device ?? null,
    JSON.stringify(actions),
    input.sticky ? 1 : 0,
  );
  gcNotifications(db);
  return getNotification(db, id)!;
}

export function getNotification(db: Database.Database, id: string): NotificationRow | null {
  const row = db.prepare(`SELECT * FROM notifications WHERE id = ?`).get(id) as DbRow | undefined;
  return row ? hydrate(row) : null;
}

/**
 * Who a stored notification belongs to.
 *
 * `--on <device>` already scopes the live toast. The row has to be scoped the
 * same way or that targeting is decoration: any other display could reload,
 * find the question sitting in its tray, read it, and answer it. A row with no
 * device belongs to everyone. A `null` viewer is the system plane, which reads
 * the whole log — an agent listing notifications is doing bookkeeping, not
 * peering at someone else's screen.
 */
export type Viewer = string | null;

function deviceScope(viewer: Viewer): { sql: string; params: string[] } {
  if (viewer === null) return { sql: "", params: [] };
  return { sql: " AND (device IS NULL OR device = ?)", params: [viewer] };
}

/** Whether `viewer` is allowed to act on a row it names by id. */
export function visibleTo(row: NotificationRow, viewer: Viewer): boolean {
  return viewer === null || row.device === null || row.device === viewer;
}

export function listNotifications(db: Database.Database, viewer: Viewer, limit = 50): NotificationRow[] {
  const scope = deviceScope(viewer);
  const rows = db.prepare(`
    SELECT * FROM notifications
    WHERE dismissed_at IS NULL${scope.sql}
    ORDER BY created_at DESC, rowid DESC
    LIMIT ?
  `).all(...scope.params, Math.max(1, Math.min(200, limit))) as DbRow[];
  return rows.map(hydrate);
}

/**
 * What the badge counts: anything you have not looked at, plus anything still
 * waiting on you. A question you *have* seen but not answered keeps counting —
 * seeing a question is not answering it.
 *
 * Scoped per viewer, which is why no broadcast carries this number: one count
 * is not true of two devices at once.
 */
export function unreadCount(db: Database.Database, viewer: Viewer): number {
  const scope = deviceScope(viewer);
  const row = db.prepare(`
    SELECT count(*) AS n FROM notifications
    WHERE dismissed_at IS NULL${scope.sql}
      AND (
        seen_at IS NULL
        OR (actions_json <> '[]' AND answered_at IS NULL)
      )
  `).get(...scope.params) as { n: number };
  return row.n;
}

export function markAllSeen(db: Database.Database, viewer: Viewer): number {
  const scope = deviceScope(viewer);
  return db.prepare(`
    UPDATE notifications SET seen_at = datetime('now')
    WHERE seen_at IS NULL AND dismissed_at IS NULL${scope.sql}
  `).run(...scope.params).changes;
}

export function markAnswered(db: Database.Database, id: string, answer: string): NotificationRow | null {
  db.prepare(`
    UPDATE notifications SET answered_at = datetime('now'), answer = ?, seen_at = COALESCE(seen_at, datetime('now'))
    WHERE id = ? AND answered_at IS NULL
  `).run(answer, id);
  return getNotification(db, id);
}

/**
 * A question can be answered somewhere other than its own button.
 *
 * The tour asks "ready for the next one?" in a notification while the same
 * `next` sits on the page itself — press the one on the page and the tray was
 * left holding a question the user had already answered, counted forever by the
 * unread badge. Any action on a surface resolves every open question that
 * offered that action against that surface. One decision, one answer.
 */
export function resolveMatchingNotifications(
  db: Database.Database,
  surfaceId: string,
  action: string,
): NotificationRow[] {
  const rows = db.prepare(`
    SELECT * FROM notifications
    WHERE surface_id = ? AND answered_at IS NULL AND dismissed_at IS NULL
      AND actions_json <> '[]'
  `).all(surfaceId) as DbRow[];
  const resolved: NotificationRow[] = [];
  for (const row of rows) {
    const notification = hydrate(row);
    if (!notification.actions.some((entry) => entry.action === action)) continue;
    const updated = markAnswered(db, notification.id, action);
    if (updated) resolved.push(updated);
  }
  return resolved;
}

export function dismissNotification(db: Database.Database, id: string): boolean {
  return db.prepare(`
    UPDATE notifications SET dismissed_at = datetime('now')
    WHERE id = ? AND dismissed_at IS NULL
  `).run(id).changes > 0;
}

export function dismissAllNotifications(db: Database.Database, viewer: Viewer): number {
  // An unanswered question is not clutter, so "clear all" leaves it alone —
  // otherwise the one thing the tray exists for is the easiest thing to lose.
  const scope = deviceScope(viewer);
  return db.prepare(`
    UPDATE notifications SET dismissed_at = datetime('now')
    WHERE dismissed_at IS NULL${scope.sql}
      AND (actions_json = '[]' OR answered_at IS NOT NULL)
  `).run(...scope.params).changes;
}

export function gcNotifications(db: Database.Database, keep = KEEP_ROWS): number {
  return db.prepare(`
    DELETE FROM notifications
    WHERE id NOT IN (
      SELECT id FROM notifications ORDER BY created_at DESC, rowid DESC LIMIT ?
    )
  `).run(keep).changes;
}
