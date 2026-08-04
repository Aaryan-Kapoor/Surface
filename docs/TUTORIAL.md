# The Surface tour

> **For agents.** This is a demo, not a smoke test. The person on the other end
> has just installed something they have never used and has no idea what it is
> for. Your job is to show them, on their own screen, and to play along.
>
> **Read the rules before Step 0. They are the difference between a tour and a
> CI run.**

## Rules

1. **Say the quoted lines verbatim.** Every step below has an **Agent says**
   line. Send it exactly. They are written to be read out; improvising here is
   how a tour turns into narration of a test plan.
2. **Never ask a question in the terminal.** Not with a harness question tool,
   not in chat. You are demonstrating a product whose entire premise is that
   the question goes on the screen. Use `surface ask`, a notification with
   buttons, or the demo in front of you. The one exception is Step 8, which is
   a conversation, not a question.
3. **Never say "step 3 of 7", "this works", "all commands exited 0", or list
   what you are about to do.** No tables of results. No progress reports. The
   screen is the report.
4. **Never run `surface theme`** unless the user asks. It recolours everything
   they own.
5. **Never advance on your own.** Each demo carries a **Next** button. You move
   on when that arrives as an action, and not before. If they linger, let them.
6. **One surface at a time.** Push the next demo with `surface open --on <device>`
   so it replaces what is on screen. Do not leave seven cards behind.
7. **If something errors, say so plainly in one line and carry on** to the next
   step. A tour that stops at a broken step teaches nothing.

## Before you start

Find the device to drive:

```bash
surface status
```

Take the `device` of the entry with the most recent `last_activity`; that is
`<device>` everywhere below. If the list is empty, the user has not opened the
display yet — give them the URL from `surface pair` and wait.

Set `tutorial: "in_progress"` in `~/.surface/install-state.json`.

Everything below assumes `SURFACE_URL` already points at the running service.
If `surface status` fails with `ECONNREFUSED`, the service is on a non-default
port — read it from `surface service health` and export `SURFACE_URL` before
continuing.

---

## Step 0 — The map

**Agent says:** "Here's everything I could put on your screen. Every one of
these is a Surface I'd build for you — pick whichever you want to see first and
we'll go through the rest after."

**Agent runs:**

```bash
surface create "Surface tour" --template tour --agent tour
surface open <tour-id> --on <device>
```

Then wait for the choice:

```bash
surface wait --id <tour-id> --action pick --timeout 900
```

The action's `data.choice` is one of `whiteboard`, `tictactoe`, `triage`,
`mockup`, `pdf`, `video`, `dashboard`, or `other` — one per step below, so the
menu promises exactly what the tour delivers. Mark the menu answered so it stops
looking live:

```bash
surface patch <tour-id> '{"status":"picked","picked":"<choice>"}'
```

**Order.** The steps below are the running order. Start at whichever one they
picked, then continue down the list, wrapping to the top, until every step has
been seen once. `other` means they typed something — build it yourself, show
it, and then start at Step 1.

Each step is: push the surface, say the line, wait for the demo's own action,
react to it, then wait for `next`. The `next` action is how you learn they are
done. Never skip the wait.

Every `surface create` below takes these three params so the step's rail shows
up. `<n>` is the position in the running order:

```
--param tour_step="<n> of 7" --param tour_next="Next" --param tour_id="<step-id>"
```

---

## Step 1 — The whiteboard

The one that surprises people. Do not explain it before they draw.

**Agent says:** "Draw something. Anything — a box, a face, an arrow. I'll look
at it properly, then draw on the same canvas."

**Agent runs:**

```bash
surface create "Whiteboard" --template whiteboard --agent tour \
  --param title="Whiteboard" \
  --param prompt="Draw something and send it over." \
  --param tour_step="<n> of 7" --param tour_next="Next" --param tour_id="whiteboard"
surface open <wb-id> --on <device>
surface wait --id <wb-id> --action snapshot --timeout 900
```

The action carries `data.png` — a `data:image/png;base64,...` URL — and
`data.strokes`, the same drawing as normalised vectors. **Actually look at the
picture.** Write it to a file and open it with whatever image-reading tool you
have:

```bash
node -e 'const a=require("fs").readFileSync("/tmp/snap.json","utf8");' # or however your harness reads the action payload
# decode data.png (strip the "data:image/png;base64," prefix) to /tmp/whiteboard.png, then read that file as an image
```

**Agent says:** one sentence about *what they actually drew*. Not "I received
your drawing." If it is a house, say it is a house. If it is unrecognisable,
say so cheerfully. This single sentence is the entire point of the step.

Then draw back. Strokes are `[{ points: [[x, y], ...], width, erase }]` with `x`
and `y` from 0 to 1, origin top-left:

```bash
surface set <wb-id> agent_strokes '[{"points":[[0.55,0.30],[0.75,0.30],[0.75,0.55],[0.55,0.55],[0.55,0.30]],"width":4}]'
surface set <wb-id> note "Your turn — clear it and draw over mine."
```

Add something to *their* drawing rather than starting your own in a corner.

Wait for `next` on `<wb-id>` before moving on.

---

## Step 2 — Tic-tac-toe

**Agent says:** "Your move. I'm playing along in real time — no refresh, no
'let me check', I just see it."

**Agent runs:**

```bash
surface create "Tic-tac-toe" --template tictactoe --agent tour \
  --param tour_step="<n> of 7" --param tour_next="Next" --param tour_id="tictactoe"
surface open <ttt-id> --on <device>
```

Then loop, one move at a time:

```bash
surface wait --id <ttt-id> --action move --timeout 900
```

`data.index` is 0–8, reading left to right, top to bottom. Update the board and
hand the turn back. `board` is nine characters, `.` for empty:

```bash
surface set <ttt-id> board "X...O...."
surface set <ttt-id> turn "you"
```

Between your move and theirs, set `turn` to `agent` so the board shows you
thinking. Play properly — take the win, block the fork. Losing on purpose is
obvious and it insults them.

When the game ends set `status` to `won`, `lost` or `draw`, and put one line in
`note`. Then wait for `next`.

---

## Step 3 — The PR queue

**Agent says:** "Drag these where you think they belong. I'm not reading the
order you drop them in — I'm reading where on the plane they land."

**Agent runs:**

```bash
surface create "PR triage" --template triage --agent tour \
  --param title="PR triage" --param x_label="Effort" --param y_label="Impact" \
  --param items='[{"id":"pr-1","label":"Session expiry fix","meta":"#87 · +142 −18"},{"id":"pr-2","label":"Dashboard refresh","meta":"#86 · +2.1k −430"},{"id":"pr-3","label":"Bump a dependency","meta":"#82 · dependabot"},{"id":"pr-4","label":"Desktop bridge","meta":"#78 · +1.8k"},{"id":"pr-5","label":"Docs typo","meta":"#81 · +2 −2"}]' \
  --param tour_step="<n> of 7" --param tour_next="Next" --param tour_id="triage"
surface open <tri-id> --on <device>
surface wait --id <tri-id> --action ranked --timeout 900
```

`data.items` is every chip with `x`, `y` and the `quadrant` it landed in.

**Agent says:** read their layout back as a decision, in one or two sentences.
Name the specific things — "you'd ship the session fix first and let the
dependency bump wait" — not "I received five placements." Then:

```bash
surface set <tri-id> note "<the same read, one short line>"
```

Wait for `next`.

---

## Step 4 — Pick a design

**Agent says:** "Same button, four ways. Pick the one you'd actually ship and
tell me why — this is what a design review looks like when I can just show
you."

**Agent runs:** build four genuinely different variants — not four shades of
one. Each `html` renders in its own frame, so a variant cannot restyle its
neighbours. Keep each to one component on a transparent background; the frame
centres it for you.

```bash
surface create "Which button?" --template mockup --agent tour \
  --param title="Which button?" \
  --param question="Same action, four takes." \
  --param variants='[{"label":"A","caption":"Filled","html":"<button style=\"font:600 14px system-ui;color:#0a0a0a;background:#fff;border:0;border-radius:10px;padding:12px 22px\">Deploy to production</button>"}, ...]' \
  --param tour_step="<n> of 7" --param tour_next="Next" --param tour_id="mockup"
surface open <mk-id> --on <device>
surface wait --id <mk-id> --action vote --timeout 900
```

`data.choice` is the label; `data.text` is why, if they said.

**Agent says:** one sentence agreeing or pushing back with a reason. A design
review where the reviewer always agrees is not a review.

```bash
surface patch <mk-id> '{"status":"voted","chosen":"<label>"}'
```

Wait for `next`.

---

## Step 5 — A number that moves

**Agent says:** "Watch the number. I'm not rebuilding the page — the page is
already there and I'm just changing what it says."

**Agent runs:**

```bash
surface create "Deploy" --template gauge --agent tour \
  --param title="Deploy" --param unit="%" --param max=100 \
  --param tour_step="<n> of 7" --param tour_next="Next" --param tour_id="gauge"
surface open <g-id> --on <device>
```

Then move it, with real pauses — this only lands if they watch it change:

```bash
surface set <g-id> value 12  && surface set <g-id> label "Building"
sleep 2
surface set <g-id> value 48  && surface set <g-id> label "Running tests"
sleep 2
surface set <g-id> value 91  && surface set <g-id> label "Uploading"
sleep 2
surface set <g-id> value 100 && surface set <g-id> label "Live"
surface set <g-id> note "The HTML never changed. Only the state did."
```

**Agent says:** "That's `surface set`. The same three words work on any surface
you leave up — a build, a queue depth, a countdown, whatever you want to glance
at."

Wait for `next`.

---

## Step 6 — A document, not markup

**Agent says:** "Not everything worth showing you is HTML. This is a PDF,
opened in your own browser's reader."

**Agent runs:** the tour ships one. It is inside the installed package:

```bash
surface present "$(npm root -g)/surface-display/examples/tour/surface-brief.pdf" --title "Surface brief"
surface open <pdf-id> --on <device>
```

**Agent says:** "`surface present` takes a PDF, an image, a markdown file —
anything you'd otherwise have to describe to me or screenshot at me."

There is no rail on a presented document, so this one advances on your word.
Wait about fifteen seconds, then move on. Do not ask whether they have finished
reading.

---

## Step 7 — Something to watch

**Agent says:** "And it plays video. This one's for you."

**Agent runs:**

```bash
surface create "For you" --template video --agent tour \
  --param url="https://www.youtube.com/watch?v=dQw4w9WgXcQ" \
  --param autoplay=true --param loop=false \
  --param tour_step="<n> of 7" --param tour_next="Next" --param tour_id="video"
surface open <v-id> --on <device>
```

Autoplay is muted — browsers require it — so say so:

**Agent says:** "It's muted. Browsers insist. Unmute it, you'll know it."

Wait for `next`.

---

## Step 8 — What it's actually for

Now the useful part, and the only step that happens in the terminal.

Send one notification with buttons. This is also a demo: it is the lightest way
you have to ask for one bit of intent, and it goes into their notification tray
so it survives a reload.

```bash
surface notify "That's the tour. Want the two-minute version of how to use this day to day?" \
  --id <tour-id> --button "Go on=explain" --button "I'm good=skip"
surface wait --id <tour-id> --timeout 600   # either button; read .action
```

If they press **I'm good**, say: "It's all in the tray icon up top if you want
it later," set `tutorial: "complete"`, and stop.

If they press **Go on**, say this — in your own words is fine here, but cover
all four:

**Say it out loud.** Nothing to configure. Say *"surface it"*, *"put that on my
surface"*, *"show me on the display"*, or *"ask me on my phone"* and the agent
does the rest. It reads `SKILL.md`, so plain English is the whole interface.

**It works when you are not there.** The agent that asks the question does not
have to be alive when you answer it. A click waits in the inbox until something
drains it. That is the difference between this and a chat window.

**Where it fits.** Ask them which of these is them, and mean it:

- *Plans and diffs* — "surface the plan before you write it" beats scrolling a
  wall of proposed changes in a terminal.
- *Approvals* — long jobs that need one decision in the middle, answered from
  a phone instead of blocking a terminal all afternoon.
- *Documents* — PDFs, reports, images, anything you would otherwise squint at
  in a pager.
- *Dashboards* — one card you leave up, that the agent keeps current.

**One thing to try today.** Give them a concrete first move based on what they
just said, not a menu. If they mentioned reviewing code: "next time I'm about
to make a big change, tell me to surface the plan first."

Then:

```bash
surface clear-demos
```

Set `tutorial: "complete"` and `installed_at` to the current ISO timestamp in
`~/.surface/install-state.json`.

---

## If they want out

At any point, if they say stop: say "Fine — it's all in `surface --help` and
the tray icon when you want it," run `surface clear-demos`, set `tutorial:
"skipped"`, and stop. Do not talk them back into it.

## Reference

| Command | What it does |
|---|---|
| `surface create --template <t>` | build from a shipped template |
| `surface link <abs-path>` | serve a file from the user's project, live |
| `surface present <abs-path>` | one-shot PDF / image / markdown |
| `surface set <id> <key> <value>` | change what a surface says without touching its HTML |
| `surface patch <id> <json>` | change several keys at once |
| `surface open <id> --on <device>` | put a surface on a specific screen |
| `surface wait --id <id> --action <a>` | block until the user does the thing |
| `surface notify <text> --id <id> --button "L=a"` | a notification they can answer |
| `surface reply <id> <text>` | a toast on the surface they are looking at |

Templates that ship with Surface: `ask`, `board`, `doc`, `gauge`, `mockup`,
`stream`, `tictactoe`, `tour`, `triage`, `video`, `whiteboard`.
