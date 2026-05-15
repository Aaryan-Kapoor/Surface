import type Database from "better-sqlite3";

interface Migration {
  version: number;
  description: string;
  up: (db: Database.Database) => void;
}

// Migrations are append-only. Each one bumps PRAGMA user_version.
//
// Convention: v1 is the full baseline schema (idempotent CREATE IF NOT EXISTS,
// safe to re-run on installs that already have it). v2+ should be additive
// ALTERs / new tables, not edits to v1. If a future change is destructive
// (column drop, type change), write it as a new migration that ALTERs the
// existing schema — do NOT edit v1.
const migrations: Migration[] = [
  {
    version: 1,
    description: "baseline schema",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS surfaces (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          html TEXT NOT NULL,
          metadata TEXT DEFAULT '{}',
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS artifacts (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          kind TEXT NOT NULL,
          mime TEXT,
          renderer TEXT,
          source_type TEXT NOT NULL,
          current_version_id TEXT,
          workspace_path TEXT,
          metadata TEXT DEFAULT '{}',
          deleted_at TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS artifact_versions (
          id TEXT PRIMARY KEY,
          artifact_id TEXT NOT NULL,
          parent_version_id TEXT,
          version INTEGER NOT NULL,
          reason TEXT,
          created_by TEXT,
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

        CREATE TABLE IF NOT EXISTS surface_views (
          id TEXT PRIMARY KEY,
          artifact_id TEXT NOT NULL,
          title TEXT NOT NULL,
          thumbnail_path TEXT,
          metadata TEXT DEFAULT '{}',
          pinned INTEGER DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS sandbox_sessions (
          id TEXT PRIMARY KEY,
          artifact_id TEXT NOT NULL,
          version_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          status TEXT NOT NULL,
          preview_url TEXT,
          port INTEGER,
          metadata TEXT DEFAULT '{}',
          created_at TEXT DEFAULT (datetime('now')),
          last_used_at TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE,
          FOREIGN KEY (version_id) REFERENCES artifact_versions(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS surface_actions (
          id TEXT PRIMARY KEY,
          surface_id TEXT NOT NULL,
          action TEXT NOT NULL,
          data TEXT DEFAULT '{}',
          status TEXT DEFAULT 'pending',
          created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS display_config (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
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

// One-time idempotent fix for installs that predate the migration framework
// and may still have a FOREIGN KEY on surface_actions.surface_id pointing at
// the legacy `surfaces` table (which is now read-only fallback only).
export function dropLegacySurfaceActionsForeignKey(db: Database.Database): void {
  const fks = db.prepare(`PRAGMA foreign_key_list(surface_actions)`).all() as Array<{ table: string }>;
  if (!fks.some((k) => k.table === "surfaces")) return;
  console.log(`[migrations] stripping legacy FK on surface_actions.surface_id`);
  db.exec(`
    ALTER TABLE surface_actions RENAME TO surface_actions_old;
    CREATE TABLE surface_actions (
      id TEXT PRIMARY KEY,
      surface_id TEXT NOT NULL,
      action TEXT NOT NULL,
      data TEXT DEFAULT '{}',
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now'))
    );
    INSERT INTO surface_actions (id, surface_id, action, data, status, created_at)
      SELECT id, surface_id, action, data, status, created_at FROM surface_actions_old;
    DROP TABLE surface_actions_old;
  `);
}
