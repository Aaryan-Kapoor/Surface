# Actions & the Inbox

**Status:** Shipped (2026-06)
**Code:** `server/routes/actions.ts`, `server/actionsStore.ts` (`surface_actions`, claim state machine, `cleanupActions`), `client/app.js` (legacy postMessage bridge, badges), `bin/surface.ts` (`actions`, `ack`, `wait`)

An **action** is a user interaction flowing back to agents: a button click, a form submit, an answer to an [`ask`](../templates/ask.md). Actions are the return half of Surface's core loop, and the inbox is what makes them durable — a click must never be lost just because no agent was running when it happened.

## The pipeline

1. Artifact HTML calls the injected runtime's `Surface.action(name, data)`; the legacy `surface_action` postMessage bridge remains only for older surfaces.
2. The runtime posts to `POST /artifacts/:id/actions`, which inserts a `pending` row in `surface_actions`, broadcasts a `surface_action` SSE event, optionally fires the webhook fan-out, and runs the [delivery ladder](delivery-ladder.md).
3. Agents consume by polling (`surface actions [<id>]`), blocking (`surface wait`), bindings, or webhook. Reading the inbox is **system-plane only** — a paired device must never drain it.
4. A handler **claims** the row before acting on it (`POST /actions/:id/claim`), then `POST /actions/:id/ack` marks it `handled` (stamping `handled_at`). Both broadcast `actions_acked` so card badges update live.

### Statuses

| Status | Meaning | Deliverable? | Badges the card? |
|---|---|---|---|
| `pending` | nobody has taken it | yes | yes |
| `claimed` | one handler owns it and is mid-handoff or mid-run | **no** | yes |
| `handled` | Surface completed the handoff to that handler | no | no |

The badge counts `pending + claimed` — the user's click is not finished just because an agent picked it up — while delivery draws only from `pending`, so an action can never be handed to two handlers. A claim that is never completed returns to `pending` (waiter disconnect, a 30s handoff deadline, a failed binding, or a server restart), so nothing is consumed without being delivered. Full state machine: [delivery-ladder.md](delivery-ladder.md).

### Wait returns oldest-pending first

`surface wait --id <id>` checks the pending queue **before** blocking: if an unhandled action exists, it returns immediately with the oldest one; otherwise it blocks until one arrives (re-polling after every reconnect). This closes the missed-click race between two `wait` invocations without any client-side cursor — the server's own `pending`/`handled` status *is* the cursor. Client-held cursors (`--since`) were considered and rejected: they only matter for multiple independent consumers each needing every event, which the single-user reality doesn't have.

### Ack semantics

- **Implicit on delivery** via `surface wait`, as the second half of the claim: the CLI claims the action, flushes the JSON line, then acks with the same claim token. `--no-ack` turns the waiter into a pure observer that claims nothing and leaves the row pending for a real handler.
- **Explicit** `surface ack <action-id>` for the polling path — an agent declaring a click done. This one is unfenced by design; it is the override, not part of the handshake.
- Binding deliveries claim their batch *before* spawning and ack it after a successful run ([delivery-ladder.md](delivery-ladder.md)); a failed run releases it back to `pending`.
- Ack is idempotent for the same claim token, so retrying after an ambiguous network result cannot strand a delivery that actually happened.

### Inbox surfacing

Pending actions are visible instead of silently queueing:

- Card payloads carry a `pending_actions` count; each card wears an unhandled-action badge, kept live by `surface_action`/`actions_acked` SSE events.
- `surface actions` with no arguments lists all pending actions across surfaces — SKILL.md instructs every agent to run this **at session start** and drain anything relevant to its project. A click at 11pm is, at worst, handled by whichever session opens in the morning.

### Cleanup (TTL)

A sweep at boot and hourly (`cleanupActions`, `server/actionsStore.ts`; scheduled in `server/index.ts`) deletes `handled` rows after 7 days and `pending` rows after 30 (a click nobody handled in a month is stale). Deleting an artifact also clears its queued actions.

## Action payload

```json
{
  "id": "act_…",
  "surface_id": "deploy-panel",
  "surface_title": "Deploy panel",
  "action": "approve",
  "project_root": "/home/me/myapp",
  "data": { "choice": "ship" },
  "status": "pending",
  "created_at": "2026-06-10T18:21:04Z"
}
```

`data` is arbitrary JSON authored by the surface. Templates emit well-known shapes (e.g. `ask` emits `{ action: "answer", data: { choice, text } }`).

## Related

- [delivery-ladder.md](delivery-ladder.md) — how an action finds an agent (waiter → binding → inbox)
- [bindings.md](bindings.md) — spawning agents from actions
- [../templates/ask.md](../templates/ask.md) — the highest-level consumer of actions
- [../core/events.md](../core/events.md) — the `surface_action` SSE event
