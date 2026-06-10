# Templates

**Status:** Approved — not yet built (Phase 2)
**Code (current):** none

A **template** is a parameterized, reusable surface: real dynamic UI that an agent instantiates with one CLI line instead of regenerating 200 lines of HTML every time. Dynamic UI is Surface's moat — templates are how that moat becomes repeatable. The [`ask`](ask.md) template isn't a text dialog; it's a rendered context block, option cards, and pre-wired actions, for the cost of a flag.

## Anatomy

A template is a directory:

```
release-card/
  template.json    # contract: params, state vars, actions emitted
  index.html       # markup with {{param}} slots and data-surface-bind hooks
  assets/          # optional css/js/img, served alongside
```

`template.json`:

```json
{
  "name": "release-card",
  "description": "Release summary with ship/hold actions",
  "params": {
    "version":  { "type": "string", "required": true },
    "notes_md": { "type": "markdown", "default": "" }
  },
  "state": { "stage": "string" },
  "actions": ["ship", "hold"]
}
```

- **Slots:** `{{param}}` interpolates HTML-escaped; `{{{param}}}` is the opt-in raw form; `markdown`-typed params are rendered to HTML server-side.
- **Live data:** templates declare state vars and bind them in markup (`data-surface-bind`) — see [../state/stateful-surfaces.md](../state/stateful-surfaces.md).
- **Actions:** emitted via the injected `Surface.action(name, data)` helper, no postMessage boilerplate.

## Resolution order

1. Project: `<project>/.surface/templates/<name>/`
2. User: `~/.surface/templates/<name>/`
3. Built-in: shipped with Surface (`templates/` in the repo)

First match wins, so a project can override a built-in.

## Instantiation

```bash
surface create "Release 2.1" --template release-card --param version=2.1 --param notes_md=- <<EOF
### Highlights
…
EOF
```

Interpolation happens server-side and produces a **normal artifact** — thumbnails, SSE, state, versions all work unchanged downstream. Re-running with the same `--id` updates params and re-renders. Sugar verbs (`surface ask`, `surface video`, `surface doc`, `surface append`) wrap common templates so the everyday cases are one short command.

```bash
surface template list             # name, source (project/user/built-in), description
surface template show <name>      # the contract: params, state, actions
```

## Built-ins

| Template | Sugar | One line |
|---|---|---|
| [`ask`](ask.md) | `surface ask` | Context-full question with option buttons; the human-in-the-loop primitive |
| [`stream`](stream.md) | `surface append` | Append-only live log/narration viewer |
| [`video`](video.md) | `surface video` | YouTube/embed player done right |
| [`board`](board.md) | — | Multi-agent status board with per-agent sections |
| [`doc`](doc.md) | `surface doc` | A markdown file from the repo, rendered, with live reload |

## Related

- [authoring.md](authoring.md) — creating your own templates (agents are expected to)
- [../state/stateful-surfaces.md](../state/stateful-surfaces.md) — what makes templates live
- [../state/project-directory.md](../state/project-directory.md) — project-local templates in `.surface/`
