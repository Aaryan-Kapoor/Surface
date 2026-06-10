# Actions & the Inbox

**Status:** Shipped (2026-06)
**Code:** `server/routes/actions.ts`, `server/db.ts` (`surface_actions`, `cleanupActions`), `client/app.js` (postMessage bridge, badges), `bin/surface.ts` (`actions`, `ack`, `wait`)

An **action** is a user interaction flowing back to agents: a button click, a form submit, an answer to an [`ask`](../templates/ask.md). Actions are the return half of Surface's core loop, and the inbox is what makes them durable — a click must never be lost just because no agent was running when it happened.

## The pipeline

1. Artifact HTML posts a message: `parent.postMessage({ type: "surface_action", action: "approve", data: {…} }, "*")` — or calls the injected runtime's `Surface.action(name, data)`, which wraps it.
2. The PWA forwards it to `POST /artifacts/:id/actions`, which inserts a `pending` row in `surface_actions`, broadcasts a `surface_action` SSE event, optionally fires the webhook fan-out, and runs the [delivery ladder](delivery-ladder.md).
3. Agents consume by polling (`surface actions [<id>]`), blocking (`surface wait`), bindings, or webhook. Reading the inbox is **system-plane only** — a paired device must never drain it.
4. `POST /actions/:id/ack` marks a row `handled` (stamping `handled_at`) and broadcasts `actions_acked` so card badges update live.

### Wait returns oldest-pending first

`surface wait --id <id>` checks the pending queue **before** blocking: if an unhandled action exists, it returns immediately with the oldest one; otherwise it blocks until one arrives (re-polling after every reconnect). This closes the missed-click race between two `wait` invocations without any client-side cursor — the server's own `pending`/`handled` status *is* the cursor. Client-held cursors (`--since`) were considered and rejected: they only matter for multiple independent consumers each needing every event, which the single-user reality doesn't have.

### Ack semantics

- **Implicit on delivery** via `surface wait` (the consumer received it; disable with `--no-ack`).
- **Explicit** `surface ack <action-id>` for the polling path.
- Binding deliveries ack the whole delivered batch after a successful run ([delivery-ladder.md](delivery-ladder.md)); a failed run leaves it pending.

### Inbox surfacing

Pending actions are visible instead of silently queueing:

- Card payloads carry a `pending_actions` count; each card wears an unhandled-action badge, kept live by `surface_action`/`actions_acked` SSE events.
- `surface actions` with no arguments lists all pending actions across surfaces — SKILL.md instructs every agent to run this **at session start** and drain anything relevant to its project. A click at 11pm is, at worst, handled by whichever session opens in the morning.

### Cleanup (TTL)

A sweep at boot and hourly (`cleanupActions`, `server/db.ts`; scheduled in `server/index.ts`) deletes `handled` rows after 7 days and `pending` rows after 30 (a click nobody handled in a month is stale). Deleting an artifact also clears its queued actions.

## Action payload

```json
{
  "id": "act_…",
  "surface_id": "deploy-panel",
  "surface_title": "Deploy panel",
  "action": "approve",
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
