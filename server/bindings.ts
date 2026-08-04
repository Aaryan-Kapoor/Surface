import type Database from "better-sqlite3";
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getDataDir } from "./paths.js";
import { getDb } from "./db.js";
import type { BindingClaim, SurfaceAction } from "./actionsStore.js";
import {
  claimActionsForBinding,
  getPendingActions,
  completeBindingClaims,
  getUnresolvedActionCount,
  releaseBindingClaims,
  releaseClaimsByOwner,
  releaseExpiredWaiterClaims,
} from "./actionsStore.js";
import { getArtifact } from "./artifacts.js";
import { broadcastGlobal, broadcastToSurface, hasEligibleWaiter } from "./sse.js";
import { OutboundBlockedError, safeHttpRequest } from "./outbound.js";
import { maybeDispatchCodex, codexInFlight } from "./codexBridge.js";

// Layer 2 of the delivery ladder (docs/interaction/bindings.md): pre-registered
// commands/webhooks Surface fires when an action arrives and no live waiter is
// connected. Command bindings are argv-safe — the command string is tokenized
// once (no shell), and click data only ever reaches the process on stdin.

export interface BindingRow {
  id: string;
  surface_id: string;
  action_pattern: string;
  kind: "command" | "webhook";
  run: string | null;
  webhook_url: string | null;
  cwd: string | null;
  enabled: number;
  timeout_seconds: number;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export function createBinding(db: Database.Database, params: {
  surface_id: string;
  action_pattern?: string;
  run?: string;
  webhook_url?: string;
  cwd?: string;
  timeout_seconds?: number;
}): BindingRow {
  const kind = params.run ? "command" : params.webhook_url ? "webhook" : null;
  if (!kind) throw new Error("a binding needs --run <command> or --webhook <url>");
  if (params.run && params.webhook_url) throw new Error("a binding is either a command or a webhook, not both");
  if (params.run) tokenizeCommand(params.run); // validate argv now, not at click time
  if (params.webhook_url && !/^https?:\/\//.test(params.webhook_url)) {
    throw new Error("webhook_url must be http(s)");
  }
  const id = uuidv4();
  db.prepare(
    `INSERT INTO surface_bindings (id, surface_id, action_pattern, kind, run, webhook_url, cwd, timeout_seconds)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    params.surface_id,
    params.action_pattern || "*",
    kind,
    params.run || null,
    params.webhook_url || null,
    params.cwd || null,
    params.timeout_seconds && params.timeout_seconds > 0 ? params.timeout_seconds : 600,
  );
  return db.prepare(`SELECT * FROM surface_bindings WHERE id = ?`).get(id) as BindingRow;
}

export function listBindings(db: Database.Database, surfaceId?: string): BindingRow[] {
  if (surfaceId) {
    return db.prepare(`SELECT * FROM surface_bindings WHERE surface_id = ? ORDER BY created_at ASC`).all(surfaceId) as BindingRow[];
  }
  return db.prepare(`SELECT * FROM surface_bindings ORDER BY created_at ASC`).all() as BindingRow[];
}

export function deleteBinding(db: Database.Database, id: string): boolean {
  return db.prepare(`DELETE FROM surface_bindings WHERE id = ?`).run(id).changes > 0;
}

export function setBindingEnabled(db: Database.Database, id: string, enabled: boolean): boolean {
  return db.prepare(`UPDATE surface_bindings SET enabled = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(enabled ? 1 : 0, id).changes > 0;
}

// Patterns: "*" matches everything; "a|b|c" matches any listed name.
function patternMatches(pattern: string, action: string): boolean {
  if (pattern === "*" || pattern === "") return true;
  return pattern.split("|").map((p) => p.trim()).includes(action);
}

// Tokenize a command string into argv with quote support — deliberately NOT a
// shell: no expansion, no substitution, no redirection. Click data never
// touches this string; it arrives on stdin.
export function tokenizeCommand(command: string): string[] {
  const argv: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  const chars = [...command];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    // A backslash escapes only a quote or another backslash. Treating every
    // backslash as an escape silently ate Windows paths — `node "C:\a\b.js"`
    // tokenized to `C:ab.js` — which broke every binding registered with an
    // absolute path on Windows, while still leaving `\"` and `\\` working.
    if (ch === "\\" && quote !== "'") {
      const next = chars[i + 1];
      if (next === '"' || next === "'" || next === "\\") {
        current += next;
        started = true;
        i++;
        continue;
      }
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (/\s/.test(ch)) {
      if (started || current) { argv.push(current); current = ""; started = false; }
      continue;
    }
    current += ch;
    started = true;
  }
  if (quote) throw new Error(`Unterminated quote in command: ${command}`);
  if (started || current) argv.push(current);
  if (!argv.length) throw new Error("Empty binding command");
  return argv;
}

// Per-project consent gate: .surface/config.json → bindings.enabled === true.
// null/missing/unreadable means "not asked yet", so command/webhook wake
// bindings must fail closed rather than allowing a system-plane agent to
// self-approve unattended process launches.
export function projectAllowsBindings(projectRoot: string | null): boolean {
  if (!projectRoot) return false;
  try {
    const config = JSON.parse(fs.readFileSync(path.join(projectRoot, ".surface", "config.json"), "utf8"));
    return config?.bindings?.enabled === true;
  } catch {
    return false;
  }
}

function logsDir(): string {
  const dir = path.join(getDataDir(), "logs", "bindings");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function setStatus(db: Database.Database, binding: BindingRow, status: string, error?: string | null) {
  db.prepare(
    `UPDATE surface_bindings SET last_run_at = datetime('now'), last_status = ?, last_error = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(status, error ?? null, binding.id);
  const event = { surface_id: binding.surface_id, binding_id: binding.id, status, error: error ?? null };
  broadcastGlobal("binding_status", event);
  broadcastToSurface(binding.surface_id, "binding_status", event);
}

// Single-flight + coalescing (docs/interaction/delivery-ladder.md): at most one
// execution in flight per surface; actions arriving meanwhile stay pending and
// are picked up by a follow-up pass when the run finishes.
const inFlight = new Set<string>();
const rerunRequested = new Set<string>();

// The codex layer checks this so two channels never hand overlapping pending
// batches to two agents at once.
export function bindingInFlight(surfaceId: string): boolean {
  return inFlight.has(surfaceId);
}

// Ask the running binding's coalescing tail for a follow-up pass (used by the
// codex layer when it defers to an in-flight binding). Returns false when no
// binding is actually in flight anymore.
export function requestBindingFollowup(surfaceId: string): boolean {
  if (!inFlight.has(surfaceId)) return false;
  rerunRequested.add(surfaceId);
  return true;
}

// How long an eligible live waiter gets to claim an action before layer 2 is
// allowed to try. Waiter presence used to suppress bindings *indefinitely*,
// which meant a waiter whose harness had wedged — socket open, nobody reading —
// silently disabled wake bindings forever. A bounded first refusal keeps layer 1
// preferred without letting a dead-but-connected waiter black-hole the ladder.
const WAITER_GRACE_MS = 5_000;

// Deliver an action: give an eligible waiter first refusal, then fall back to
// bindings. The timer only decides who gets to *try* — SQLite decides who wins,
// so a waiter claiming at grace+1ms and a binding starting at grace both resolve
// against the same CAS rather than against timer ordering.
export function scheduleDelivery(surfaceId: string, action: string): void {
  const artifact = getArtifact(getDb(), surfaceId);
  if (!artifact) return;
  const target = { surfaceId, projectRoot: artifact.project_root, action };
  if (hasEligibleWaiter(target)) {
    setTimeout(() => dispatchAction(surfaceId, action), WAITER_GRACE_MS).unref();
    return;
  }
  dispatchAction(surfaceId, action);
}

export function dispatchAction(surfaceId: string, action: string): void {
  const db = getDb();
  const artifact = getArtifact(db, surfaceId);
  if (!artifact) return;
  const consent = projectAllowsBindings(artifact.project_root);

  // Layer 2: explicit bindings, when consented. They take precedence over the
  // automatic codex flowback below — registering one is a deliberate choice.
  if (consent) {
    const bindings = listBindings(db, surfaceId).filter(
      (b) => b.enabled && patternMatches(b.action_pattern, action),
    );
    if (bindings.length) {
      // One channel owns a surface's pending set at a time: if a codex
      // delivery is mid-flight, queue there instead of double-batching.
      if (codexInFlight(surfaceId)) {
        maybeDispatchCodex(surfaceId, consent);
        return;
      }
      if (inFlight.has(surfaceId)) {
        rerunRequested.add(surfaceId);
        return;
      }
      void runBindings(surfaceId, bindings);
      return;
    }
  }

  // Layer 2.5: automatic codex flowback for surfaces created by a codex
  // session (no-op for everything else). Consent gates headless wakes inside;
  // without it, actions for dead sessions stay in the inbox (layer 3).
  maybeDispatchCodex(surfaceId, consent);
}

// Expand a binding's pattern into the action names it may claim. `undefined`
// means "*" — every pending action on the surface.
function claimableNames(bindings: BindingRow[]): string[] | undefined {
  if (bindings.some((b) => b.action_pattern === "*" || b.action_pattern === "")) return undefined;
  const names = new Set<string>();
  for (const b of bindings) {
    for (const name of b.action_pattern.split("|").map((p) => p.trim()).filter(Boolean)) names.add(name);
  }
  return [...names];
}

// A released row is deliverable again. Tell live waiters so they can re-poll
// without waiting for a reconnect, and restart the ladder for it.
function announceAvailable(rows: Array<{ id: string; surface_id: string; action: string }>): void {
  for (const row of rows) {
    broadcastGlobal("actions_available", { surface_id: row.surface_id, action_id: row.id });
    broadcastGlobal("actions_acked", {
      surface_id: row.surface_id,
      pending_actions: getUnresolvedActionCount(getDb(), row.surface_id),
    });
  }
}

// A waiter's connection dropped: release whatever it claimed but never handed
// over, and put those actions back through the ladder.
export function releaseWaiterClaims(clientId: string): void {
  try {
    const released = releaseClaimsByOwner(getDb(), { ownerKind: "waiter", ownerId: clientId });
    if (!released.length) return;
    announceAvailable(released);
    for (const row of released) scheduleDelivery(row.surface_id, row.action);
  } catch (err: any) {
    console.error(`[actions] releasing claims for client ${clientId} failed:`, err?.message || err);
  }
}

// Backstop for a waiter that claimed and then wedged with its socket still open,
// where no close event will ever arrive. Connection close normally gets there
// first; this runs every 5s and only touches claims past their handoff deadline.
const CLAIM_REAPER_MS = 5_000;
let reaper: NodeJS.Timeout | null = null;

export function startClaimReaper(): void {
  if (reaper) return;
  reaper = setInterval(() => {
    try {
      const released = releaseExpiredWaiterClaims(getDb());
      if (!released.length) return;
      console.log(`[actions] released ${released.length} expired delivery claim(s)`);
      announceAvailable(released);
      for (const row of released) scheduleDelivery(row.surface_id, row.action);
    } catch (err: any) {
      console.error("[actions] claim reaper failed:", err?.message || err);
    }
  }, CLAIM_REAPER_MS);
  reaper.unref();
}

// Grace is per action, not per batch. One action's timer firing must not drag a
// newer sibling into the batch: with two clicks four seconds apart, the first
// timer would otherwise hand the binding an action that had only had one second
// of its own five. An action is claimable when no waiter is eligible for it at
// all, or when its own grace window has passed.
function graceElapsed(
  db: ReturnType<typeof getDb>,
  surfaceId: string,
  projectRoot: string | null,
  names: string[] | undefined,
): string[] {
  const cutoff = Date.now() - WAITER_GRACE_MS;
  return getPendingActions(db, surfaceId)
    .filter((a) => !names || names.includes(a.action))
    .filter((a) => {
      if (!hasEligibleWaiter({ surfaceId, projectRoot, action: a.action })) return true;
      // SQLite stamps `datetime('now')` as UTC without a zone marker.
      const createdMs = Date.parse(`${a.created_at.replace(" ", "T")}Z`);
      return !Number.isFinite(createdMs) || createdMs <= cutoff;
    })
    .map((a) => a.id);
}

async function runBindings(surfaceId: string, bindings: BindingRow[]): Promise<void> {
  inFlight.add(surfaceId);
  // Identifies this run as the claimant, so a failed run releases exactly the
  // actions it took and nothing else.
  const bindingRunId = `binding:${uuidv4()}`;
  let claims: BindingClaim[] = [];
  try {
    const db = getDb();
    const artifact = getArtifact(db, surfaceId);
    if (!artifact) return;
    // Claim the batch BEFORE spawning. A command binding may run for its full
    // 600s timeout, and until this claim existed those rows stayed `pending` for
    // the whole run — so a waiter connecting mid-run drained them too and the
    // work happened twice. Only actions matching these bindings' own patterns
    // are claimed; a click belonging to a different binding stays pending.
    claims = claimActionsForBinding(db, {
      surfaceId,
      actionNames: claimableNames(bindings),
      actionIds: graceElapsed(db, surfaceId, artifact.project_root, claimableNames(bindings)),
      bindingRunId,
    });
    if (!claims.length) return;
    const pending = claims.map((c) => c.action);
    const payload = {
      type: "surface_action_batch",
      surface_id: surfaceId,
      surface_title: artifact.title,
      project_root: artifact.project_root,
      actions: pending.map((a) => ({
        id: a.id,
        action: a.action,
        data: (() => { try { return JSON.parse(a.data); } catch { return a.data; } })(),
        created_at: a.created_at,
      })),
    };

    for (const binding of bindings) {
      const ok = binding.kind === "command"
        ? await runCommandBinding(binding, artifact.project_root, payload)
        : await runWebhookBinding(binding, payload);
      if (ok) {
        completeBindingClaims(db, claims);
        claims = [];
        broadcastGlobal("actions_acked", {
          surface_id: surfaceId,
          pending_actions: getUnresolvedActionCount(db, surfaceId),
        });
        break; // first successful binding handles the batch
      }
    }
  } catch (err: any) {
    console.error(`[bindings] dispatch failed for ${surfaceId}:`, err?.message || err);
  } finally {
    // Every binding failed (or threw): the work did not happen, so the batch
    // goes back on the queue for a waiter or the inbox rather than being
    // silently consumed. Fenced on our own tokens — never release someone else's.
    if (claims.length) {
      const released = releaseBindingClaims(getDb(), claims);
      announceAvailable(released);
    }
    inFlight.delete(surfaceId);
    if (rerunRequested.delete(surfaceId)) {
      // Coalesced clicks from during the run: one follow-up pass.
      const db = getDb();
      const stillPending: SurfaceAction[] = getPendingActions(db, surfaceId);
      if (stillPending.length) {
        const again = listBindings(db, surfaceId).filter(
          (b) => b.enabled && stillPending.some((a) => patternMatches(b.action_pattern, a.action)),
        );
        if (again.length) void runBindings(surfaceId, again);
        else {
          // Leftovers no binding matches: hand them to the codex layer so
          // they don't strand until the next unrelated dispatch.
          const artifact = getArtifact(db, surfaceId);
          if (artifact) maybeDispatchCodex(surfaceId, projectAllowsBindings(artifact.project_root));
        }
      }
    }
  }
}

function runCommandBinding(
  binding: BindingRow,
  projectRoot: string | null,
  payload: unknown,
): Promise<boolean> {
  return new Promise((resolve) => {
    let argv: string[];
    try {
      argv = tokenizeCommand(binding.run || "");
    } catch (err: any) {
      setStatus(getDb(), binding, "failed", err.message);
      resolve(false);
      return;
    }
    const cwd = binding.cwd || projectRoot || os.homedir();
    const logPath = path.join(logsDir(), `${binding.id}-${Date.now()}.log`);
    setStatus(getDb(), binding, "running");
    console.log(`[bindings] ${binding.surface_id}: spawning ${argv[0]} (log: ${logPath})`);

    const child = execFile(argv[0], argv.slice(1), {
      cwd,
      timeout: binding.timeout_seconds * 1000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, SURFACE_BINDING_ID: binding.id, SURFACE_SURFACE_ID: binding.surface_id },
    }, (err, stdout, stderr) => {
      try {
        fs.writeFileSync(logPath, `# binding ${binding.id} · surface ${binding.surface_id}\n# cwd ${cwd}\n# argv ${JSON.stringify(argv)}\n\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);
      } catch {}
      if (err) {
        setStatus(getDb(), binding, "failed", (err as any).killed ? `timeout after ${binding.timeout_seconds}s` : err.message);
        resolve(false);
      } else {
        setStatus(getDb(), binding, "ok");
        resolve(true);
      }
    });
    child.stdin?.on("error", () => {});
    child.stdin?.write(JSON.stringify(payload), () => {});
    child.stdin?.end();
  });
}

async function runWebhookBinding(binding: BindingRow, payload: unknown): Promise<boolean> {
  setStatus(getDb(), binding, "running");
  const delays = [0, 1000, 5000, 25000];
  let lastError = "unknown";
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt]) await new Promise((r) => setTimeout(r, delays[attempt]));
    try {
      const res = await safeHttpRequest(binding.webhook_url!, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        timeoutMs: Math.min(binding.timeout_seconds, 60) * 1000,
        maxBytes: 1024 * 1024,
      });
      if (res.status >= 200 && res.status < 300) {
        setStatus(getDb(), binding, "ok");
        return true;
      }
      lastError = `${res.status} ${res.statusText}`;
    } catch (err: any) {
      lastError = err instanceof OutboundBlockedError ? err.message : err?.message || "network error";
    }
  }
  setStatus(getDb(), binding, "failed", lastError);
  return false;
}
