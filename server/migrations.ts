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

const migrations: Migration[] = [
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
];

export function runMigrations(db: Database.Database): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (const m of migrations) {
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
