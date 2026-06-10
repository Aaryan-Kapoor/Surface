# `ask` — Context-Full Questions

**Status:** Approved — not yet built (Phase 2; cold-start answer delivery rides Phase 3)
**Code (current):** none

`surface ask` is the human-in-the-loop primitive: an agent posts a question that renders on **every paired display**, and the user answers from wherever they are. It makes the phone the approval remote for every agent on the system.

The design constraint that shapes everything: **a context-free question is worse than useless.** "Deploy to prod? [Yes] [No]" with no surrounding state forces the user to walk back to the terminal to answer responsibly — which defeats the feature. The agent already holds the context; `ask` makes attaching it one flag.

## Usage

```bash
surface ask "Ship v2.1 to prod?" \
  --options "ship,hold" \
  --context - \
  --wait <<EOF
### What changes
$(git log --oneline v2.0..HEAD | head -20)

### Test status
132 passed, 0 failed · staging soak: 4h clean

### Exact rollout
\`\`\`
kubectl set image deploy/api api=registry/api:2.1.0
\`\`\`
EOF
```

| Flag | Meaning |
|---|---|
| `--options a,b,c` | Renders option buttons (each becomes the answer `choice`) |
| `--freetext` | Adds a text input (answer `text`); combinable with options |
| `--context -` / `--context-file <p>` | Markdown context block, rendered (diffs, test output, the SQL about to run) |
| `--wait` | Block until answered; print answer JSON to stdout; exit 0 (implicit ack). Exit 3 on `--timeout` |
| `--timeout <s>` | With `--wait`; also expires the card (it flips to "expired") |
| `--on <device>` | Additionally navigate that device to the question ([../display/devices.md](../display/devices.md)) |
| `--id`, `--agent`, `--title` | As on `surface create` |

## Behavior

1. Instantiates the built-in `ask` template: question headline, rendered context block, option buttons / text input.
2. The user's answer emits a single action: `{ action: "answer", data: { choice: "ship", text?: "…" } }`.
3. Delivery follows the [ladder](../interaction/delivery-ladder.md): a `--wait`ing agent gets it immediately (layer 1); otherwise a binding can revive the asking session (`--on-action answer --run 'claude --resume {session} -p …'`); otherwise it lands in the inbox.
4. After answering, the card flips to its answered state — chosen option highlighted, card dimmed — so a question is never answered twice. Expired asks render struck-through.

`--wait` output:

```json
{ "choice": "ship", "text": null, "answered_at": "2026-06-10T22:41:12Z", "device": "phone" }
```

## Template contract

- **Params:** `question` (string, required), `context_md` (markdown), `options` (string list), `freetext` (bool), `expires_at` (timestamp).
- **State:** `status: open | answered | expired`, `answer` — set by the server, bindable by custom ask variants.
- **Actions:** `answer`.

Users/projects can override the built-in with their own ask layout ([resolution order](overview.md#resolution-order)).

## Related

- [../interaction/delivery-ladder.md](../interaction/delivery-ladder.md) — how the answer finds the asker
- [../display/devices.md](../display/devices.md) — `--on` targeting
- [overview.md](overview.md) — template machinery
