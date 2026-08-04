import type Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";

// A user action is a work item, not a notification (docs/interaction/delivery-ladder.md).
// `surface_action` is broadcast to every SSE client — correct, it is how every
// screen and observer stays current — but exactly one handler may *take* it.
// That exclusivity is decided here, in SQLite, because the database is the only
// authority that survives a restart and can settle a race between two processes
// atomically. Route handlers, SSE code, and bindings must not issue ad hoc
// action-status SQL; every transition lives in this module.
//
//   pending ──claim(waiter)──► claimed ──complete──► handled
//                                  ├───deadline────► pending
//                                  └───disconnect──► pending
//   pending ──claim(binding)─► claimed ──complete──► handled
//                                  └───failed──────► pending
//
// What "handled" means: Surface handed the action to one claimed delivery
// channel — a waiter's flushed stdout line, a bound command's clean exit, a
// webhook's 2xx. It is NOT a claim that an LLM finished the real work, which
// Surface cannot observe. The waiter deadline below covers only the handoff.

// The waiter handoff budget: claim response, JSON serialization, stdout flush,
// and the completing ack. Deliberately NOT a work lease — it is never renewed,
// and a CLI that cannot hand over a line within it is not a healthy delivery
// channel.
export const WAITER_CLAIM_DEADLINE_SECONDS = 30;

export interface SurfaceAction {
  id: string;
  surface_id: string;
  action: string;
  data: string;
  status: "pending" | "claimed" | "handled" | string;
  created_at: string;
  handled_at: string | null;
  claimed_at: string | null;
  claim_deadline_at: string | null;
  claim_token: string | null;
  claim_owner_kind: string | null;
  claim_owner_id: string | null;
}

export type ClaimFailure =
  | "action_not_found"
  | "already_claimed"
  | "already_handled"
  | "claim_expired"
  | "token_in_use";

export type ClaimResult =
  | { ok: true; action: SurfaceAction; replayed: boolean }
  | { ok: false; reason: ClaimFailure; action?: SurfaceAction };

export type CompleteResult =
  | { ok: true; action: SurfaceAction; replayed: boolean }
  | { ok: false; reason: "action_not_found" | "claim_lost"; action?: SurfaceAction };

export interface BindingClaim {
  actionId: string;
  token: string;
  action: SurfaceAction;
}

export function newClaimToken(): string {
  return uuidv4();
}

export function createAction(
  db: Database.Database,
  params: { surface_id: string; action: string; data?: unknown },
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

// Deliverable actions only. `claimed` rows belong to a handler that is mid-handoff
// or mid-run and must never be offered to a second one.
export function getPendingActions(
  db: Database.Database,
  surfaceId?: string,
  opts: { projectRoot?: string } = {},
): SurfaceAction[] {
  const where: string[] = ["sa.status = 'pending'"];
  const params: unknown[] = [];
  if (surfaceId) {
    where.push("sa.surface_id = ?");
    params.push(surfaceId);
  }
  // Project scoping: a waiter armed in one repo must not drain another repo's
  // clicks. Actions on surfaces with no project_root (the auto-created global
  // board) are excluded from project-scoped reads by design — they belong to no
  // repo, so they wait for an explicit --id or --all waiter.
  if (opts.projectRoot) {
    where.push("a.project_root = ?");
    params.push(opts.projectRoot);
  }
  return db
    .prepare(
      `SELECT sa.* FROM surface_actions sa
       JOIN artifacts a ON a.id = sa.surface_id
       WHERE ${where.join(" AND ")}
       ORDER BY sa.created_at ASC`,
    )
    .all(...params) as SurfaceAction[];
}

// What the user is still waiting on: pending plus in-flight claims. Drives the
// card badge — a click is not done just because someone picked it up.
export function getUnresolvedActionCount(db: Database.Database, surfaceId: string): number {
  const row = db
    .prepare(
      `SELECT count(*) AS n FROM surface_actions
       WHERE surface_id = ? AND status IN ('pending', 'claimed')`,
    )
    .get(surfaceId) as { n: number };
  return row.n;
}

function clearClaimSql(): string {
  return `claimed_at = NULL, claim_deadline_at = NULL, claim_token = NULL,
          claim_owner_kind = NULL, claim_owner_id = NULL`;
}

// One waiter takes one action for delivery. `token` is per action attempt (never
// per process): retrying the same attempt after an ambiguous network result is
// idempotent and returns `replayed: true` without extending the deadline, so a
// lost response cannot strand an action the caller actually won.
export function claimActionForWaiter(
  db: Database.Database,
  params: { actionId: string; token: string; clientId: string; deadlineSeconds?: number },
): ClaimResult {
  const deadline = params.deadlineSeconds ?? WAITER_CLAIM_DEADLINE_SECONDS;
  const take = db.prepare(
    `UPDATE surface_actions
     SET status = 'claimed',
         claimed_at = datetime('now'),
         claim_deadline_at = datetime('now', '+' || ? || ' seconds'),
         claim_token = ?, claim_owner_kind = 'waiter', claim_owner_id = ?
     WHERE id = ? AND status = 'pending'`,
  );

  return db.transaction((): ClaimResult => {
    const existing = getAction(db, params.actionId);
    if (!existing) return { ok: false, reason: "action_not_found" };

    // Replay of our own live claim — same token, still owned.
    if (existing.claim_token === params.token) {
      if (existing.status === "claimed") return { ok: true, action: existing, replayed: true };
      if (existing.status === "handled") return { ok: false, reason: "already_handled", action: existing };
      // Row went back to pending under this token: the deadline elapsed. Refuse
      // rather than silently re-taking, so the CLI never prints a line for a
      // claim the server already gave up on.
      return { ok: false, reason: "claim_expired", action: existing };
    }

    // A token is one action's attempt, and v14 enforces that with a UNIQUE
    // index. Reusing one across two actions is a caller bug — but letting the
    // constraint fire raises a 500, which reads as "the server broke, retry",
    // and the retry fails identically forever. Name it instead. Expired claims
    // deliberately keep their token, so a retained one counts as in use: the
    // index would reject it just the same.
    const tokenOwner = db
      .prepare(`SELECT id FROM surface_actions WHERE claim_token = ?`)
      .get(params.token) as { id: string } | undefined;
    if (tokenOwner && tokenOwner.id !== params.actionId) {
      return { ok: false, reason: "token_in_use", action: existing };
    }

    if (take.run(String(deadline), params.token, params.clientId, params.actionId).changes > 0) {
      return { ok: true, action: getAction(db, params.actionId)!, replayed: false };
    }

    const current = getAction(db, params.actionId)!;
    return {
      ok: false,
      reason: current.status === "handled" ? "already_handled" : "already_claimed",
      action: current,
    };
  })();
}

// The handoff succeeded: this claim becomes the completed delivery.
export function completeClaim(
  db: Database.Database,
  params: { actionId: string; token: string },
): CompleteResult {
  return db.transaction((): CompleteResult => {
    const existing = getAction(db, params.actionId);
    if (!existing) return { ok: false, reason: "action_not_found" };
    if (existing.claim_token === params.token && existing.status === "handled") {
      return { ok: true, action: existing, replayed: true }; // idempotent retry
    }
    const done = db.prepare(
      `UPDATE surface_actions SET status = 'handled', handled_at = datetime('now')
       WHERE id = ? AND status = 'claimed' AND claim_token = ?`,
    ).run(params.actionId, params.token).changes > 0;
    if (!done) return { ok: false, reason: "claim_lost", action: getAction(db, params.actionId)! };
    return { ok: true, action: getAction(db, params.actionId)!, replayed: false };
  })();
}

// A binding takes the actions IT is registered for — not every pending action on
// the surface, which would swallow clicks belonging to a different binding.
// `actionNames` undefined means the binding's pattern is "*".
export function claimActionsForBinding(
  db: Database.Database,
  params: { surfaceId: string; actionNames?: string[]; actionIds?: string[]; bindingRunId: string },
): BindingClaim[] {
  const take = db.prepare(
    `UPDATE surface_actions
     SET status = 'claimed', claimed_at = datetime('now'), claim_deadline_at = NULL,
         claim_token = ?, claim_owner_kind = 'binding', claim_owner_id = ?
     WHERE id = ? AND status = 'pending'`,
  );
  return db.transaction((): BindingClaim[] => {
    const candidates = getPendingActions(db, params.surfaceId).filter(
      (a) => (!params.actionNames || params.actionNames.includes(a.action)) &&
        // An explicit id list is the caller's eligibility decision (e.g. an
        // action whose own waiter grace has not elapsed yet must not be swept
        // into an older action's batch).
        (!params.actionIds || params.actionIds.includes(a.id)),
    );
    const claims: BindingClaim[] = [];
    for (const candidate of candidates) {
      const token = uuidv4();
      if (take.run(token, params.bindingRunId, candidate.id).changes > 0) {
        claims.push({ actionId: candidate.id, token, action: getAction(db, candidate.id)! });
      }
    }
    return claims;
  })();
}

export function completeBindingClaims(
  db: Database.Database,
  claims: Array<{ actionId: string; token: string }>,
): number {
  const done = db.prepare(
    `UPDATE surface_actions SET status = 'handled', handled_at = datetime('now')
     WHERE id = ? AND status = 'claimed' AND claim_token = ?`,
  );
  return db.transaction(() => {
    let n = 0;
    for (const c of claims) n += done.run(c.actionId, c.token).changes;
    return n;
  })();
}

// The work did not happen, so the action goes back on the queue rather than
// being silently consumed. Fenced on the token: a run only ever releases rows it
// still owns.
export function releaseBindingClaims(
  db: Database.Database,
  claims: Array<{ actionId: string; token: string }>,
): SurfaceAction[] {
  const release = db.prepare(
    `UPDATE surface_actions SET status = 'pending', ${clearClaimSql()}
     WHERE id = ? AND status = 'claimed' AND claim_token = ?`,
  );
  return db.transaction(() => {
    const released: SurfaceAction[] = [];
    for (const c of claims) {
      if (release.run(c.actionId, c.token).changes > 0) released.push(getAction(db, c.actionId)!);
    }
    return released;
  })();
}

// A waiter's connection dropped: anything it claimed but never handed over goes
// back immediately, rather than waiting out the deadline.
export function releaseClaimsByOwner(
  db: Database.Database,
  params: { ownerKind: "waiter" | "binding"; ownerId: string },
): SurfaceAction[] {
  return db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT * FROM surface_actions
         WHERE status = 'claimed' AND claim_owner_kind = ? AND claim_owner_id = ?`,
      )
      .all(params.ownerKind, params.ownerId) as SurfaceAction[];
    const release = db.prepare(
      `UPDATE surface_actions SET status = 'pending', ${clearClaimSql()} WHERE id = ?`,
    );
    const released: SurfaceAction[] = [];
    for (const row of rows) {
      if (release.run(row.id).changes > 0) released.push(getAction(db, row.id)!);
    }
    return released;
  })();
}

// A waiter claimed but never completed the handoff — wedged CLI, dead harness, a
// connection that stayed open while nothing was reading it. Connection close
// usually gets there first; this is the backstop.
export function releaseExpiredWaiterClaims(db: Database.Database): SurfaceAction[] {
  return db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT * FROM surface_actions
         WHERE status = 'claimed' AND claim_owner_kind = 'waiter'
           AND claim_deadline_at IS NOT NULL AND claim_deadline_at < datetime('now')`,
      )
      .all() as SurfaceAction[];
    // Keep the token so a late completeClaim can be told `claim_expired` rather
    // than silently succeeding against a row someone else may now own.
    const release = db.prepare(
      `UPDATE surface_actions
       SET status = 'pending', claimed_at = NULL, claim_deadline_at = NULL,
           claim_owner_kind = NULL, claim_owner_id = NULL
       WHERE id = ? AND status = 'claimed'`,
    );
    const released: SurfaceAction[] = [];
    for (const row of rows) {
      if (release.run(row.id).changes > 0) released.push(getAction(db, row.id)!);
    }
    return released;
  })();
}

// Nothing can still be running after a restart, so every claim found at boot is
// an orphan. Deterministic recovery beats guessing whether a handler survived.
export function releaseOrphanedClaims(db: Database.Database): number {
  return db.prepare(
    `UPDATE surface_actions SET status = 'pending', ${clearClaimSql()} WHERE status = 'claimed'`,
  ).run().changes;
}

// Manual `surface ack <id>`: an agent declaring a click done, including one a
// binding parked in `claimed`. Unfenced by design — it is the human/agent
// override, not part of the delivery handshake.
export function ackAction(db: Database.Database, id: string): boolean {
  return db.prepare(
    `UPDATE surface_actions SET status = 'handled', handled_at = datetime('now')
     WHERE id = ? AND status IN ('pending', 'claimed')`,
  ).run(id).changes > 0;
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
      `INSERT INTO codex_action_deliveries (action_id, surface_id, thread_id) VALUES (?, ?, ?)
       ON CONFLICT(action_id) DO UPDATE SET
         surface_id = excluded.surface_id,
         thread_id = excluded.thread_id,
         turn_id = NULL`,
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
