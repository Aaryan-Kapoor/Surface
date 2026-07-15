import type Database from "better-sqlite3";
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getDataDir } from "./paths.js";
import { getDb } from "./db.js";
import { getPendingActions, ackAction } from "./actionsStore.js";
import { getArtifact } from "./artifacts.js";
import { broadcastGlobal, broadcastToSurface, hasWaiter } from "./sse.js";
import { OutboundBlockedError, safeHttpRequest } from "./outbound.js";
import { maybeDispatchCodex } from "./codexBridge.js";

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
  let escaped = false;
  let started = false;
  for (const ch of command) {
    if (escaped) { current += ch; escaped = false; continue; }
    if (ch === "\\" && quote !== "'") { escaped = true; continue; }
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

export function dispatchAction(surfaceId: string, action: string): void {
  // Layer 1 suppression: someone is live-waiting; they'll handle it.
  if (hasWaiter(surfaceId)) return;

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

async function runBindings(surfaceId: string, bindings: BindingRow[]): Promise<void> {
  inFlight.add(surfaceId);
  try {
    const db = getDb();
    const artifact = getArtifact(db, surfaceId);
    if (!artifact) return;
    // The batch: every pending action for this surface, not just the trigger.
    const pending = getPendingActions(db, surfaceId);
    if (!pending.length) return;
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
        for (const a of pending) ackAction(db, a.id);
        broadcastGlobal("actions_acked", {
          surface_id: surfaceId,
          pending_actions: getPendingActions(db, surfaceId).length,
        });
        break; // first successful binding handles the batch
      }
    }
  } catch (err: any) {
    console.error(`[bindings] dispatch failed for ${surfaceId}:`, err?.message || err);
  } finally {
    inFlight.delete(surfaceId);
    if (rerunRequested.delete(surfaceId)) {
      // Coalesced clicks from during the run: one follow-up pass.
      const db = getDb();
      const stillPending = getPendingActions(db, surfaceId);
      if (stillPending.length && !hasWaiter(surfaceId)) {
        const again = listBindings(db, surfaceId).filter(
          (b) => b.enabled && stillPending.some((a) => patternMatches(b.action_pattern, a.action)),
        );
        if (again.length) void runBindings(surfaceId, again);
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
