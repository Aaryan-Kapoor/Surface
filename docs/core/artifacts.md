# Artifact Data Model

**Status:** Shipped (2026-06)
**Code:** `server/db.ts`, `server/migrations.ts`, `server/artifacts.ts`, `server/paths.ts`

Everything an agent pushes to Surface is an **artifact**: a titled thing with one or more files and a linear version history. Dashboard cards are derived straight from the `artifacts` table (`listArtifactCards`, `server/artifacts.ts`) — there is no separate card table. This document describes the SQLite schema, the on-disk layout, and the column semantics. All schema lives in a single fresh-start baseline migration, **v10** (`server/migrations.ts`); it is created idempotently with `CREATE TABLE IF NOT EXISTS` and versioned through `PRAGMA user_version`. Future schema changes add v11+ entries that ALTER this baseline; v10 itself is never edited.

## Tables

### `artifacts`
The root record (`server/migrations.ts`, type in `server/artifacts.ts`).

| Column | Notes |
| --- | --- |
| `id` | UUID (or caller-supplied id). |
| `title` | Required. |
| `kind` | `file` \| `html` \| `project` \| `external` (`ArtifactKind`). Inferred as `html` when mime is `text/html`, else `file` (`createArtifact`). |
| `mime` | Inferred from the first file's extension via `MIME_BY_EXT` / `inferMime` (`server/artifacts.ts`). |
| `source_type` | `generated` \| `presented_file` \| `imported_url` \| `project` \| `linked` (`ArtifactSourceType`). Drives behavior — `linked` blocks PUT/rollback. |
| `template` | The template this artifact was instantiated from (`ask`, `stream`, `board`, …), or NULL. Drives re-render-on-update and template-specific server behavior (e.g. the `ask` answered flip). |
| `project_root` | The owning project — the git root stamped by the CLI on every create/link/present (see [../auth/project-ownership.md](../auth/project-ownership.md)). Nullable; indexed for `--project` filtering. |
| `current_version_id` | Points at the active `artifact_versions` row. |
| `workspace_path` | For workspace artifacts: `~/.surface/artifacts/<id>`. For linked artifacts: the real on-disk directory being served. |
| `metadata` | JSON string. Common keys: `icon`, `description`, `original_path`, `linked`, `hidden`, `demo`, `agent`, `template_params`, `display_role`. |
| `deleted_at` | Soft-delete timestamp. `getArtifact` filters `deleted_at IS NULL`. |
| `created_at` / `updated_at` | `datetime('now')`. |

Soft delete: `deleteArtifact` sets `deleted_at` and clears the artifact's `surface_actions`, `surface_state`, `surface_bindings`, and `surface_stream_chunks` rows (`server/artifacts.ts`). A re-create with the same id recycles a soft-deleted row inside the create transaction.

### `artifact_versions`
Linear, append-only version chain.

- `version` is a monotonically increasing integer per artifact, `UNIQUE(artifact_id, version)`; the next number is `max(version)+1`.
- `parent_version_id` references the prior version (a chain, never a tree).
- `manifest_json` is the full file list `{artifact_id, version, files:[{path,mime,size_bytes,sha256}]}`; also written to disk as `manifest.json`.
- `content_hash` is a SHA-256 over the sorted `path:sha256` lines of the version's files.
- `reason` records why the version was made (`artifact_create`, `artifact_update`, `template_instantiate`, `template_rerender`, `present_file`, `link`, …). Authorship rides `metadata.agent` on the artifact, not a column.
- `ON DELETE CASCADE` from `artifacts`.

Rollback (`setCurrentArtifactVersion`, `server/artifacts.ts`) just repoints `current_version_id` at an existing version row — it does not create a new version.

### `artifact_files`
One row per file in a version.

- `path` is the normalized artifact-relative path, `UNIQUE(artifact_version_id, path)`.
- `storage_kind` is `workspace` (file copied into the version dir) or `external` (file lives on disk outside Surface, used by linked artifacts).
- `storage_path` is the absolute path actually read (`readArtifactFileContent`, `server/artifacts.ts`).
- `sha256`, `size_bytes`, `mime` describe the bytes at link/write time.
- `ON DELETE CASCADE` from `artifact_versions`.

### `surface_actions`
User → agent action queue. Each row is `{id, surface_id, action, data (JSON), status, created_at, handled_at}`. `status` is `pending` until `ackAction` flips it to `handled` and stamps `handled_at`; a TTL sweep deletes `handled` rows after 7 days and `pending` rows after 30 (`cleanupActions`, `server/db.ts`). See [../interaction/actions-inbox.md](../interaction/actions-inbox.md).

### `surface_state`
One JSON state document per surface (`artifact_id` PK, `state_json`, `state_version`, `updated_at`). `state_version` bumps on every patch; `ON DELETE CASCADE` from `artifacts`. See [../state/stateful-surfaces.md](../state/stateful-surfaces.md).

### `surface_stream_chunks`
Append-only chunks for [`stream`](../templates/stream.md) surfaces: `(artifact_id, seq)` PK, `kind` (`text` | `md`), `content`, `created_at`. Capped as a ring buffer (default 2000 chunks per surface; `server/streams.ts`).

### `surface_bindings`
Pre-registered command/webhook reactions to actions: `{id, surface_id, action_pattern, kind, run, webhook_url, cwd, enabled, timeout_seconds, last_run_at, last_status, last_error, created_at, updated_at}`. See [../interaction/bindings.md](../interaction/bindings.md).

### `display_config`
Single-row key/value store. Only the `theme` key is used; it holds the merged display theme JSON blob (`getDisplayConfig`/`setDisplayConfig`, `server/db.ts`). The renderer/home/overlay slots are **not** stored here — they are ordinary artifacts carrying `metadata.display_role` (see [../display/theming.md](../display/theming.md)).

### `auth_pairing_tokens` / `auth_sessions`
Hashed one-time pairing tokens (role defaults to `device`) and durable sessions (`role`, `label`, `ttl_seconds`, rolling `expires_at`, `last_seen_at`, `revoked_at`). See [../auth/device-pairing.md](../auth/device-pairing.md).

### Removed in the fresh-start baseline
The pre-baseline tables and columns — the legacy `surfaces` table, `surface_views`, `sandbox_sessions`, `artifacts.renderer`, `artifact_versions.created_by`, and the vestigial `thumbnail_path`/`pinned` columns — do not exist in v10. There is no compat layer and no row migration: a pre-baseline database is archived to `db.sqlite.bak` at boot, never migrated (`isPreBaseline`, `server/migrations.ts`; `archivePreBaselineDb`, `server/db.ts`), and agents re-link/re-create their surfaces.

## Filesystem layout

Data dir defaults to `~/.surface/` (override `SURFACE_DATA_DIR`; `server/paths.ts`).

```
~/.surface/
  db.sqlite                              # SQLite (WAL mode)
  db.sqlite.bak                          # archived pre-baseline DB, if one existed
  auth-secret                            # token-hash salt, mode 0600
  install-state.json                     # agent install/tutorial state (see ../operations/install.md)
  logs/bindings/                         # captured stdout/stderr per binding run
  templates/                             # user-level templates
  thumbs/<artifact-id>.png               # screenshot cache (see thumbnails.md)
  artifacts/<artifact-id>/
    versions/<n>/
      manifest.json
      files/<artifact-relative-path>     # workspace-stored bytes
```

Workspace files are written under `files/` with a containment check so an artifact path can never escape the version dir (`server/artifacts.ts`). Linked (`external`) artifacts store **no bytes here** — their `storage_path` points at the real source file (see [linked-artifacts.md](linked-artifacts.md)).

## The fresh start, for the record

The old dual `surfaces` (legacy) / `artifacts` model was collapsed into this single artifact-first model in 2026-06, as a fresh start rather than a row migration: one baseline migration creates everything (including the state/bindings/chunks tables up front, so no inter-phase migrations were needed), and pre-baseline DBs are archived at boot. The decision record lives in [../roadmap.md](../roadmap.md).

## Related
- [linked-artifacts.md](linked-artifacts.md) — external/linked artifacts and the touch workflow
- [thumbnails.md](thumbnails.md) — screenshot pipeline and the `thumbs/` cache
- [http-api.md](http-api.md) — artifact CRUD routes
- [../interaction/actions-inbox.md](../interaction/actions-inbox.md) — `surface_actions`
- [../roadmap.md](../roadmap.md) — the schema-collapse decision record
