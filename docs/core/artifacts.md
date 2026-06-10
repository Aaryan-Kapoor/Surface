# Artifact Data Model

**Status:** Shipped
**Code:** `server/db.ts`, `server/migrations.ts`, `server/artifacts.ts`, `server/paths.ts`

Everything an agent pushes to Surface is an **artifact**: a titled thing with one or more files and a linear version history. A denormalized **surface view** row turns each artifact into a card on the dashboard. This document describes the SQLite schema, the on-disk layout, and which columns are currently load-bearing versus vestigial. All schema lives in migration v1 (`server/migrations.ts:17-117`); it is created idempotently with `CREATE TABLE IF NOT EXISTS` and bumped through `PRAGMA user_version`.

## Tables

### `artifacts`
The root record (`server/migrations.ts:31-44`, type at `server/artifacts.ts:12-25`).

| Column | Notes |
| --- | --- |
| `id` | UUID (or caller-supplied id). |
| `title` | Required. |
| `kind` | `file` \| `html` \| `project` \| `external` (`ArtifactKind`). Inferred as `html` when mime is `text/html`, else `file` (`createArtifact`, `server/artifacts.ts:275`). |
| `mime` | Inferred from the first file's extension via `MIME_BY_EXT` / `inferMime` (`server/artifacts.ts:72-107`). |
| `renderer` | Optional renderer hint; rarely set. |
| `source_type` | `generated` \| `presented_file` \| `imported_url` \| `project` \| `linked` (`ArtifactSourceType`). Drives behavior — `linked` blocks PUT/rollback. |
| `current_version_id` | Points at the active `artifact_versions` row. |
| `workspace_path` | For workspace artifacts: `~/.surface/artifacts/<id>`. For linked artifacts: the real on-disk directory being served. |
| `metadata` | JSON string. Common keys: `icon`, `description`, `original_path`, `linked`, `hidden`, `demo`. |
| `deleted_at` | Soft-delete timestamp. `getArtifact` filters `deleted_at IS NULL` (`server/artifacts.ts:122`). |
| `created_at` / `updated_at` | `datetime('now')`. |

Soft delete: `deleteArtifact` sets `deleted_at`, removes the `surface_views` row, and clears pending `surface_actions` (`server/artifacts.ts:372-380`). A re-create with the same id recycles a soft-deleted row inside the create transaction (`server/artifacts.ts:283-291`).

### `artifact_versions`
Linear, append-only version chain (`server/migrations.ts:46-59`).

- `version` is a monotonically increasing integer per artifact, `UNIQUE(artifact_id, version)`; the next number is `max(version)+1` (`server/artifacts.ts:573`).
- `parent_version_id` references the prior version (a chain, never a tree).
- `manifest_json` is the full file list `{artifact_id, version, files:[{path,mime,size_bytes,sha256}]}`; also written to disk as `manifest.json` (`server/artifacts.ts:608-613`).
- `content_hash` is a SHA-256 over the sorted `path:sha256` lines of the version's files (`server/artifacts.ts:604-607`).
- `reason` records why the version was made (`artifact_create`, `surface_update_compat`, `present_file`, `link`, …) and `created_by` is an optional author tag.
- `ON DELETE CASCADE` from `artifacts`.

Rollback (`setCurrentArtifactVersion`, `server/artifacts.ts:146-161`) just repoints `current_version_id` at an existing version row — it does not create a new version.

### `artifact_files`
One row per file in a version (`server/migrations.ts:61-73`).

- `path` is the normalized artifact-relative path, `UNIQUE(artifact_version_id, path)`.
- `storage_kind` is `workspace` (file copied into the version dir) or `external` (file lives on disk outside Surface, used by linked artifacts).
- `storage_path` is the absolute path actually read (`readArtifactFileContent`, `server/artifacts.ts:418-423`).
- `sha256`, `size_bytes`, `mime` describe the bytes at link/write time.
- `ON DELETE CASCADE` from `artifact_versions`.

### `surface_views`
Denormalized card layer the dashboard lists from (`server/migrations.ts:75-85`). Holds a copy of `title` and `metadata` so `listArtifactCards` (`server/artifacts.ts:189-237`) can render cards with one join. Created alongside the artifact unless `create_surface_view === false`. `updated_at` is bumped on every artifact change and is what the PWA uses for thumbnail cache-busting.

> The `thumbnail_path` and `pinned` columns on `surface_views` are **vestigial** — never written or read by current code. Thumbnails are stored on disk under `~/.surface/thumbs/` (see [thumbnails.md](thumbnails.md)), not via this column.

### `surface_actions`
User → agent action queue (`server/migrations.ts:102-109`). Each row is `{id, surface_id, action, data (JSON), status, created_at}`. `status` is `pending` until `ackAction` flips it to `handled`. See [../interaction/actions-inbox.md](../interaction/actions-inbox.md). A one-time idempotent fixup (`dropLegacySurfaceActionsForeignKey`, `server/migrations.ts:172-190`) strips a legacy foreign key that pointed at the old `surfaces` table.

### `display_config`
Single-row key/value store. Only the `theme` key is used; it holds the merged display theme/home/overlay/renderer JSON blob (`getDisplayConfig`/`setDisplayConfig`, `server/db.ts:96-111`). See [../display/theming.md](../display/theming.md).

### Legacy `surfaces` table (fallback only)
The original pre-artifact table `{id, title, html, metadata}` (`server/migrations.ts:22-29`). It is **read-only**: no route inserts into it. `getSurface`/`deleteSurface` (`server/db.ts:35-50`) exist only so old rows still render and can be cleaned up. `listArtifactCards` unions in legacy rows that lack a `surface_views` mirror (`server/artifacts.ts:216-223`), and several routes fall back to it when an artifact lookup misses.

### Vestigial: `sandbox_sessions`
Defined in v1 (`server/migrations.ts:87-100`) for a future hosted-preview/sandbox feature. **No code reads or writes it today.**

## Filesystem layout

Data dir defaults to `~/.surface/` (override `SURFACE_DATA_DIR`; `server/paths.ts:14-22`). On boot, a legacy DB at `<repo>/surfaces.db` and a legacy workspace at `~/surface/artifacts` are migrated in if present (`bootstrapDataDir`, `server/paths.ts:37-61`).

```
~/.surface/
  db.sqlite                              # SQLite (WAL mode)
  thumbs/<artifact-id>.png               # screenshot cache (see thumbnails.md)
  artifacts/<artifact-id>/
    versions/<n>/
      manifest.json
      files/<artifact-relative-path>     # workspace-stored bytes
```

Workspace files are written under `files/` with a containment check so an artifact path can never escape the version dir (`server/artifacts.ts:584-589`). Linked (`external`) artifacts store **no bytes here** — their `storage_path` points at the real source file (see [linked-artifacts.md](linked-artifacts.md)).

## Planned changes

The dual `surfaces` (legacy) / `artifacts` model is slated to be collapsed into a single artifact-first model, retiring the legacy table and the unused `sandbox_sessions`, `thumbnail_path`, and `pinned` columns. See [../roadmap.md](../roadmap.md) for the spec.

## Related
- [linked-artifacts.md](linked-artifacts.md) — external/linked artifacts and the touch workflow
- [thumbnails.md](thumbnails.md) — screenshot pipeline and the `thumbs/` cache
- [http-api.md](http-api.md) — artifact CRUD routes
- [../interaction/actions-inbox.md](../interaction/actions-inbox.md) — `surface_actions`
- [../roadmap.md](../roadmap.md) — planned schema collapse
