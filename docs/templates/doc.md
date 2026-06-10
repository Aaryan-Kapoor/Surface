# `doc` — Markdown Files from the Repo

**Status:** Shipped (2026-06)
**Code:** `templates/doc/`, `bin/surface.ts` (`doc`), `server/markdown.ts`, the on-the-fly template render in `server/routes/artifacts.ts` (`GET /artifacts/:id/view`)

`surface doc` puts a markdown file from the user's repo on a display as a properly rendered document — README, design doc, an agent-written report — with live reload when the file changes. It's the [linked-artifact](../core/linked-artifacts.md) hot-reload story applied to documents: the file stays in git where it belongs; Surface renders it.

## Usage

```bash
surface doc ./README.md
surface doc ./docs/design.md --title "Design: payment flow" --toc
surface doc ./reports/2026-06-10-audit.md --agent claude-code
```

Equivalent to `surface link <abs-path>` wrapped in the `doc` template. After editing the file:

```bash
surface touch <id>     # displays re-render the new content
```

## Behavior

- **Rendering:** GitHub-flavored markdown — headers, tables, task lists, blockquotes, fenced code (no syntax highlighting; `server/markdown.ts` escapes input and emits no raw HTML). Relative image links resolve against the linked file's directory (served through the linked-artifact file route with its existing path/symlink protections).
- **`--toc`:** sticky table-of-contents sidebar generated from headings; collapses on narrow viewports (phone).
- **Reading layout:** comfortable measure (~70ch), theme-aware, print-clean.
- **Live reload:** standard linked-artifact semantics — edit on disk, `surface touch`, every display updates. The repo's git history is the document's version history; Surface deliberately keeps none.

## Why a template and not just "render .md"

The artifact shell can already display raw markdown bytes. The template adds the *document* affordances (TOC, layout, relative-asset resolution, link handling) and gives agents a stable one-liner — the difference between "technically renders" and something you'd actually read a design doc in.

## Template contract

- **Params:** `content_url` (URL of the raw markdown — supplied implicitly by the engine at render time), `title` (string), `toc` (boolean, default false), `width` (`narrow | default | wide`).
- **State / actions:** none by default.

Because the linked entry isn't HTML, the template is rendered **on the fly** at view time (`GET /artifacts/:id/view`): the template fetches the live bytes via `content_url`, so `touch` reload works without any stored render.

## Related

- [../core/linked-artifacts.md](../core/linked-artifacts.md) — the linking/touch machinery underneath
- [overview.md](overview.md) — template resolution and overrides
