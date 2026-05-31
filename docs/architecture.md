# Surface Architecture

## Goal

Surface is a single-user, single-deployment, self-hosted display service. One long-running process owns SQLite, an artifact workspace, the PWA, SSE, and display state. Multiple AI agents push content and react to user clicks through a single shared CLI; no per-agent protocol negotiation, no separate Surface processes.

## Process model

```
Agent A (Claude Code) ─┐
Agent B (Cursor)       ├─► surface CLI ──► HTTP ──► Surface service ──► SQLite + ~/.surface/artifacts/
Agent C (custom shell) ┘                            (Express + SSE)              │
                                                            │                    └─► PWA on 127.0.0.1:3000
                                                            └─► optional webhook ──► external agent gateway
```

- **Surface service** (`server/`): Express 5 on `127.0.0.1:3000` by default. Owns the SQLite DB, the artifact workspace, the SSE fan-out, and the display state.
- **CLI** (`bin/surface.ts`): canonical agent client. Mirrors the HTTP API as subcommands. Every agent uses the same binary.
- **SKILL.md** (repo root): discovery document agents read to know when/how to use the CLI.
- **PWA** (`client/`): vanilla JS, hash routing, sandboxed iframes loaded from `/surfaces/:id/html` (real origin so scripts work).
- **MCP adapter** (`archived/mcp.ts`): preserved for legacy users; no longer the recommended path.

## Data model

```sql
artifacts(id, title, kind, mime, renderer, source_type, current_version_id, workspace_path, metadata, deleted_at, created_at, updated_at)
artifact_versions(id, artifact_id, parent_version_id, version, reason, created_by, manifest_json, content_hash, created_at)
artifact_files(id, artifact_version_id, path, mime, size_bytes, sha256, storage_kind, storage_path, created_at)
surface_views(id, artifact_id, title, thumbnail_path, metadata, pinned, created_at, updated_at)
sandbox_sessions(id, artifact_id, version_id, provider, status, preview_url, port, metadata, created_at, last_used_at)
surface_actions(id, surface_id, action, data, status, created_at)
display_config(key, value)
surfaces(id, title, html, metadata, created_at, updated_at)   -- legacy fallback, read-only
```

Schema is versioned via `PRAGMA user_version` and migrated through `server/migrations.ts`. The baseline is v1.

Two artifact source types matter:

- **Workspace artifacts** (`source_type: "generated" | "presented_file"`, `storage_kind: "workspace"`) — Surface owns the bytes under `~/.surface/artifacts/{id}/versions/{n}/files/...`. Versioned, immutable per version, supports `update` and `rollback`.
- **Linked artifacts** (`source_type: "linked"`, `storage_kind: "external"`) — the bytes live at an absolute path on disk owned by the agent's project. Surface re-serves them. One version row per link (no history). `update` and `rollback` return 409; the agent calls `touch` after editing.

Legacy `surfaces` rows are read fallback only. New writes go through artifacts.

## Filesystem layout

```
~/.surface/
  db.sqlite                              (+ -wal / -shm)
  artifacts/
    {artifact-id}/
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

Linked artifacts have `workspace_path` pointing outside `~/.surface/` (e.g. `/home/user/projectA/`). The file route resolves relative paths against that root, with `..`-rejection and an optional `SURFACE_LINK_ROOTS` allow-list.

Override the data dir with `SURFACE_DATA_DIR`. The legacy `SURFACE_WORKSPACE_DIR` is still honored. On first boot Surface copies legacy `<repo>/surfaces.db` and `~/surface/artifacts/` into `~/.surface/` if the new dir is empty.

## HTTP API

| Surface group | Routes |
|---|---|
| Artifacts | `POST /artifacts`, `POST /artifacts/link`, `POST /artifacts/present-file`, `GET /artifacts`, `GET /artifacts/:id`, `PUT /artifacts/:id`, `DELETE /artifacts/:id`, `POST /artifacts/:id/touch`, `POST /artifacts/:id/rollback`, `GET /artifacts/:id/versions`, `GET /artifacts/:id/view`, `GET /artifacts/:id/files/*`, `GET /artifacts/:id/manifest` |
| Surfaces (display projection) | `GET /surfaces`, `GET /surfaces/:id`, `GET /surfaces/:id/html`, `POST /surfaces/:id/actions`, `GET /surfaces/:id/actions`, `POST /surfaces/:id/exec`, `POST /surfaces/:id/reply`, `GET /surfaces/:id/stream` |
| Actions queue | `GET /actions`, `POST /actions/:id/ack` |
| Display | `GET /display/config`, `PUT /display/config`, `POST /display/reset`, `GET /display/status`, `POST /display/presence`, `POST /display/navigate`, `POST /display/notify`, `GET /display/features` |
| SSE | `GET /stream` (global) |
| Marketplace (gated) | `/marketplace/*` returns 404 unless `SURFACE_FEATURES_MARKETPLACE=1` |
| Proxies | `POST /api/chat` (OpenRouter), `GET /proxy/pdf`, `POST /api/nexlayer/*` |

`PUT /artifacts/:id` and `POST /artifacts/:id/rollback` return `409` for linked artifacts.

## CLI

`bin/surface.ts` is the canonical agent client. It accepts subcommands that mirror the HTTP API. JSON to stdout, JSON error to stderr, exit `0` / `1` / `2` / `3` (timeout). Reads `SURFACE_URL` and `SURFACE_TOKEN`.

See `SKILL.md` at the repo root for the command spec and intent mapping.

### Three delivery modes for user actions

Surface gives agents three ways to react to `surface_action` events:

1. **Pull** (`surface actions [<id>]` + `surface ack`) — agent polls.
2. **Block-and-exit** (`surface wait [--id] [--action] [--timeout]`) — listens on the global SSE stream, filters client-side, ACKs on match, exits 0 with the action JSON. Initial pending-actions poll on start + after reconnect gives at-least-once delivery across SSE disconnects. Intended to be invoked as a background subprocess; the agent harness wakes the agent when the process exits.
3. **Webhook fan-out** (`SURFACE_WEBHOOK_*`) — Surface POSTs a structured envelope to an external gateway. Only useful when a long-running gateway wants the push.

Modes 1 and 2 require no extra infrastructure; mode 3 requires the gateway to be set up.

## Agent contract

Two documents, both at repo root:

- **`SKILL.md`** — what `surface` does, when to use each command, conventions.
- **`INSTALL_FOR_AGENTS.md`** — first-time bootstrap: verify/install the service, copy `SKILL.md` into the agent's skill directory, optionally walk the user through `docs/TUTORIAL.md`. Tracks state in a YAML frontmatter block agents update locally.

## Webhook fan-out (optional)

The webhook is one of three delivery modes for `surface_action` events (see "Three delivery modes" above). When users interact with a surface, Surface POSTs a structured envelope to `<SURFACE_WEBHOOK_URL><SURFACE_WEBHOOK_PATH>` (default path `/hooks/agent`) if `SURFACE_WEBHOOK_TOKEN` is set:

```json
{ "type": "surface_action", "surface_id": "...", "surface_title": "...", "action": "...", "data": {...}, "created_at": "..." }
```

`OPENCLAW_GATEWAY_URL` / `OPENCLAW_HOOKS_TOKEN` are accepted as legacy aliases.

## Security boundary

Surface binds to `127.0.0.1` by default. Loopback requests are trusted unless `SURFACE_TRUST_LOOPBACK=0` (required when fronting Surface with a same-host reverse proxy). Non-loopback access is authenticated by one-time pairing tokens exchanged for durable sessions: a `surface_session` HttpOnly cookie for browsers (the right transport for SSE) or `Authorization: Bearer <session-token>` for CLI/agents. On non-loopback bind (or `SURFACE_PAIR_ON_START=1`) Surface mints and prints a startup pairing token + `/pair#token=…` URL. `SURFACE_TOKEN` remains valid as a static `owner` bearer for backward compatibility. Tokens are stored hashed (`sha256(serverSecret:token)`); the secret lives at `~/.surface/auth-secret` (`0600`).

`SECURITY.md` documents the full threat model. Notable points:

- Surface trusts the local user, every connected agent, and every installed artifact.
- `POST /artifacts/present-file`, `POST /surfaces/:id/exec`, `GET /proxy/pdf`, and `POST /api/chat` are powerful by design; they require authenticated access for non-loopback binds.
- `/proxy/pdf` refuses URLs resolving to loopback, RFC1918, link-local, IPv6 loopback/ULA, and IPv4-mapped variants. Defeats trivial SSRF to cloud metadata and local services.
- `/api/chat` has an in-memory rate limit (default 30 requests/minute, override with `SURFACE_CHAT_RATE_LIMIT`).
- Linked artifacts respect `SURFACE_LINK_ROOTS` (colon-separated allow-list) when set. Symlinks are resolved with `fs.realpathSync` at both link time and read time.
- PDFs render with the browser's native `<iframe src=...>` viewer; no JS PDF library is bundled.

## Deferred / known issues

The original review surfaced more changes than this branch ships. The items below are intentionally not done here:

- **Iframe sandboxing** — surface iframes still load same-origin and can `fetch('/artifacts')` for every other artifact. Per-surface origin or strict `sandbox` attribute is a separate refactor.
- **XSS in `renderArtifactShell`** — title/path values injected through `JSON.stringify` inside `<script>` blocks need a safer template (e.g., `<script type="application/json">` plus DOM lookup).
- **Legacy `surfaces` table removal** — fallback reads still happen; eager migrate and drop in a follow-up.
- **Renderer/overlay/home → artifacts** — these slots store raw HTML in `display_config` rather than as first-class artifacts. With the marketplace gated, urgency is lower.
- **N+1 grid fetches** — the PWA fetches each surface individually after the listing; the listing already has enough for the cards.
- **Concurrency on workspace `update`** — multiple agents racing `artifact_update` on the same workspace artifact can silently overwrite. `If-Match` version preconditions remain a follow-up. Linked artifacts dodge this entirely since the filesystem mediates.
- **SSE keepalive** — long-idle connections die at NAT timeouts; add a 15-30s heartbeat.

## Stack

Express 5, better-sqlite3, native Node `fetch`, vanilla-JS PWA. Runtime: `tsx`. No bundler. No new client dependencies.
