# The Delivery Ladder

**Status:** Shipped (2026-06; codex flowback layer added 2026-07; single-claimant delivery 2026-07)
**Code:** `bin/surface.ts` (`wait`), `server/bindings.ts` (`dispatchAction`), `server/codexBridge.ts` (codex layer), `server/sse.ts` (waiter registry), `server/routes/display.ts` (`/stream?wait_for_*`), claim state machine in `server/actionsStore.ts`, webhook fan-out in `server/routes/actions.ts`

The central problem of agent↔screen interaction: **agent process lifetime ≪ surface lifetime.** A Claude Code session ends at 5pm; the user taps "regenerate report" on their phone at 11pm. Nothing is polling. Nothing will ever poll. Long-polling alone cannot solve this — and spawning a fresh agent for every click burns usage and loses context. The ladder resolves the tension by trying the cheapest, most-context-rich channel first and degrading gracefully.

Surface is the only long-lived process on the machine, so Surface is the component that routes — and when necessary *starts* — agents.

## What delivery guarantees

> An action stays durable until Surface hands it to one **claimed** delivery channel. At any instant at most one waiter or binding owns that claim. Ambiguous transport failures may redeliver, so handlers must treat `action.id` as an idempotency key.

Two words carry weight here.

**Claimed.** `surface_action` is broadcast to every SSE listener — that is how every screen and every observer stays current — but a listener that intends to *handle* the action must first take it via `POST /actions/:id/claim`, an atomic compare-and-swap in SQLite. Losers stay silent. Before this existed the CLI acked and printed unconditionally, so a single click was printed by every `surface wait --follow` on the machine and every one of those agents did the same work.

**Handed.** `handled` means Surface completed the handoff to that channel: a waiter's JSON line was flushed to stdout, a bound command exited zero, a webhook returned 2xx. It is **not** a claim that an agent finished the underlying work, which Surface cannot observe. Do not read `handled_at` as proof that anything was accomplished.

### Action states

```
pending ──claim(waiter)───► claimed ──complete──► handled
                               ├──deadline──────► pending
                               └──disconnect────► pending
pending ──claim(binding)──► claimed ──success───► handled
                               └──failure───────► pending
```

The card badge counts `pending + claimed`: the user's click is not done just because someone picked it up. Delivery only ever draws from `pending`.

**The waiter deadline is 30 seconds and is not a work lease.** It covers only the handshake — claim response, JSON serialization, stdout flush, completing ack — and is never renewed. A CLI that cannot hand over a line in 30s is not a healthy delivery channel. Connection close normally releases a claim sooner; a reaper every 5s is the backstop for a waiter that wedged with its socket still open. Binding claims have no deadline: they are already bounded by the binding's own execution timeout, and any claim surviving a server restart is released at boot, since no run outlives the process.

### Scope

A waiter registers what it is eligible to claim, and eligibility is checked server-side on every claim:

| Registration | Takes |
|---|---|
| `wait --id <surface>` | that surface |
| `wait` (default) | the current project (git root) |
| `wait --project <root>` | that project |
| `wait --all` | everything |

Project scope is exact, and never covers a surface with no `project_root` — the global `board` belongs to no repo, so it waits for an explicit `--id` or `--all` waiter rather than being absorbed by whichever project terminal happened to be running.

`--action` also narrows eligibility. A waiter armed as `--id deploy --action approve` used to hold back the `reject` binding on the same surface even though it would never consume a reject.

**Observers never register and never claim:** the PWA's stream, `surface stream`, `wait --no-ack`, and `wait --event <non-action>`. A connection that will not do the work must not stop something else from doing it.

## The layers

When an action arrives for a surface, delivery resolves strictly in this order:
waiter → explicit binding → codex flowback → inbox.

### Layer 1 — Live waiter (default, free, in-context)

At surface creation, the agent backgrounds a waiter **in its own working session**, in one of two forms:

```bash
surface wait --follow &            # persistent action terminal: one JSON line per action, never exits
surface wait --id deploy-panel &   # one-shot: prints the action JSON on exit
```

**`--follow` is the preferred form only when the harness can wake on background output.** It is a long-lived action terminal: every matching action is claimed, printed as one compact JSON line, then settled, the pending inbox is drained on connect and after every reconnect, and the waiter registration never lapses. Claude Code's Monitor tool turns each line into a model wake-up (pattern-match on `"action":"`), and harnesses with an equivalent background-output watchdog work the same way.

The one-shot form works on pure completion-notification harnesses: click → `wait` exits with the action JSON → the harness notifies the model → the agent handles it → re-arms. Codex falls into this bucket: its terminal polling wakes on process exit, not on arbitrary output, so use one-shot waits and re-arm after each action.

Either way the agent handles the click **in the session that has all the context**, at zero extra usage; the user keeps talking to the same session.

The open connection doubles as **presence**: a claiming `wait` connects to `/stream?wait_for_surface=<id>` (or `wait_for_project` / `wait_for_all`), which registers it in the waiter registry (`server/sse.ts`) and receives a `waiter_registered` event carrying the `client_id` it quotes on every claim. While it lives the card shows "● listening" (via `waiter_status` events and the `listening` card flag) and it gets first refusal on the actions it is eligible for.

Honest caveats: sessions end, laptops sleep, and harnesses cap background-task lifetimes (Claude Code's Monitor needs `persistent: true` to survive past its default timeout). That is why this is a ladder and not a single mechanism. Terminals die with the session that started them while surfaces live on, so SKILL.md makes re-arming part of the session-start ritual: drain the inbox (layer 3 covers the dead interval), then start a fresh terminal appropriate to the harness.

## Harness recipes

| Harness | Verified wake shape | Recipe |
|---|---|---|
| Claude Code | Monitor can wake on each output line when persistent. | `surface wait --follow` under Monitor with a pattern for `"action":`; one-shot wait also works for a single expected answer. |
| Codex CLI | Cannot wake on background output — so Surface delivers *into* the session instead ([codex.md](codex.md)). | One-time `surface codex setup`; after that no waiter is needed at all: clicks arrive as native turns in the live TUI, and consent-gated wakes revive dead threads. One-shot `surface wait` still works where the bridge is unavailable. |
| Gemini CLI | Foreground commands can be killed after silence. | Use one-shot `surface wait --id <id> --heartbeat 60 --timeout <under-the-harness-cap>`; exit 3 means idle, so re-arm. |
| Cline-style output injection | Running terminal output appears on later model turns. | `surface wait --follow` can be useful, but it may not wake an idle/completed task. |
| Cursor / Windsurf / Copilot CLI / Aider | Completion or explicit polling is the reliable wake shape. | Use one-shot waits under the harness timeout; exit 3 means idle, so re-arm. |
| Daemons / gateways | Already have inbound HTTP. | Use `surface bind --webhook http://127.0.0.1:18789/hooks/wake` or a global webhook. |

### Layer 2 — Binding (fires when no waiter claims first)

An eligible live waiter gets a **five-second first refusal**; if it has not claimed by then, the binding is allowed to try. Waiter presence used to suppress bindings *indefinitely*, which meant one idle or wedged connection silently disabled wake bindings — a failure with no symptom. The timer only decides who may attempt the claim; SQLite decides who wins, so a waiter claiming at grace+1ms and a binding starting at grace resolve against the same CAS rather than against timer ordering.

A binding claims its batch **before** spawning, and claims only the actions matching its own `action_pattern`. Previously the batch was read up front and acked only on success, so for the whole run — up to the 600s default timeout — those rows stayed `pending` and a waiter connecting mid-run drained them too. A failed run releases exactly the rows it still owns, back to `pending`.

The binding itself is a pre-registered command or webhook that Surface executes on the action's behalf — `claude -p --resume <session-id>` to revive the *specific session that created the surface*, or a webhook POST into an always-on gateway like OpenClaw. (Codex surfaces usually don't need one: layer 2.5 resumes the creating thread automatically.) Full spec: [bindings.md](bindings.md).

Cost rationale: headless spawns consume usage/quota, so layer 2 only fires when layer 1 is absent, and it can be disabled per project (`.surface/config.json → bindings.enabled: false`) for users who never want spawned sessions.

Consent (decided 2026-06): binding registration is **opt-in, asked once per project**. The first time an agent creates an interactive surface in a project, it asks the user "want clicks to wake me when I'm offline? (costs a headless session per wake)" and records the answer as `bindings.enabled` in `.surface/config.json` — durable, committed, never re-asked. Agents must not auto-register wake bindings without that recorded consent; SKILL.md carries the script.

While a binding runs, the card shows "⟳ handling…" — the user sees that their click *did something*, which is what makes the loop trustworthy.

### Layer 2.5 — Codex flowback (automatic, for codex-created surfaces)

Surfaces remember the codex thread that created them (`CODEX_THREAD_ID`,
captured by the CLI at create time). When no waiter is connected and no
explicit binding matches, Surface delivers the batch through the codex
app-server daemon: a `turn/start` into the live attached TUI (waiter-
equivalent, no consent needed), or a consent-gated `thread/resume` +
`turn/start` wake when the session is dead — same consent bit as bindings.
Sessions open in an unreachable plain TUI are held in the inbox. Full spec:
[codex.md](codex.md).

### Layer 3 — Inbox (always)

If no waiter is connected and no binding matches (or the binding fails), the action stays `pending`: the card wears a badge, and every agent drains `surface actions` at session start. Nothing is ever lost. See [actions-inbox.md](actions-inbox.md).

## Coalescing & single-flight

Five rapid clicks must not spawn five Claudes. Per surface: at most one binding execution in flight; actions arriving during execution queue as pending and are delivered **as a batch** to the next execution (or to the waiter the spawned session may itself arm). The spawned command receives *all* pending actions for the surface, not just the triggering one.

## Worked sequences

**Live session:** agent creates panel + waiter → user clicks → waiter claims, prints, completes → agent replies → re-arms. Binding never fires.

**Two agents, one click:** both terminals receive the broadcast; both attempt the claim; one wins and prints, the other stays silent. No duplicated work, no second billed spawn.

**Cold start at 11pm:** no waiter → binding matches → `claude -p --resume …` spawns with the action batch on stdin → handles, replies, exits. Card showed ⟳ throughout.

**Everything dead:** no waiter, bindings disabled → badge on card → next morning's session runs `surface actions`, sees the click, handles it.

**Waiter connected but wedged:** the socket is open so the card reads "listening", but nothing is consuming stdout. The claim never comes; five seconds later the binding fires anyway. Before, this state black-holed the surface indefinitely.

## Why not connectors / MCP for wake-up

Connector-style integrations (including MCP) are *pull-shaped*: the agent calls tools when it decides to. No inbound push makes a session take a turn because an external event arrived. The only real inbound channels are (a) a background process completing — layer 1 — and (b) spawning/resuming a session — layer 2. OpenClaw is the exception precisely because it's already a daemon: for it, the webhook *is* push. If a harness ever ships true inbound triggers, it becomes one more binding recipe; nothing restructures.

## Related

- [bindings.md](bindings.md) — layer 2 in full (schema, recipes, security)
- [actions-inbox.md](actions-inbox.md) — layer 3 and ack semantics
- [../templates/ask.md](../templates/ask.md) — `ask --wait` rides layer 1
