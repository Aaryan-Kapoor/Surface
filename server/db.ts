import Database from "better-sqlite3";
import fs from "fs";
import { bootstrapDataDir, getDbPath } from "./paths.js";
import { isPreBaseline, runMigrations } from "./migrations.js";

let db: Database.Database;

// Fresh-start policy (decided 2026-06): a pre-baseline database is archived to
// db.sqlite.bak (plus -wal/-shm), never row-migrated. Agents re-link or
// re-create their surfaces against the clean schema.
function archivePreBaselineDb(): void {
  const dbPath = getDbPath();
  let suffix = "";
  let n = 0;
  while (fs.existsSync(`${dbPath}.bak${suffix}`)) {
    n++;
    suffix = `.${n}`;
  }
  console.log(`[surface] pre-baseline database found; archiving to ${dbPath}.bak${suffix}`);
  fs.renameSync(dbPath, `${dbPath}.bak${suffix}`);
  for (const ext of ["-wal", "-shm"]) {
    if (fs.existsSync(dbPath + ext)) fs.renameSync(dbPath + ext, `${dbPath}.bak${suffix}${ext}`);
  }
}

export function initDb(): void {
  bootstrapDataDir();
  db = new Database(getDbPath());
  if (isPreBaseline(db)) {
    db.close();
    archivePreBaselineDb();
    db = new Database(getDbPath());
  }
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
}

export function getDb(): Database.Database {
  if (!db) throw new Error("Database has not been initialized");
  return db;
}

export function closeDb(): void {
  if (!db) return;
  db.close();
}
