# Bindings

**Status:** Shipped (2026-06)
**Code:** `server/bindings.ts`, registration routes in `server/routes/actions.ts`; the global `SURFACE_WEBHOOK_*` fan-out it generalizes also lives in `server/routes/actions.ts`

A **binding** is a pre-registered reaction to a surface action: a command Surface spawns, or a webhook Surface POSTs, when a click arrives and no live waiter is connected. Bindings are layer 2 of the [delivery ladder](delivery-ladder.md) — the mechanism by which a click can *start* an agent rather than merely unblock one.

## Registration (system plane only)

```bash
surface bind deploy-panel --action "approve|hold" --run 'claude -p "Surface action batch on stdin. Handle it."'
surface bind report --action regenerate --webhook https://gateway.local/hooks/agent
surface bindings deploy-panel          # list (id, pattern, kind, enabled, last run/status)
surface unbind <binding-id>
```

Registration requires the `system` role — a binding is arbitrary command execution, so device sessions can never create or edit one; clicking from a phone can only **fire** what was pre-registered from the machine. See [../auth/trust-model.md](../auth/trust-model.md).

## Schema

```sql
surface_bindings(
  id, surface_id, action_pattern,         -- alternation over action names ("a|b"); "*" = any
  kind,                                   -- 'command' | 'webhook'
  run, cwd,                               -- command kind
  webhook_url,                            -- webhook kind
  enabled, timeout_seconds,
  last_run_at, last_status, last_error,
  created_at, updated_at
)
```

## Command bindings

- **Spawn safety:** the command string is tokenized into argv **once, at registration** (quote-aware, deliberately *not* a shell: no expansion, no substitution, no redirection — `tokenizeCommand`, `server/bindings.ts`) and executed via `execFile`. **Click data never touches the command line** — the action batch arrives as JSON on stdin. This is the injection boundary: a malicious `data` payload can't become shell.
- **cwd** defaults to the surface's `project_root` (override with `--cwd`), so spawned agents wake up standing in the right repo.
- **Single-flight + coalescing:** one execution per surface at a time; the spawned command receives all pending actions as a batch; clicks landing mid-run trigger one follow-up pass (see [delivery-ladder.md](delivery-ladder.md)).
- **Timeout** (default 10 min, `--timeout`) and captured stdout/stderr under `~/.surface/logs/bindings/`. `last_status`/`last_error` surface in `surface bindings` and via a `binding_status` SSE event (`running` → `ok`/`failed`).
- Ack: the delivered batch is marked handled after a successful run; a failed run leaves it pending (inbox catches it).
- **Per-project kill switch:** `.surface/config.json → bindings.enabled: false` suppresses all binding dispatch for that project's surfaces.

## Webhook bindings

POST a batch envelope, per surface:

```json
{ "type": "surface_action_batch", "surface_id": "…", "surface_title": "…", "project_root": "…", "actions": [ … ] }
```

With 3 retries on a backoff schedule of 1s/5s/25s (the global fan-out is fire-and-forget; per-surface bindings get retry because a daemon target is expected to care). The global `SURFACE_WEBHOOK_*` env fan-out remains as a firehose for gateways that want everything.

## Harness recipes

| Harness | Binding | Notes |
|---|---|---|
| **Claude Code** | `--run 'claude --resume <session-id> -p "Handle the Surface action batch on stdin."'` | `<session-id>` is the **creating session's id**, which the agent bakes into the command when it registers the binding (the harness exposes it, e.g. via hooks; Surface does no placeholder templating). Resuming maps the click back to the session with full context. Headless spawns consume usage — which is why the ladder prefers layer 1. |
| **Codex** | `--run 'codex exec "Handle the Surface action batch on stdin."'` (resume variant where supported) | Same stdin contract. |
| **OpenClaw** | `--webhook http://127.0.0.1:<port>/hooks/agent` | The easy case: OpenClaw already runs 24/7 with an HTTP gateway, so the webhook *is* the wake-up. No spawn, no usage cost. |
| **Anything** | `--run './scripts/on-click.sh'` | A binding is just a command; cron jobs, tmux send-keys, notify-send all work. |

SKILL.md ships these recipes verbatim so each harness's agents register the right binding without rediscovering the pattern.

## Related

- [delivery-ladder.md](delivery-ladder.md) — when bindings fire (and when they're suppressed)
- [actions-inbox.md](actions-inbox.md) — the fallback when a binding fails
- [../auth/trust-model.md](../auth/trust-model.md) — why registration is system-only
- [../state/project-directory.md](../state/project-directory.md) — bindings declared in `.surface/` manifests
