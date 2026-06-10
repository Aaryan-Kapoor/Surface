# Authoring Templates

**Status:** Approved — not yet built (Phase 2)
**Code (current):** none

Agents are expected to author templates, not just consume them. The SKILL.md rule of thumb: **before building the same UI a second time, make it a template.** A template costs a few minutes once and turns every future instance into one CLI line.

## Two ways to create one

### Promote an existing surface

The natural path — an agent builds a one-off surface, it works, it's worth keeping:

```bash
surface template create release-card --from <artifact-id>
```

This copies the artifact's HTML into a template directory, scaffolds `template.json`, and (best-effort) suggests params for the literal values it finds. The agent then edits the contract: which hard-coded strings become `{{params}}`, which numbers become state vars.

### Scaffold by hand

```bash
mkdir -p .surface/templates/release-card
$EDITOR .surface/templates/release-card/template.json index.html
```

## Where to save

| Location | When |
|---|---|
| `<project>/.surface/templates/` | Project-specific UI (a release card for *this* repo's release flow). Committed; reviewable; ships with the project. |
| `~/.surface/templates/` | Cross-project personal UI (your preferred ask layout, a standard report frame). |

Project templates override user templates override built-ins ([overview.md](overview.md#resolution-order)).

## The contract (`template.json`)

Keep params few and typed; everything else is state or content:

- **`params`** — set once at instantiation (`string`, `number`, `boolean`, `markdown`, `url`). `markdown` params render server-side; `url` params are validated.
- **`state`** — variables that change while the surface lives; declare them so `surface sync` can type-check and default them ([../state/stateful-surfaces.md](../state/stateful-surfaces.md)).
- **`actions`** — names the template emits, so `surface template show` documents what to `wait` for or [bind](../interaction/bindings.md).

## Markup conventions

- `{{param}}` is HTML-escaped; use `{{{param}}}` only for trusted pre-rendered HTML (e.g. server-rendered markdown).
- Bind live values with `data-surface-bind="key"` / `data-surface-show="key"` instead of writing JS.
- Emit actions with `Surface.action("ship", {version: "2.1"})` — the injected runtime handles delivery.
- Self-contained: inline CSS or use `assets/`; no external CDNs (surfaces should render offline, and thumbnails capture headless).

## Testing

```bash
surface create "test" --template release-card --param version=0.0 --id tpl-test
surface set tpl-test stage building        # exercise state bindings
surface wait --surface tpl-test --timeout 60   # exercise actions, then click in the browser
surface delete tpl-test
```

## Related

- [overview.md](overview.md) — anatomy, resolution, instantiation
- [../state/project-directory.md](../state/project-directory.md) — committing project templates
- [../core/thumbnails.md](../core/thumbnails.md) — templates get screenshots like any surface
