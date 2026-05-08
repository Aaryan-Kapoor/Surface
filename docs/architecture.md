# Surface Architecture

Surface is an artifact-backed display system for AI agents. The durable thing the user owns is an artifact; the live thing the PWA shows is a surface view of that artifact.

## Core Model

Surface now separates durable content from presentation/runtime state:

1. **Artifact**: durable user-owned content. It has an ID, title, kind, MIME type, metadata, source type, workspace path, and a pointer to the current version.
2. **Artifact version**: immutable snapshot of an artifact at a point in time.
3. **Artifact file**: one file inside a version, stored under `SURFACE_WORKSPACE_DIR`.
4. **Surface view**: display/card projection of an artifact in the PWA grid.
5. **Sandbox session**: reserved schema for future project/runtime execution.

The old `surfaces` table still exists for migration fallback, but new writes should not use it as the source of truth. New HTML surfaces are created as `text/html` artifacts with an `index.html` file and a `surface_views` row.

## Data Model

The artifact tables are created in `server/artifacts.ts`:

```sql
artifacts(id, title, kind, mime, renderer, source_type, current_version_id, workspace_path, metadata, deleted_at, created_at, updated_at)
artifact_versions(id, artifact_id, parent_version_id, version, reason, created_by, manifest_json, content_hash, created_at)
artifact_files(id, artifact_version_id, path, mime, size_bytes, sha256, storage_kind, storage_path, created_at)
surface_views(id, artifact_id, title, thumbnail_path, metadata, pinned, created_at, updated_at)
sandbox_sessions(id, artifact_id, version_id, provider, status, preview_url, port, metadata, created_at, last_used_at)
```

The legacy table remains in `server/db.ts`:

```sql
surfaces(id, title, html, metadata, created_at, updated_at)
```

That table is now compatibility data only. Routes prefer artifacts first and fall back to legacy rows only when no artifact exists.

## Workspace Layout

Artifacts are stored as files under:

```text
SURFACE_WORKSPACE_DIR=~/surface

~/surface/
  artifacts/
    {artifactId}/
      versions/
        1/
          manifest.json
          files/
            index.html
        2/
          manifest.json
          files/
            index.html
```

Rules:

- Artifact paths are normalized relative paths.
- Absolute paths, drive letters, empty segments, and `..` are rejected.
- Every stored file gets a SHA-256 hash.
- Existing local files are copied into the workspace by default for deterministic presentation.

## HTTP API Shape

Artifact APIs are canonical for durable content:

```text
GET    /artifacts
POST   /artifacts
GET    /artifacts/:id
PUT    /artifacts/:id
DELETE /artifacts/:id
GET    /artifacts/:id/versions
POST   /artifacts/:id/rollback
GET    /artifacts/:id/manifest
GET    /artifacts/:id/view
GET    /artifacts/:id/files/*
POST   /artifacts/present-file
```

Surface APIs are display/runtime APIs:

```text
GET    /surfaces
GET    /surfaces/:id
GET    /surfaces/:id/html
POST   /surfaces/:id/actions
GET    /surfaces/:id/actions
POST   /surfaces/:id/exec
POST   /surfaces/:id/reply
GET    /surfaces/:id/stream
```

Compatibility routes still exist:

```text
POST   /surfaces
PUT    /surfaces/:id
DELETE /surfaces/:id
```

These routes now create, update, or delete backing artifacts when possible. They are kept for old clients and tests, not as the preferred API.

## Rendering

The PWA grid reads `GET /surfaces`, which returns displayable cards from `surface_views` plus any legacy fallback rows.

Full-screen artifact rendering uses:

- `/artifacts/:id/view` for artifact-aware rendering.
- `/artifacts/:id/files/*` for current-version file serving.
- `/surfaces/:id/html` for iframe-compatible HTML loading.

HTML artifacts redirect to their stored HTML file for a real origin. Non-HTML artifacts use a viewer shell for markdown, PDF, images, video/audio, SVG, text/code, and related MIME types.

## MCP Contract

The MCP prompt now treats artifacts as the source of truth:

- Use `artifact_list` / `surface_list` before creating replacements.
- Use `artifact_create` for new standalone content.
- Use `artifact_update` for the same artifact purpose.
- Use `artifact_present_file` for existing local files.
- Use `display_navigate` to open an artifact-backed surface.
- Use `surface_exec`, `surface_actions`, `surface_ack`, and `reply` for live runtime interaction.

The MCP server keeps compatibility handlers for old clients, but it no longer advertises these redundant tools:

- `artifact_open`
- `surface_create`
- `surface_read`
- `surface_update`
- `surface_delete`

## Current Boundaries

Implemented:

- Artifact tables and workspace storage.
- Immutable artifact versions.
- File-backed render routes.
- Artifact-backed surface cards.
- Surface action, reply, exec, SSE, display navigation, notifications, and theming.
- Compatibility `/surfaces` routes backed by artifacts.
- Marketplace surface installs backed by artifacts.

Still future work:

- Eager migration or removal of old `surfaces` rows.
- Thumbnail capture/cache by artifact version.
- Project artifact manifests beyond the schema.
- Local or remote sandbox providers.
- Git backup of `SURFACE_WORKSPACE_DIR`.

## Design Direction

The target architecture is:

- SQLite is the index.
- Workspace files are the durable artifact payload.
- Artifacts own content and history.
- Surface views own display/card state.
- Runtime actions belong to surfaces.
- Sandboxes are provider-backed sessions for project artifacts, not the foundation for simple files.

This keeps simple artifacts deterministic while leaving room for richer app/project execution later.
