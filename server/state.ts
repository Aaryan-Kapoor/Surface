import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

// One JSON state document per surface (docs/state/stateful-surfaces.md).
// Values live here — never in the repo. Definitions (which keys exist,
// defaults) belong to .surface/ manifests; this store is schema-less so
// undeclared keys stay cheap.

export interface SurfaceState {
  artifact_id: string;
  state: Record<string, unknown>;
  state_version: number;
  updated_at: string | null;
}

export function getState(db: Database.Database, artifactId: string): SurfaceState {
  const row = db
    .prepare(`SELECT state_json, state_version, updated_at FROM surface_state WHERE artifact_id = ?`)
    .get(artifactId) as { state_json: string; state_version: number; updated_at: string } | undefined;
  if (!row) return { artifact_id: artifactId, state: {}, state_version: 0, updated_at: null };
  let state: Record<string, unknown> = {};
  try { state = JSON.parse(row.state_json); } catch {}
  return { artifact_id: artifactId, state, state_version: row.state_version, updated_at: row.updated_at };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Deep-merge `patch` into `base`. Objects merge recursively; arrays and
// scalars replace; an explicit null deletes the key.
export function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (value === null) {
      delete out[key];
    } else if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key] as Record<string, unknown>, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

// Expand a dotted key ("tests.passed") into a nested single-key patch.
export function dottedPatch(key: string, value: unknown): Record<string, unknown> {
  const parts = key.split(".").filter(Boolean);
  if (parts.length === 0) throw new Error("state key is required");
  let patch: unknown = value;
  for (let i = parts.length - 1; i >= 0; i--) {
    patch = { [parts[i]]: patch };
  }
  return patch as Record<string, unknown>;
}

export function patchState(
  db: Database.Database,
  artifactId: string,
  patch: Record<string, unknown>,
): SurfaceState {
  if (!isPlainObject(patch)) throw new Error("state patch must be a JSON object");
  const tx = db.transaction(() => {
    const current = getState(db, artifactId);
    const next = deepMerge(current.state, patch);
    db.prepare(
      `INSERT INTO surface_state (artifact_id, state_json, state_version, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(artifact_id) DO UPDATE SET
         state_json = excluded.state_json,
         state_version = excluded.state_version,
         updated_at = excluded.updated_at`,
    ).run(artifactId, JSON.stringify(next), current.state_version + 1);
  });
  tx();
  return getState(db, artifactId);
}

// The tail of a conversation kept in state. Long enough that nobody scrolls
// off the top of a session, short enough that a surface's state document stays
// something you can read.
const THREAD_LIMIT = 200;

/**
 * Read an array-valued state key and return it with one entry appended.
 *
 * `patchState` deep-merges, which means arrays *replace* — so appending is a
 * read-modify-write, and doing it in the caller invites two of them racing. It
 * lives here, next to the store, and the caller passes the result straight back
 * into the same patch.
 */
export function appendToStateList(
  db: Database.Database,
  artifactId: string,
  key: string,
  entry: Record<string, unknown>,
  limit = THREAD_LIMIT,
): Array<Record<string, unknown>> {
  const current = getState(db, artifactId).state[key];
  const list = Array.isArray(current) ? (current as Array<Record<string, unknown>>) : [];
  const next = [...list, { id: randomUUID(), at: new Date().toISOString(), ...entry }];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

// Replace the whole document (used by surface sync applying manifest defaults
// to a brand-new surface — never to one that already has live values).
export function setStateIfEmpty(
  db: Database.Database,
  artifactId: string,
  defaults: Record<string, unknown>,
): boolean {
  const current = getState(db, artifactId);
  if (current.state_version > 0 || Object.keys(current.state).length > 0) return false;
  patchState(db, artifactId, defaults);
  return true;
}
