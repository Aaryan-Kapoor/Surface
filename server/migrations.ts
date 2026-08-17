import type Database from "better-sqlite3";

// Fresh-start baseline (2026-06): one migration creates the entire artifact-first
// model, including the Phase 2/3 tables (surface_state, surface_bindings) so no
// inter-phase migrations are needed. Pre-baseline databases are not migrated —
// initDb archives them to db.sqlite.bak and starts clean (see server/db.ts).
//
// Migrations remain append-only: future schema changes add v11+ entries that
// ALTER this baseline; do not edit v10.
export const BASELINE_VERSION = 10;

interface Migration {
  version: number;
  description: string;
  up: (db: Database.Database) => void;
}

// Exported so tests can assert the ordering invariant the runner depends on,
// and so they can address a migration by description rather than by a
// hard-coded version number — three branches in flight had to renumber, and a
// test that pins the number breaks on a rename that is otherwise correct.
export const migrations: Migration[] = [
  {
    version: BASELINE_VERSION,
    description: "fresh artifact-first baseline",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS artifacts (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          kind TEXT NOT NULL,
          mime TEXT,
          source_type TEXT NOT NULL,
          template TEXT,
          project_root TEXT,
          current_version_id TEXT,
          workspace_path TEXT,
          metadata TEXT DEFAULT '{}',
          deleted_at TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_artifacts_project ON artifacts(project_root);
        CREATE INDEX IF NOT EXISTS idx_artifacts_updated ON artifacts(updated_at);

        CREATE TABLE IF NOT EXISTS artifact_versions (
          id TEXT PRIMARY KEY,
          artifact_id TEXT NOT NULL,
          parent_version_id TEXT,
          version INTEGER NOT NULL,
          reason TEXT,
          manifest_json TEXT NOT NULL,
          content_hash TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          UNIQUE(artifact_id, version),
          FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE,
          FOREIGN KEY (parent_version_id) REFERENCES artifact_versions(id)
        );

        CREATE TABLE IF NOT EXISTS artifact_files (
          id TEXT PRIMARY KEY,
          artifact_version_id TEXT NOT NULL,
          path TEXT NOT NULL,
          mime TEXT,
          size_bytes INTEGER NOT NULL,
          sha256 TEXT NOT NULL,
          storage_kind TEXT NOT NULL,
          storage_path TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now')),
          UNIQUE(artifact_version_id, path),
          FOREIGN KEY (artifact_version_id) REFERENCES artifact_versions(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS surface_actions (
          id TEXT PRIMARY KEY,
          surface_id TEXT NOT NULL,
          action TEXT NOT NULL,
          data TEXT DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TEXT DEFAULT (datetime('now')),
          handled_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_surface_actions_pending
        ON surface_actions(surface_id, status, created_at);

        CREATE TABLE IF NOT EXISTS surface_state (
          artifact_id TEXT PRIMARY KEY,
          state_json TEXT NOT NULL DEFAULT '{}',
          state_version INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS surface_stream_chunks (
          artifact_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          kind TEXT NOT NULL DEFAULT 'text',
          content TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now')),
          PRIMARY KEY (artifact_id, seq),
          FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS surface_bindings (
          id TEXT PRIMARY KEY,
          surface_id TEXT NOT NULL,
          action_pattern TEXT NOT NULL DEFAULT '*',
          kind TEXT NOT NULL,
          run TEXT,
          webhook_url TEXT,
          cwd TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          timeout_seconds INTEGER NOT NULL DEFAULT 600,
          last_run_at TEXT,
          last_status TEXT,
          last_error TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (surface_id) REFERENCES artifacts(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_surface_bindings_surface
        ON surface_bindings(surface_id, enabled);

        CREATE TABLE IF NOT EXISTS display_config (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS auth_pairing_tokens (
          id TEXT PRIMARY KEY,
          token_hash TEXT NOT NULL UNIQUE,
          label TEXT,
          role TEXT NOT NULL DEFAULT 'device',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          expires_at TEXT NOT NULL,
          consumed_at TEXT,
          revoked_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_auth_pairing_tokens_active
        ON auth_pairing_tokens(revoked_at, consumed_at, expires_at);

        CREATE TABLE IF NOT EXISTS auth_sessions (
          id TEXT PRIMARY KEY,
          token_hash TEXT NOT NULL UNIQUE,
          role TEXT NOT NULL DEFAULT 'device',
          label TEXT,
          client_ip TEXT,
          user_agent TEXT,
          ttl_seconds INTEGER NOT NULL DEFAULT 2592000,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          expires_at TEXT NOT NULL,
          last_seen_at TEXT,
          revoked_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_auth_sessions_active
        ON auth_sessions(revoked_at, expires_at);
      `);
    },
  },
  {
    version: 11,
    description: "add global pending-action index",
    up: (db) => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_surface_actions_status_created
        ON surface_actions(status, created_at);
      `);
    },
  },
  {
    version: 12,

    description: "agent session capture (codex flowback)",
    up: (db) => {
      db.exec(`
        -- Which agent session created a surface. Written once at creation from
        -- the creating shell's environment (CODEX_THREAD_ID / CLAUDE_CODE_SESSION_ID);
        -- the delivery ladder uses it to route actions back to that session.
        CREATE TABLE IF NOT EXISTS agent_links (
          surface_id TEXT PRIMARY KEY,
          agent_kind TEXT NOT NULL,
          session_id TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (surface_id) REFERENCES artifacts(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_agent_links_session
        ON agent_links(agent_kind, session_id);

        -- Live-session registry, fed by the agent-side SessionStart hook.
        -- pid liveness distinguishes "session open in a plain TUI" (hold the
        -- action) from "session dead" (safe to wake headlessly).
        CREATE TABLE IF NOT EXISTS agent_sessions (
          session_id TEXT PRIMARY KEY,
          agent_kind TEXT NOT NULL,
          pid INTEGER,
          cwd TEXT,
          transcript_path TEXT,
          registration_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_agent_sessions_pid
        ON agent_sessions(pid);

        -- Threads the codex bridge resumed headlessly. "Loaded in the daemon"
        -- does not mean "a user is attached" once the bridge has resumed a
        -- thread; this record keeps consent + approval fail-closed rules
        -- correct across service restarts.
        CREATE TABLE IF NOT EXISTS codex_bridge_threads (
          thread_id TEXT PRIMARY KEY,
          resumed_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    },
  },
  {
    version: 13,
    description: "durable codex delivery leases",
    up: (db) => {
      // Early checkouts of the v12 branch may already have user_version=12
      // without this review-added column. Keep the upgrade append-only and
      // tolerate fresh v12 databases that already include it.
      const columns = db.pragma("table_info(agent_sessions)") as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "registration_order")) {
        db.exec(`ALTER TABLE agent_sessions ADD COLUMN registration_order INTEGER NOT NULL DEFAULT 0`);
      }
      db.exec(`
        -- Headless turn delivery is at-least-once. Actions move from pending
        -- to delivering before turn/start and return to pending after an
        -- uncertain outcome, including a service restart.
        CREATE TABLE IF NOT EXISTS codex_action_deliveries (
          action_id TEXT PRIMARY KEY,
          surface_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          turn_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (action_id) REFERENCES surface_actions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_codex_action_deliveries_surface
        ON codex_action_deliveries(surface_id);
      `);
    },
  },
  {
    version: 14,
    description: "action claims: single-claimant delivery",
    up: (db) => {
      // An action is a work item, not a notification: exactly one handler may
      // take it (docs/interaction/delivery-ladder.md). These columns record who
      // owns the current delivery claim, and the token doubles as an
      // idempotency key so a retried claim after a lost response cannot strand
      // the action.
      //
      // `claimed` is a third status between pending and handled, for handlers
      // whose work outlives the claim (a command binding may run for its full
      // 600s timeout). The card badge counts pending + claimed, because the
      // user's click is not done until the work is; delivery only draws from
      // pending.
      const columns = db.pragma("table_info(surface_actions)") as Array<{ name: string }>;
      const add = (name: string, ddl: string) => {
        if (!columns.some((column) => column.name === name)) db.exec(ddl);
      };
      add("claimed_at", `ALTER TABLE surface_actions ADD COLUMN claimed_at TEXT`);
      add("claim_deadline_at", `ALTER TABLE surface_actions ADD COLUMN claim_deadline_at TEXT`);
      add("claim_token", `ALTER TABLE surface_actions ADD COLUMN claim_token TEXT`);
      add("claim_owner_kind", `ALTER TABLE surface_actions ADD COLUMN claim_owner_kind TEXT`);
      add("claim_owner_id", `ALTER TABLE surface_actions ADD COLUMN claim_owner_id TEXT`);
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_surface_actions_claim_token
        ON surface_actions(claim_token) WHERE claim_token IS NOT NULL;

        CREATE INDEX IF NOT EXISTS idx_surface_actions_claim_owner
        ON surface_actions(claim_owner_kind, claim_owner_id, status);

        CREATE INDEX IF NOT EXISTS idx_surface_actions_claim_deadline
        ON surface_actions(status, claim_deadline_at)
        WHERE status = 'claimed' AND claim_deadline_at IS NOT NULL;
      `);
    },
  },
  {
    version: 15,
    description: "artifacts.content_rev: a monotonic per-change counter",
    up: (db) => {
      // The thumbnail generation (server/thumbs.ts) is the identity of the
      // revision a cached capture is a picture of. It was hashed from
      // current_version_id + updated_at, and neither moves usefully for a
      // *linked* artifact's touch: the version row is unchanged and updated_at
      // is SQLite's one-second-resolution clock, so two touches inside one
      // second produced the same generation and an in-flight capture of the
      // first could be written — and then deduplicated against — as the
      // picture of the second.
      //
      // Nothing already on the row is monotonic (metadata is the only other
      // mutable field, and updateArtifact replaces that document wholesale,
      // which would reset a counter kept there and let a generation repeat).
      // So: one integer, bumped by every write that declares the rendered
      // content changed, and never reset.
      const columns = db.pragma("table_info(artifacts)") as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "content_rev")) {
        db.exec(`ALTER TABLE artifacts ADD COLUMN content_rev INTEGER NOT NULL DEFAULT 0`);
      }
    },
  },
  {
    // 16, not 15. The UI-refresh branch claims 15 (artifacts.content_rev) and
    // the tour branch claims 17, and runMigrations SILENTLY SKIPS any version
    // at or below the database's current one — so these three have to land in
    // numeric order, 15 → 16 → 17, or the ones that land later never run on a
    // database that has already seen a higher number.
    version: 16,
    description: "auth_sessions: carry already-paired devices to the one-year TTL",
    up: (db) => {
      // Rolling expiry reads each session's *own* ttl_seconds, frozen at the
      // moment it was created. Raising the default alone would therefore fix
      // nothing for anyone already paired: their phone would still hit the
      // thirty-day wall and get sent back to the host terminal for a fresh
      // token, which is the entire complaint.
      //
      // Only rows still sitting on the old default move. An operator who
      // deliberately asked for a short-lived session keeps it, and system
      // bearers keep the month by design (DEFAULT_SYSTEM_SESSION_TTL_SECONDS),
      // so the role filter is load-bearing rather than incidental. A device
      // that explicitly requested exactly 2592000 is indistinguishable from one
      // that took the default and is swept along; that is a benign coincidence,
      // not a setting silently overridden.
      db.prepare(
        `UPDATE auth_sessions
         SET ttl_seconds = 31536000,
             expires_at = datetime('now', '+31536000 seconds')
         WHERE role = 'device'
           AND ttl_seconds = 2592000
           AND revoked_at IS NULL
           AND expires_at > datetime('now')`,
      ).run();
    },
  },
];

/**
 * Apply every migration the database has not seen, oldest first.
 *
 * The sort is not tidiness. `user_version` only ever moves forward and a
 * migration at or below it is skipped, so a single out-of-order entry is
 * silently fatal: run 15, then 17, and 16 is now unreachable forever — no
 * error, no log line, just a column or a backfill that never happened on every
 * database that took that path. This is not hypothetical. Three branches were
 * once in flight numbered 15, 16 and 17, and resolving the merge conflict
 * between them the obvious way produced the array in the order 15, 17, 16.
 *
 * The array itself is authored in order and should stay that way — but the
 * correctness of every future merge should not depend on whoever resolves it
 * noticing. Sorting a copy here costs nothing and removes the hazard from the
 * class of things a human has to get right.
 */
export function runMigrations(db: Database.Database): void {
  // Two migrations claiming one number is an authoring mistake that sorting
  // cannot fix — the second would still be skipped — so it fails loudly, in
  // development, rather than quietly on a user's machine.
  const seen = new Set<number>();
  for (const m of migrations) {
    if (seen.has(m.version)) {
      throw new Error(
        `two migrations both claim version ${m.version} ("${m.description}") — ` +
        `renumber one of them; the later would never run`,
      );
    }
    seen.add(m.version);
  }

  const current = db.pragma("user_version", { simple: true }) as number;
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (m.version <= current) continue;
    console.log(`[migrations] applying v${m.version}: ${m.description}`);
    db.transaction(() => {
      m.up(db);
      db.pragma(`user_version = ${m.version}`);
    })();
  }
}

// A database is pre-baseline when it has tables but a user_version below the
// baseline. Such files are archived, never migrated.
export function isPreBaseline(db: Database.Database): boolean {
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version >= BASELINE_VERSION) return false;
  const row = db
    .prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .get() as { n: number };
  return row.n > 0;
}
