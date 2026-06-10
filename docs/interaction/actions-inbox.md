# Actions & the Inbox

**Status:** Partially shipped — the action queue exists; inbox semantics, wait ordering, and cleanup are approved for Phase 3.
**Code (current):** `server/routes.ts` (actions routes), `server/db.ts` (surface_actions), `client/app.js` (postMessage bridge), `bin/surface.ts` (`actions`, `ack`, `wait`)

An **action** is a user interaction flowing back to agents: a button click, a form submit, an answer to an [`ask`](../templates/ask.md). Actions are the return half of Surface's core loop, and the inbox is what makes them durable — a click must never be lost just because no agent was running when it happened.

## Shipped today

1. Artifact HTML posts a message: `parent.postMessage({ type: "surface_action", action: "approve", data: {…} }, "*")`.
2. The PWA forwards it to `POST /surfaces/:id/actions`, which inserts a `pending` row in `surface_actions`, broadcasts a `surface_action` SSE event, and optionally fires the webhook fan-out.
3. Agents consume by polling (`surface actions [<id>]`), blocking (`surface wait`), or webhook.
4. `POST /actions/:id/ack` marks a row `handled`. Ack is optional and rows are never deleted.

## Approved changes (Phase 3)

### Wait returns oldest-pending first

`surface wait --surface <id>` checks the pending queue **before** blocking: if an unhandled action exists, it returns immediately with the oldest one; otherwise it blocks until one arrives. This closes the missed-click race between two `wait` invocations without any client-side cursor — the server's own `pending`/`handled` status *is* the cursor. Client-held cursors (`--since`) were considered and rejected: they only matter for multiple independent consumers each needing every event, which the single-user reality doesn't have.

### Ack semantics

- **Implicit on delivery** via `surface wait` (the consumer received it).
- **Implicit on reply** — `surface reply <id> …` acks the action(s) it responds to.
- **Explicit** `surface ack <action-id>` remains for the polling path.
- Binding deliveries ack on successful spawn ([delivery-ladder.md](delivery-ladder.md)).

### Inbox surfacing

Pending actions become visible instead of silently queueing:

- Each card shows an unhandled-action badge (count); the grid header shows a total.
- `surface actions` with no arguments lists all pending actions across surfaces — SKILL.md instructs every agent to run this **at session start** and drain anything relevant to its project. A click at 11pm is, at worst, handled by whichever session opens in the morning.

### Cleanup (TTL)

`surface_actions` currently grows forever. Approved: `handled` rows are deleted after 7 days (configurable), `pending` rows after 30 days (a click nobody handled in a month is stale). Runs as a periodic sweep in the service.

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
