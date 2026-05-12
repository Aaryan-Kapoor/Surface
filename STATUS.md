# Surface Status

Branch: `feature/artifact-architecture`

## Done

- Made artifacts the canonical content model.
- Added SQLite tables for artifacts, versions, files, surface views, and sandbox sessions.
- Added workspace file storage under `SURFACE_WORKSPACE_DIR` / `~/surface`.
- Added artifact HTTP APIs: create, update, delete, present file, read, versions, rollback, view, and file serving.
- Changed `/surfaces` create/update/delete compatibility routes to operate on backing artifacts.
- Kept legacy `surfaces` rows as read fallback only.
- Hid redundant MCP compatibility tools from `ListTools`; artifact tools are now the advertised create/update path.
- Updated MCP prompts to point agents at `artifact_create`, `artifact_update`, and `artifact_present_file`.
- Documented Surface as a long-running Linux user service with MCP as a connector.
- Added `scripts/install-systemd-user-service.sh` and `npm run service`.
- Added `INSTALL_FOR_AGENTS.md` with service-detection and permission-before-setup flow.
- Updated the PWA to render artifact-backed cards and full-screen views.
- Added MIME badges, artifact preview/view routing, and artifact live reload via SSE.
- Added `npm run test:artifacts`.
- Updated `docs/architecture.md`.

## Verified

- `npx tsc --noEmit` passes.
- `npm run test:artifacts` passes.
- Linux service docs and helper are committed on this branch.
- In-process HTTP check passes for `/surfaces` creating/updating artifact versions and serving current HTML.
- Browser DOM check confirmed the grid renders with the artifact-backed test card and no console errors.

## Notes

- Project/container sandbox execution is schema-only for now.
- Legacy `surfaces` table removal is future migration work.
- `.mcp.json` remains local machine config and is not committed.
