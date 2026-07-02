import type Database from "better-sqlite3";

export function getDisplayConfig(db: Database.Database): Record<string, unknown> {
  const row = db.prepare(`SELECT value FROM display_config WHERE key = 'theme'`).get() as { value: string } | undefined;
  if (!row) return {};
  try { return JSON.parse(row.value); } catch { return {}; }
}

export function resetDisplayConfig(db: Database.Database): void {
  db.prepare(`DELETE FROM display_config WHERE key = 'theme'`).run();
}

export function setDisplayConfig(db: Database.Database, config: Record<string, unknown>): Record<string, unknown> {
  const existing = getDisplayConfig(db);
  const merged = { ...existing, ...config };
  db.prepare(`INSERT OR REPLACE INTO display_config (key, value) VALUES ('theme', ?)`).run(JSON.stringify(merged));
  return merged;
}
