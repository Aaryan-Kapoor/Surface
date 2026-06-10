# Bindings

**Status:** Approved — not yet built (Phase 3)
**Code (current):** none — generalizes the shipped `SURFACE_WEBHOOK_*` fan-out (`server/routes.ts:31`) to per-surface rules

A **binding** is a pre-registered reaction to a surface action: a command Surface spawns, or a webhook Surface POSTs, when a click arrives and no live waiter is connected. Bindings are layer 2 of the [delivery ladder](delivery-ladder.md) — the mechanism by which a click can *start* an agent rather than merely unblock one.

## Registration (system plane only)

At creation:

```bash
surface create "Deploy panel" --id deploy-panel … \
  --on-action approve --run 'claude --resume {session} -p "Surface action batch on stdin. Handle it."'
```

Or on an existing surface:

```bash
surface bind deploy-panel --action "approve|hold" --run '…'
surface bind report --action regenerate --webhook https://gateway.local/hooks/agent
surface bindings deploy-panel          # list (id, pattern, kind, enabled, last run/status)
surface unbind <binding-id>
```

Registration requires the `system` role — a binding is arbitrary command execution, so device sessions can never create or edit one; clicking from a phone can only **fire** what was pre-registered from the machine. See [../auth/trust-model.md](../auth/trust-model.md).

## Schema

```sql
surface_bindings(
  id, artifact_id, action_pattern,        -- glob/alternation over action names; "*" = any
  kind,                                   -- 'command' | 'webhook'
  command, cwd,                           -- command kind
  webhook_url,                            -- webhook kind
  enabled, created_at, last_run_at, last_status, last_error
)
```

## Command bindings

- **Spawn safety:** executed via `execve`-style argv (no shell unless `--shell` is explicitly passed). Placeholders (`{surface}`, `{session}`, `{action}`) substitute into argv positions only. **Click data is never interpolated into the command line** — the action batch arrives as JSON on stdin (and `SURFACE_ACTIONS_FILE` for harnesses that prefer a path). This is the injection boundary: a malicious `data` payload can't become shell.
- **cwd** defaults to the surface's `project_root`, so spawned agents wake up standing in the right repo.
- **Single-flight + coalescing:** one execution per surface at a time; the spawned command receives all pending actions as a batch (see [delivery-ladder.md](delivery-ladder.md)).
- **Timeout** (default 10 min) and captured stdout/stderr under `~/.surface/logs/bindings/`. `last_status`/`last_error` surface on the card and via a `binding_status` SSE event (`running` → `ok`/`failed`).
- Ack: delivered actions are marked handled on successful spawn; a failed spawn leaves them pending (inbox catches them).

## Webhook bindings

POST the same envelope as the shipped global fan-out, but per surface:

```json
{ "type": "surface_action_batch", "surface_id": "…", "surface_title": "…", "actions": [ … ] }
```

With 3 retries and exponential backoff (the shipped fan-out is fire-and-forget; per-surface bindings get retry because a daemon target is expected to care). The global `SURFACE_WEBHOOK_*` env fan-out remains as a firehose for gateways that want everything.

## Harness recipes

| Harness | Binding | Notes |
|---|---|---|
| **Claude Code** | `--run 'claude --resume {session} -p "Handle the Surface action batch on stdin."'` | `{session}` is the **creating session's id**, recorded by the agent at `surface create` time (the harness exposes it to the agent, e.g. via hooks). Resuming maps the click back to the session with full context. Headless spawns consume usage — which is why the ladder prefers layer 1. |
| **Codex** | `--run 'codex exec "Handle the Surface action batch on stdin."'` (resume variant where supported) | Same stdin contract. |
| **OpenClaw** | `--webhook http://127.0.0.1:<port>/hooks/agent` | The easy case: OpenClaw already runs 24/7 with an HTTP gateway, so the webhook *is* the wake-up. No spawn, no usage cost. |
| **Anything** | `--run './scripts/on-click.sh'` | A binding is just a command; cron jobs, tmux send-keys, notify-send all work. |

SKILL.md ships these recipes verbatim so each harness's agents register the right binding without rediscovering the pattern.

## Related

- [delivery-ladder.md](delivery-ladder.md) — when bindings fire (and when they're suppressed)
- [actions-inbox.md](actions-inbox.md) — the fallback when a binding fails
- [../auth/trust-model.md](../auth/trust-model.md) — why registration is system-only
- [../state/project-directory.md](../state/project-directory.md) — bindings declared in `.surface/` manifests
