# `doc` — Markdown Files from the Repo

**Status:** Approved — not yet built (Phase 2)
**Code (current):** raw markdown rendering exists in the artifact shell (`GET /artifacts/:id/view`); this template is the first-class wrapper

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

- **Rendering:** GitHub-flavored markdown — headers, tables, task lists, fenced code with syntax highlighting, footnotes. Relative image links resolve against the linked file's directory (served through the linked-artifact file route with its existing path/symlink protections).
- **`--toc`:** sticky table-of-contents sidebar generated from headings; collapses on narrow viewports (phone).
- **Reading layout:** comfortable measure (~70ch), theme-aware, print-clean.
- **Live reload:** standard linked-artifact semantics — edit on disk, `surface touch`, every display updates. The repo's git history is the document's version history; Surface deliberately keeps none.

## Why a template and not just "render .md"

The artifact shell can already display raw markdown bytes. The template adds the *document* affordances (TOC, layout, relative-asset resolution, link handling) and gives agents a stable one-liner — the difference between "technically renders" and something you'd actually read a design doc in.

## Template contract

- **Params:** `path` (the linked file — supplied by the sugar command), `toc` (boolean, default false), `width` (`narrow | default | wide`).
- **State / actions:** none by default.

## Related

- [../core/linked-artifacts.md](../core/linked-artifacts.md) — the linking/touch machinery underneath
- [overview.md](overview.md) — template resolution and overrides
