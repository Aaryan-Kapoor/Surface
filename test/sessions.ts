import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { migrations, runMigrations } from "../server/migrations.js";
import {
  DEFAULT_SESSION_TTL_SECONDS,
  DEFAULT_SYSTEM_SESSION_TTL_SECONDS,
  defaultTtlSeconds,
} from "../server/auth.js";
import { cleanupDir, REPO_ROOT, tmpDir } from "./helpers.js";

// Session lifetime: the default TTLs, and the migration that carries devices
// paired under the old thirty-day default onto the one-year one.
//
// Rolling expiry reads each row's own ttl_seconds, so the constant and the
// migration are two halves of one fix — raising the default helps nobody who
// is already paired, and that is precisely the person doing the re-pairing.

const YEAR = 365 * 24 * 60 * 60;
const MONTH = 30 * 24 * 60 * 60;

let passed = 0;
const failures: string[] = [];

function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err: any) {
    failures.push(name);
    console.error(`  FAIL  ${name}\n        ${err?.message || err}`);
  }
}

console.log("\n=== Session TTL + migration ===\n");

// ── Defaults ──

check("device sessions default to a year", () => {
  assert.equal(DEFAULT_SESSION_TTL_SECONDS, YEAR);
  assert.equal(defaultTtlSeconds("device"), YEAR);
});

check("system bearers keep the thirty-day default", () => {
  assert.equal(DEFAULT_SYSTEM_SESSION_TTL_SECONDS, MONTH);
  assert.equal(defaultTtlSeconds("system"), MONTH);
});

// ── The session TTL migration ──

const dir = tmpDir("surface-sessions-");
const dbPath = path.join(dir, "db.sqlite");

interface SeedRow {
  id: string;
  role: string;
  ttl: number;
  expiresSql: string;
  revoked?: boolean;
}

function seed(db: Database.Database, row: SeedRow) {
  db.prepare(
    `INSERT INTO auth_sessions (id, token_hash, role, label, ttl_seconds, created_at, expires_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'), ${row.expiresSql}, ${row.revoked ? "datetime('now')" : "NULL"})`,
  ).run(row.id, `hash-${row.id}`, row.role, row.id, row.ttl);
}

function ttlOf(db: Database.Database, id: string): number {
  return (db.prepare(`SELECT ttl_seconds FROM auth_sessions WHERE id = ?`).get(id) as { ttl_seconds: number }).ttl_seconds;
}

function expiresOf(db: Database.Database, id: string): string {
  return (db.prepare(`SELECT expires_at FROM auth_sessions WHERE id = ?`).get(id) as { expires_at: string }).expires_at;
}

const db = new Database(dbPath);
try {
  // Build the current schema, then wind the version back so the session
  // migration runs again against rows shaped the way a real pre-upgrade
  // database holds them. Found by description: the version number is contested
  // between branches and renumbering it is not a regression.
  const sessionMigration = migrations.find((m) => m.description.startsWith("auth_sessions:"));
  assert.ok(sessionMigration, "session TTL migration not found by description");
  const rewindTo = sessionMigration.version - 1;

  runMigrations(db);
  db.pragma(`user_version = ${rewindTo}`);

  seed(db, { id: "phone", role: "device", ttl: MONTH, expiresSql: `datetime('now', '+10 days')` });
  seed(db, { id: "tablet", role: "device", ttl: MONTH, expiresSql: `datetime('now', '+29 days')` });
  seed(db, { id: "kiosk-short", role: "device", ttl: 3600, expiresSql: `datetime('now', '+30 minutes')` });
  seed(db, { id: "bearer", role: "system", ttl: MONTH, expiresSql: `datetime('now', '+10 days')` });
  seed(db, { id: "revoked-phone", role: "device", ttl: MONTH, expiresSql: `datetime('now', '+10 days')`, revoked: true });
  seed(db, { id: "stale-phone", role: "device", ttl: MONTH, expiresSql: `datetime('now', '-1 day')` });

  const beforeRevoked = expiresOf(db, "revoked-phone");
  const beforeStale = expiresOf(db, "stale-phone");

  runMigrations(db);

  check("live device sessions move to the one-year TTL", () => {
    assert.equal(ttlOf(db, "phone"), YEAR);
    assert.equal(ttlOf(db, "tablet"), YEAR);
  });

  check("migrated devices get the new deadline immediately", () => {
    // Without this the row would keep its old expires_at until something
    // happened to touch it, which for a device left idle over a holiday is
    // exactly never.
    const remainingDays =
      (Date.parse(`${expiresOf(db, "phone")}Z`) - Date.now()) / (24 * 60 * 60 * 1000);
    assert.ok(remainingDays > 360, `expected ~365 days remaining, got ${remainingDays}`);
  });

  check("an explicitly short-lived device session is left alone", () => {
    assert.equal(ttlOf(db, "kiosk-short"), 3600);
  });

  check("system bearers are not extended", () => {
    assert.equal(ttlOf(db, "bearer"), MONTH);
  });

  check("revoked sessions are not resurrected", () => {
    assert.equal(ttlOf(db, "revoked-phone"), MONTH);
    assert.equal(expiresOf(db, "revoked-phone"), beforeRevoked);
  });

  check("already-expired sessions stay expired", () => {
    assert.equal(ttlOf(db, "stale-phone"), MONTH);
    assert.equal(expiresOf(db, "stale-phone"), beforeStale);
  });

  check("the migration is idempotent", () => {
    db.pragma(`user_version = ${rewindTo}`);
    runMigrations(db);
    assert.equal(ttlOf(db, "phone"), YEAR);
    assert.equal(ttlOf(db, "bearer"), MONTH);
    assert.equal(ttlOf(db, "kiosk-short"), 3600);
  });

  // ── Something has to make the request that rolls it ──
  //
  // Rolling expiry only helps a device that keeps asking for things. A wall
  // display asks for nothing: the SSE stream is a single long-lived response
  // that never re-enters the auth middleware, so without a heartbeat the one
  // screen the year-long TTL exists for is the one screen it does not reach.
  // The wire half of this is asserted in test/auth.ts; here we only insist the
  // client still arms the timer.
  // REPO_ROOT, not a path built from import.meta.url: on Windows that URL's
  // `pathname` is `/D:/a/Surface/...`, and joining it produced `D:\D:\a\...`.
  const appJs = fs.readFileSync(path.join(REPO_ROOT, "client", "app.js"), "utf8");
  check("the display heartbeats rather than going silent", () => {
    assert.match(appJs, /setInterval\(reportPresence, PRESENCE_HEARTBEAT_MS\)/);
  });
  check("the heartbeat stays inside the presence staleness window", () => {
    const ms = Number(appJs.match(/PRESENCE_HEARTBEAT_MS = ([\d_]+)/)?.[1].replace(/_/g, ""));
    // PRESENCE_STALE_MS is 60s in server/presence.ts. A heartbeat at or above
    // that window makes every live screen flicker to "stale" between beats.
    assert.ok(ms > 0 && ms <= 30_000, `heartbeat is ${ms}ms`);
  });
} finally {
  db.close();
  try { fs.rmSync(dbPath, { force: true }); } catch {}
  cleanupDir(dir);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const name of failures) console.error(`  FAILED: ${name}`);
  process.exit(1);
}
