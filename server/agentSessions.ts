import { execFileSync } from "child_process";
import fs from "fs";
import type Database from "better-sqlite3";

// Agent session capture (docs/interaction/codex.md): surfaces remember which
// agent session created them so the delivery ladder can route actions back to
// that exact session — live (in-context turn) or dead (headless wake).

export interface AgentLinkRow {
  surface_id: string;
  agent_kind: string;
  session_id: string;
  created_at: string;
}

export interface AgentSessionRow {
  session_id: string;
  agent_kind: string;
  pid: number | null;
  cwd: string | null;
  transcript_path: string | null;
  created_at: string;
  last_seen_at: string;
}

const KINDS = new Set(["codex", "claude"]);
// Session ids come from harness env vars / hooks; both harnesses use UUIDs.
// Reject anything that couldn't be one so a hostile env var can't smuggle
// arbitrary strings into wake-turn plumbing.
const SESSION_ID_RE = /^[0-9a-fA-F-]{8,64}$/;

export function isValidAgentSession(value: unknown): value is { kind: string; session_id: string } {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.kind === "string" && KINDS.has(v.kind) &&
    typeof v.session_id === "string" && SESSION_ID_RE.test(v.session_id)
  );
}

export function recordAgentLink(
  db: Database.Database,
  surfaceId: string,
  session: { kind: string; session_id: string },
): void {
  if (!isValidAgentSession(session)) return;
  db.prepare(
    `INSERT INTO agent_links (surface_id, agent_kind, session_id) VALUES (?, ?, ?)
     ON CONFLICT(surface_id) DO UPDATE SET agent_kind = excluded.agent_kind, session_id = excluded.session_id`,
  ).run(surfaceId, session.kind, session.session_id);
}

export function getAgentLink(db: Database.Database, surfaceId: string): AgentLinkRow | undefined {
  return db.prepare(`SELECT * FROM agent_links WHERE surface_id = ?`).get(surfaceId) as AgentLinkRow | undefined;
}

export function registerAgentSession(
  db: Database.Database,
  params: { kind: string; session_id: string; pid?: number | null; cwd?: string | null; transcript_path?: string | null },
): void {
  if (!isValidAgentSession({ kind: params.kind, session_id: params.session_id })) {
    throw new Error("invalid agent session registration");
  }
  const pid = Number.isInteger(params.pid) && (params.pid as number) > 0 ? params.pid : null;
  db.prepare(
    `INSERT INTO agent_sessions (session_id, agent_kind, pid, cwd, transcript_path)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       agent_kind = excluded.agent_kind,
       pid = COALESCE(excluded.pid, agent_sessions.pid),
       cwd = COALESCE(excluded.cwd, agent_sessions.cwd),
       transcript_path = COALESCE(excluded.transcript_path, agent_sessions.transcript_path),
       last_seen_at = datetime('now')`,
  ).run(params.session_id, params.kind, pid, params.cwd || null, params.transcript_path || null);
  // Opportunistic pruning: a registry entry that hasn't been seen in a month
  // describes a session nobody is coming back to.
  db.prepare(`DELETE FROM agent_sessions WHERE last_seen_at < datetime('now', '-30 days')`).run();
}

export function getAgentSession(db: Database.Database, sessionId: string): AgentSessionRow | undefined {
  return db.prepare(`SELECT * FROM agent_sessions WHERE session_id = ?`).get(sessionId) as AgentSessionRow | undefined;
}

export function countAgentSessions(db: Database.Database): number {
  return (db.prepare(`SELECT count(*) AS n FROM agent_sessions`).get() as { n: number }).n;
}

// Codex always runs as this same user, so EPERM (alive, different user) means
// the pid was recycled onto someone else's process — NOT a codex TUI.
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Guard against pid reuse: the live process must actually look like codex,
// or a recycled pid would strand actions in "held_live_tui" forever.
function processLooksLikeCodex(pid: number): boolean {
  try {
    if (process.platform === "linux") {
      return /codex/i.test(fs.readFileSync(`/proc/${pid}/comm`, "utf8"));
    }
    if (process.platform === "darwin") {
      const out = execFileSync("ps", ["-o", "comm=", "-p", String(pid)], { timeout: 2_000 }).toString();
      return /codex/i.test(out);
    }
  } catch {
    return false;
  }
  return true; // other platforms: no cheap probe, trust the registration
}

// Is this session (still) the one its registered process is running? A pid is
// reused by newer sessions when the user starts/resumes another thread in the
// same TUI, so only the newest registration for a live pid counts as "open".
export function sessionOpenInProcess(db: Database.Database, session: AgentSessionRow): boolean {
  if (!session.pid || !pidAlive(session.pid) || !processLooksLikeCodex(session.pid)) return false;
  const newest = db
    .prepare(
      `SELECT session_id FROM agent_sessions WHERE pid = ? ORDER BY last_seen_at DESC, created_at DESC LIMIT 1`,
    )
    .get(session.pid) as { session_id: string } | undefined;
  return newest?.session_id === session.session_id;
}

// ── codex bridge thread ownership ──

export function markBridgeResumed(db: Database.Database, threadId: string): void {
  db.prepare(
    `INSERT INTO codex_bridge_threads (thread_id) VALUES (?) ON CONFLICT(thread_id) DO NOTHING`,
  ).run(threadId);
}

export function isBridgeResumed(db: Database.Database, threadId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM codex_bridge_threads WHERE thread_id = ?`).get(threadId);
}
