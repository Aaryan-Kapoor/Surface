# Surface Use Cases

Surface is a local display runtime for agents. The current contract is the `surface` CLI, artifact routes, injected `surface.js`, and the delivery ladder. Older brainstorming that described pre-CLI tool names and unshipped slot/theme behavior is preserved in `archived/USECASES.md`.

## High-value patterns

### Ask and act

Use `surface ask` when the agent needs a decision with context, then continue from the returned answer:

```bash
surface ask "Ship this release?" --options "ship,hold" --wait --context -
```

This is the right shape for deploy gates, review approval, picking between designs, and any moment where a free-form chat prompt would lose context.

### Live task dashboard

Create a stable HTML artifact for a workflow, then update its JSON state:

```bash
surface create "Build" --id build --template stream
surface set build progress 0.42
surface append build - --md
```

The display stays current without rewriting HTML. This fits test runs, migrations, indexing jobs, long research, and multi-agent work boards.

### Interactive control panel

Build a self-contained HTML artifact that calls `Surface.action()` only at meaningful commit points:

```html
<button onclick='Surface.action("approve", {target:"prod"})'>Approve</button>
```

The action lands in `surface wait`, a binding, or the inbox. This fits approval panels, tuning UIs, wizard-style workflows, and generated tools that need a return channel.

### Linked project preview

Use `surface link` for files the agent will keep editing in the project:

```bash
surface link "$PWD/demo.html" --title "Prototype"
surface touch <id>
```

Surface re-serves the real file, so the project remains the source of truth. This fits design prototypes, generated reports that are committed, static previews, and runnable single-file tools.

### Report document

When the user needs to scan or revisit substantial output, write it as markdown in the repo and surface it as a rendered document:

```bash
surface doc ./reports/2026-07-05-audit.md --toc
```

The file stays in git as the source of truth and the surface hot-reloads when you edit it. This fits code review summaries, research briefs, debugging writeups, incident notes, and final task reports that would otherwise become hard-to-read terminal walls.

### Shared agent board

Keep the global `board` artifact fresh during significant work:

```bash
surface set board codex '{"status":"tests running","project":"Surface","link":"build"}'
```

This lets the user see what each agent is doing without asking for status, and lets agents coordinate through the same display.

## Boundaries

- Surface is single-user local-first software. It is not a multi-tenant SaaS collaboration backend.
- Generated HTML runs in sandboxed iframes and should be self-contained: inline CSS/JS, no CDN dependency for core function.
- Device sessions can view, click, and control the display; system-plane routes remain for local agents and explicit system sessions.
- Wake bindings require recorded project consent in `.surface/config.json`; use live waiters first and inbox fallback always.
- Display slots are artifacts with `metadata.display_role`, not raw HTML keys in theme config.

## First-run demo set

The seed demos in `examples/demos/` intentionally demonstrate product primitives instead of third-party embeds:

- `ask-approval.html` — answer flow and `Surface.action`.
- `state-gauge.html` — state binding and progress.
- `action-panel.html` — multiple user actions.
- `stream-build.html` — live log shape.
- `board-ops.html` — shared agent status board.
- `report-brief.html` — readable long-form report shape.
- `live-link.html` — linked-file hot reload.
