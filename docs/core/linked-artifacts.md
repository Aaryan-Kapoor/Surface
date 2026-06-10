# Linked Artifacts

**Status:** Shipped
**Code:** `server/artifacts.ts` (`linkArtifact`, `touchArtifact`, `isLinkedArtifact`), `server/routes.ts` (`POST /artifacts/link`, `POST /artifacts/:id/touch`, the `/artifacts/:id/files/*` linked fallback)

A **linked artifact** registers a file or directory that lives on disk *outside* Surface and serves it live, rather than copying bytes into the workspace. This is how an agent shows a file it is actively editing: edit on disk, run `surface touch <id>`, and the open surface hot-reloads. Linked artifacts are git-friendly — git is the source of truth, so Surface keeps no version history for them.

## Usage

Created only through `POST /artifacts/link` (the generic `POST /artifacts` rejects `source_type: "linked"`, `server/routes.ts:512-515`):

```bash
# single file
surface link /abs/path/to/report.html --title "Report"

# directory (entry file required)
surface link /abs/path/to/site --entry index.html --title "Site"

# after editing report.html on disk, hot-reload the open surface
surface touch <id>
```

`metadata.linked: true` and `metadata.original_path` are recorded so the dashboard and `seed-demos` can recognize linked rows.

## Behavior

### Single-file vs directory links (`server/artifacts.ts:472-503`)
- **File:** `workspace_path` = the file's parent directory; the file's basename is the entry. Only that one file is pre-registered in `artifact_files`, but the whole sibling directory is reachable via the file-serving fallback (below).
- **Directory:** `--entry` is **required** and must resolve to a file inside the root. `workspace_path` = the directory.

The entry's bytes are read once at link time to compute `mime`, `size_bytes`, and `sha256`, and a single `artifact_files` row is written with `storage_kind = "external"` and `storage_path` = the real absolute entry path (`server/artifacts.ts:540-543`). The version `manifest_json` records `linked: true`.

### Live re-serving from disk
Because `storage_kind` is `external`, `readArtifactFileContent` reads `storage_path` directly off disk on every request (`server/artifacts.ts:418-423`) — the registered entry always reflects the current file contents. Files *other than* the registered entry (e.g. a directory's CSS/JS assets) are served by the **linked fallback** in the `/artifacts/:id/files/*` route (`server/routes.ts:746-788`): when no `artifact_files` row matches, and the artifact is linked, the path is resolved under `workspace_path` and streamed from disk.

### Hot reload via touch (`touchArtifact`, `server/artifacts.ts:555-561`)
`POST /artifacts/:id/touch` bumps `updated_at` on the artifact and its surface view, then broadcasts `surface_updated` with `reload: true` both globally and to the surface stream (`server/routes.ts:487-504`). The open PWA surface re-requests the iframe with a cache-busting `?v=` and the file is re-read from disk. No new version is created. A thumbnail re-capture is enqueued.

### Immutable version chain
Linked artifacts have exactly one version and no history:
- `POST /artifacts/:id/rollback` returns **409** for linked artifacts (`server/routes.ts:564-568`): *"Linked artifacts have no version history; git is the source of truth."*
- `PUT /artifacts/:id` with new file content returns **409** when the target is linked (`server/routes.ts:594-600`): *"Linked artifacts are edited on disk. Use POST /artifacts/:id/touch after editing."* (A metadata-only PUT — no `files`/`content` — is still allowed, which is how `clear-demos`/`seed-demos` toggle `metadata.hidden`.)

## Security notes

### Path normalization (`normalizeArtifactPath`, `server/artifacts.ts:109-119`)
Rejects absolute paths, drive-letter paths, empty segments, and any `.`/`..` segment. Applied to directory entries and to every path requested through the file-serving fallback (`server/routes.ts:749-753`).

### Symlink escape protection
Symlinks are resolved with `fs.realpathSync` and re-checked for containment at multiple points so a symlink can't smuggle a target out of bounds:
- **At link time:** the linked path is realpath-resolved before any containment check (`server/artifacts.ts:446-451`); a directory's entry is verified both as a resolved path and re-verified against its realpath (`server/artifacts.ts:483-498`).
- **At read time:** the fallback route realpaths both the requested file and the root and re-checks containment, returning **403** on escape (`server/routes.ts:767-782`).

### `SURFACE_LINK_ROOTS` narrowing (`server/artifacts.ts:453-470`)
When set (a `:`-separated list of directories), the realpath of the linked path must be equal to, or under, one of the (realpath-resolved) allowed roots, else linking is rejected with *"… is not under any SURFACE_LINK_ROOTS root"*. Unset means no narrowing — any readable path may be linked (loopback-trusted single-user assumption). See [../operations/security.md](../operations/security.md).

## Related
- [artifacts.md](artifacts.md) — the underlying tables and `storage_kind`
- [http-api.md](http-api.md) — link/touch/files routes
- [cli.md](cli.md) — `surface link` / `surface touch`
- [events.md](events.md) — the `surface_updated` reload event
- [../state/stateful-surfaces.md](../state/stateful-surfaces.md) — live editing workflow
- [../operations/security.md](../operations/security.md) — `SURFACE_LINK_ROOTS`
