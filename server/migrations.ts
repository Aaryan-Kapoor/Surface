import type Database from "better-sqlite3";

interface Migration {
  version: number;
  description: string;
  up: (db: Database.Database) => void;
}

const migrations: Migration[] = [
  {
    version: 1,
    description: "baseline schema",
    up: () => {
      // Baseline tables are created idempotently by initDb and ensureArtifactTables.
      // This migration exists only to claim user_version=1 on installs that already
      // have the schema. Future schema changes append new migrations below.
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
