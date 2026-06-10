# Surface Status

Branch: `feature/artifact-architecture`

## The 2026-06 rebuild (phases 1–4 of `docs/roadmap.md`)

All four roadmap phases are implemented on this branch. Each feature has a spec under `docs/`; this is the one-screen summary.

### Phase 1 — Foundation
- **Fresh-start schema**: one baseline migration (artifact-first; no legacy `surfaces`/`surface_views`/`sandbox_sessions`), with `surface_state`, `surface_bindings`, and `surface_stream_chunks` created up front. A pre-baseline `~/.surface/db.sqlite` is archived to `db.sqlite.bak` at boot — not migrated.
- **Artifacts-only API**: `/surfaces/*` is gone; actions/reply/exec/stream live under `/artifacts/:id/…`; `GET /artifacts` returns full card payloads (one fetch renders the grid).
- **Two-plane trust model**: loopback = `system` (agents, full power); paired displays = `device` (view/click/workspace-CRUD/display control only). `SURFACE_TOKEN` removed; remote agents carry `SURFACE_SESSION` bearers minted via `surface auth session issue --role system`.
- **Project ownership**: every create/link/present stamps `project_root` from the caller's git root; `--agent` is self-reported attribution in `metadata.agent`.
- **Devices**: named at pair time, listed/revoked via `surface devices`, rolling session expiry, per-device presence, and `--on <device>` targeting for open/notify.
- Router split: `server/routes/{auth,artifacts,actions,display,integrations}.ts`.

### Phase 2 — State & Templates
- **Stateful surfaces**: one versioned JSON doc per surface (`surface set/patch/state`), `state_patch` SSE, and the injected `surface.js` runtime (`data-surface-bind`, `data-surface-show`, `Surface.action/onState/onEvent`).
- **Template engine**: project `.surface/templates` → `~/.surface/templates` → built-in; `{{param}}` escaped / `{{{param}}}` raw / markdown params server-rendered; `--template/--param`; re-render with the same id is an idempotent no-op when output is unchanged.
- **Built-ins**: `ask` (context-full questions; server flips answered state), `stream` (+ `surface append`, ANSI/markdown chunks, ring buffer), `video` (youtube-nocookie), `board` (global `board` id materializes on first write; per-section staleness), `doc` (linked repo markdown rendered with TOC + touch reload).
- **Project directory**: `surface init` scaffolds `.surface/` + `SURFACE.md` (incl. the `bindings.enabled` consent slot); `surface sync` reconciles manifests idempotently; `surface sync --export` promotes ad-hoc surfaces.

### Phase 3 — Delivery ladder
- **Layer 1**: `surface wait` drains oldest-pending first, registers as a live waiter (`/stream?wait_for=`), suppresses bindings, shows "agent listening" on the card.
- **Layer 2**: `surface bind --action … --run/--webhook` — argv-safe spawn (action batch as JSON on stdin, cwd = project root, logs under `~/.surface/logs/bindings/`), single-flight + coalescing, webhook retry, `binding_status` SSE (⟳ pill). Per-project kill switch in `.surface/config.json`.
- **Layer 3**: pending badges + live counts on cards; TTL sweep (handled 7d, pending 30d).
- SKILL.md rewritten around the ladder, harness recipes, and the ask-once-per-project wake-binding consent.

### Phase 4 — Polish
- Display slots (renderer/home/overlay) are **artifacts** (`metadata.display_role`, `surface slot`); raw config blobs removed.
- SSE keepalive heartbeat (20s) + reconnecting `surface stream`.
- Single-file CLI: `npm run build:cli` → `dist/surface.mjs` (built automatically by `prepare`; the npm `surface` bin points at it).
- Install state moved to `~/.surface/install-state.json` (no more by-design dirty `INSTALL_FOR_AGENTS.md`).
- `If-Match` preconditions on workspace `PUT` (412 on version mismatch); iframe `sandbox` attribute on surface frames; `@modelcontextprotocol/sdk` removed from default deps.

## Verified

- `npx tsc --noEmit` passes.
- `npm run test:artifacts` — artifacts, linking (incl. symlink-escape regression), state, templates (engine + built-ins), stream chunks, project filters.
- `npm run test:auth` — 35 checks: two-plane roles, pairing lifecycle, device capability split, device registry/revocation, session persistence across restarts.
- `npm run test:startup-access` — pairing URL/QR output helpers.
- Live smoke: binding spawn with stdin batch + coalescing; `surface sync` idempotency; slots end-to-end; single-file CLI against a running server.

## Notes

- The MCP adapter in `archived/` requires `npm install @modelcontextprotocol/sdk` to run; not maintained.
- `test/e2e.ts` (OpenRouter tool-calling loop) needs `OPENROUTER_API_KEY`; endpoints updated to the artifacts API.
