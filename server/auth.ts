import crypto from "crypto";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getDb } from "./db.js";
import { getDataDir } from "./paths.js";

// ── Server secret ──
// Persisted under the Surface data dir at 0600. Used only to salt token hashes
// so a leaked DB (see SECURITY.md) does not directly yield usable credentials.

const SECRET_FILE = "auth-secret";
const SESSION_TOUCH_INTERVAL_SECONDS = 5 * 60;
let secretCache: string | null = null;

export function getServerSecret(): string {
  if (secretCache) return secretCache;
  const file = path.join(getDataDir(), SECRET_FILE);
  try {
    secretCache = fs.readFileSync(file, "utf8").trim();
    if (secretCache) return secretCache;
  } catch {
    // fall through to create
  }
  const secret = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, secret, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best-effort on platforms without chmod
  }
  secretCache = secret;
  return secret;
}

function hashToken(token: string): string {
  return crypto
    .createHash("sha256")
    .update(`${getServerSecret()}:${token}`)
    .digest("hex");
}

// ── Token generation ──

// Crockford-ish alphabet without easily confused glyphs (0/O, 1/I/L).
const PAIRING_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export function generatePairingCredential(length = 12): string {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += PAIRING_ALPHABET[bytes[i] % PAIRING_ALPHABET.length];
  }
  return out;
}

export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

// Two planes (docs/auth/trust-model.md): `system` is the agent plane — loopback
// or an explicitly minted system bearer; full power. `device` is a paired
// display — view/click only, enforced per-route.
export type Role = "system" | "device";

export const SESSION_COOKIE = "surface_session";
export const DEFAULT_PAIRING_TTL_SECONDS = 5 * 60;
export const DEFAULT_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export function readCookie(header: string | undefined, name: string): string {
  const match = (header || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : "";
}

// ── Pairing tokens ──

export interface PairingTokenSummary {
  id: string;
  label: string | null;
  role: Role;
  created_at: string;
  expires_at: string;
}

export interface CreatedPairingToken {
  id: string;
  credential: string;
  role: Role;
  label: string | null;
  expiresAt: string;
}

export function createPairingToken(params: {
  label?: string | null;
  role?: Role;
  ttlSeconds?: number;
} = {}): CreatedPairingToken {
  const id = uuidv4();
  const credential = generatePairingCredential();
  // Pairing is how displays join — tokens mint device sessions. System
  // bearers are issued directly via createSession from the system plane.
  const role: Role = params.role === "system" ? "system" : "device";
  const label = params.label ?? null;
  const ttl = params.ttlSeconds && params.ttlSeconds > 0 ? params.ttlSeconds : DEFAULT_PAIRING_TTL_SECONDS;
  getDb()
    .prepare(
      `INSERT INTO auth_pairing_tokens (id, token_hash, label, role, expires_at)
       VALUES (?, ?, ?, ?, datetime('now', '+' || ? || ' seconds'))`,
    )
    .run(id, hashToken(credential), label, role, ttl);
  const row = getDb()
    .prepare(`SELECT expires_at FROM auth_pairing_tokens WHERE id = ?`)
    .get(id) as { expires_at: string };
  return { id, credential, role, label, expiresAt: row.expires_at };
}

export function listPairingTokens(): PairingTokenSummary[] {
  return getDb()
    .prepare(
      `SELECT id, label, role, created_at, expires_at
       FROM auth_pairing_tokens
       WHERE revoked_at IS NULL
         AND consumed_at IS NULL
         AND expires_at > datetime('now')
       ORDER BY created_at DESC`,
    )
    .all() as PairingTokenSummary[];
}

export function revokePairingToken(id: string): boolean {
  const result = getDb()
    .prepare(
      `UPDATE auth_pairing_tokens
       SET revoked_at = datetime('now')
       WHERE id = ? AND revoked_at IS NULL`,
    )
    .run(id);
  return result.changes > 0;
}

// Atomically consume an active pairing token. Returns the consumed row or null
// if the token is unknown, already used, revoked, or expired. The single
// UPDATE ... RETURNING guarantees a token can only ever be consumed once even
// under concurrent bootstrap attempts.
export function consumePairingToken(
  credential: string,
): { id: string; role: Role; label: string | null } | null {
  const row = getDb()
    .prepare(
      `UPDATE auth_pairing_tokens
       SET consumed_at = datetime('now')
       WHERE token_hash = ?
         AND revoked_at IS NULL
         AND consumed_at IS NULL
         AND expires_at > datetime('now')
       RETURNING id, role, label`,
    )
    .get(hashToken(credential)) as { id: string; role: Role; label: string | null } | undefined;
  return row ?? null;
}

// ── Sessions ──

export interface SessionRow {
  id: string;
  role: Role;
  label: string | null;
  client_ip: string | null;
  user_agent: string | null;
  ttl_seconds: number;
  created_at: string;
  expires_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

export interface CreatedSession {
  id: string;
  token: string;
  role: Role;
  expiresAt: string;
}

export function createSession(params: {
  role?: Role;
  label?: string | null;
  clientIp?: string | null;
  userAgent?: string | null;
  ttlSeconds?: number;
}): CreatedSession {
  const id = uuidv4();
  const token = generateSessionToken();
  const role: Role = params.role === "system" ? "system" : "device";
  const ttl = params.ttlSeconds && params.ttlSeconds > 0 ? params.ttlSeconds : DEFAULT_SESSION_TTL_SECONDS;
  getDb()
    .prepare(
      `INSERT INTO auth_sessions (id, token_hash, role, label, client_ip, user_agent, ttl_seconds, last_seen_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now', '+' || ? || ' seconds'))`,
    )
    .run(
      id,
      hashToken(token),
      role,
      params.label ?? null,
      params.clientIp ?? null,
      params.userAgent ?? null,
      ttl,
      ttl,
    );
  const row = getDb()
    .prepare(`SELECT expires_at FROM auth_sessions WHERE id = ?`)
    .get(id) as { expires_at: string };
  return { id, token, role, expiresAt: row.expires_at };
}

// Verify a session token. Returns the live session row or null when the token
// is unknown, expired, or revoked. Expiry is rolling: every successful use
// pushes expires_at out by the session's own ttl_seconds, so an active device
// never falls off while an abandoned one ages out.
export function verifySession(token: string): SessionRow | null {
  if (!token) return null;
  const row = getDb()
    .prepare(
      `SELECT * FROM auth_sessions
       WHERE token_hash = ?
         AND revoked_at IS NULL
         AND expires_at > datetime('now')`,
    )
    .get(hashToken(token)) as SessionRow | undefined;
  if (!row) return null;
  const shouldTouch = !row.last_seen_at ||
    Date.now() - Date.parse(`${row.last_seen_at}Z`) >= SESSION_TOUCH_INTERVAL_SECONDS * 1000;
  if (shouldTouch) {
    getDb()
      .prepare(
        `UPDATE auth_sessions
         SET last_seen_at = datetime('now'),
             expires_at = datetime('now', '+' || ttl_seconds || ' seconds')
         WHERE id = ?`,
      )
      .run(row.id);
  }
  return row;
}

export function getSessionById(id: string): Omit<SessionRow, "revoked_at"> | null {
  const row = getDb()
    .prepare(
      `SELECT id, role, label, client_ip, user_agent, ttl_seconds, created_at, expires_at, last_seen_at
       FROM auth_sessions
       WHERE id = ? AND revoked_at IS NULL AND expires_at > datetime('now')`,
    )
    .get(id) as Omit<SessionRow, "revoked_at"> | undefined;
  return row ?? null;
}

export function listSessions(opts?: { role?: Role }): Omit<SessionRow, "revoked_at">[] {
  const where = ["revoked_at IS NULL", "expires_at > datetime('now')"];
  const params: unknown[] = [];
  if (opts?.role) {
    where.push("role = ?");
    params.push(opts.role);
  }
  return getDb()
    .prepare(
      `SELECT id, role, label, client_ip, user_agent, ttl_seconds, created_at, expires_at, last_seen_at
       FROM auth_sessions
       WHERE ${where.join(" AND ")}
       ORDER BY created_at DESC`,
    )
    .all(...params) as Omit<SessionRow, "revoked_at">[];
}

export function revokeSession(id: string): boolean {
  const result = getDb()
    .prepare(
      `UPDATE auth_sessions
       SET revoked_at = datetime('now')
       WHERE id = ? AND revoked_at IS NULL`,
    )
    .run(id);
  return result.changes > 0;
}

export function revokeSessionByToken(token: string): boolean {
  if (!token) return false;
  const result = getDb()
    .prepare(
      `UPDATE auth_sessions
       SET revoked_at = datetime('now')
       WHERE token_hash = ? AND revoked_at IS NULL`,
    )
    .run(hashToken(token));
  return result.changes > 0;
}
