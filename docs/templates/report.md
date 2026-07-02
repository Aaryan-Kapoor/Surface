# Report Template

**Status:** Shipped (2026-07)
**Code:** `templates/report/`

`report` is the built-in for long explanations, audit summaries, launch notes,
research briefs, and other content that should be read as a polished surface
rather than pasted into chat.

```bash
surface create "Audit Summary" \
  --template report \
  --param title="Audit Summary" \
  --param summary="High-level outcome" \
  --param body_md=-
```

The main body is markdown (`body_md`) rendered server-side. Use `summary` for
the short result or decision, and `width=narrow|default|wide` to tune the
reading measure.
