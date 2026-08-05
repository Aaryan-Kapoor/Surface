# The Surface tour

> **For agents.** This is a demo, not a smoke test. The person on the other end
> has just installed something they have never used and has no idea what it is
> for. Your job is to show them, on their own screen, and to play along.
>
> **Read the rules before Step 0. They are the difference between a tour and a
> CI run.**

## Rules

1. **Watch in the background. Never block.** Before Step 0, start one
   long-running watcher (below) and leave it running for the whole tour. Every
   click, move, drag and drawing arrives as an event while your terminal stays
   free. **Do not run `surface wait` in the foreground at any point.** It holds
   your only terminal for up to fifteen minutes, so the user cannot talk to you
   and you cannot react to anything else — and because an action goes to exactly
   one claimant, a foreground `wait` and the watcher will fight over the same
   click.
2. **Say the quoted lines verbatim.** Every step has an **Agent says** line.
   Send it exactly. They are written to be read out; improvising here is how a
   tour turns into narration of a test plan.
3. **Never ask a question in the terminal.** Not with a harness question tool,
   not in chat. You are demonstrating a product whose entire premise is that the
   question goes on the screen. Use `surface ask`, a notification with buttons,
   or the demo in front of you. The one exception is Step 8, which is a
   conversation, not a question.
4. **Create and open are one move.** A surface you created but did not open is
   invisible — to them it looks like you stopped. Never end a turn between the
   two.
5. **Every step ends with a hand-off notification.** When you are done reacting
   and are waiting on them, send `surface notify … --button "Next=next"`. They
   can then move on from the tray or from the **Next** button on the page —
   either one reaches you as the same `next` action, and answering one closes
   the other.
6. **Never advance on your own.** You move on when `next` arrives, and not
   before. If they linger, let them.
7. **Never say "step 3 of 7", "this works", "all commands exited 0", or list
   what you are about to do.** No tables of results. No progress reports. The
   screen is the report.
8. **Never run `surface theme`** unless the user asks. It recolours everything
   they own.
9. **One surface at a time.** Push the next demo with `surface open --on <device>`
   so it replaces what is on screen. Do not leave seven cards behind.
10. **If something errors, say so plainly in one line and carry on** to the next
    step. A tour that stops at a broken step teaches nothing.

## Before you start

Find the device to drive:

```bash
surface status
```

Take the `device` of the entry with the most recent `last_activity`; that is
`<device>` everywhere below. If the list is empty, the user has not opened the
display yet — give them the URL from `surface pair` and wait.

Everything below assumes `SURFACE_URL` already points at the running service.
If `surface status` fails with `ECONNREFUSED`, the service is on a non-default
port — read it from `surface service health` and export `SURFACE_URL` before
continuing.

Set `tutorial: "in_progress"` in `~/.surface/install-state.json`.

### Start the watcher

This is the one command that makes the tour feel live. Run it **in the
background**, once, and keep it for the whole tour:

```bash
surface wait --follow
```

It prints one JSON line per action, on every surface, as it happens.

- **Claude Code:** run it with the `Monitor` tool (`persistent: true`), not with
  `Bash`. Each event wakes you with the action payload. If `Monitor` is not in
  your tool list, fetch it first — `ToolSearch` with the query
  `select:Monitor`.
- **Any other harness:** whatever your equivalent is — a background job you are
  notified about, a streaming tool call. If you genuinely have none, run the
  per-step `surface wait --id <id> --action <a> --timeout 900` instead and
  accept that you are blocked while it runs. That is the fallback, not the plan.

Stop the watcher at the end of the tour.

---

## Step 0 — The map

**Agent says:** "Here's everything I could put on your screen. Every one of
these is a Surface I'd build for you — pick whichever you want to see first and
we'll go through the rest after."

**Agent runs:**

```bash
TOUR=$(surface create "Surface tour" --template tour --agent tour \
  --metadata '{"demo":true}' | grep -oE '[0-9a-f-]{36}' | head -1)
surface open $TOUR --on <device>
```

The `pick` action's `data.choice` is one of `whiteboard`, `tictactoe`, `triage`,
`mockup`, `pdf`, `video`, `dashboard`, or `other` — one per step below, so the
menu promises exactly what the tour delivers. When it arrives, mark the menu
answered so it stops looking live:

```bash
surface patch $TOUR '{"status":"picked","picked":"<choice>"}'
```

**Order.** You go through **all seven**. The pick chooses where to start, not
what they get: begin at the step they picked, then continue down the list,
wrapping to the top, until every step has been seen once. `other` means they
typed something — build that first, show it, then start at Step 1.

Each step is: push the surface, say the line, react to the demo's own action,
send the hand-off notification, wait for `next`.

Every `surface create` below carries these four flags. `<n>` is the position in
*your* running order, counting from 1 — not the step's number in this document.
A step created without the rail params has no **Next** button, which strands
them.

```
--metadata '{"demo":true}' \
--param tour_step="<n> of 7" --param tour_next="Next" --param tour_id="<step-id>"
```

---

## Step 1 — The whiteboard

The one that surprises people. Do not explain it before they draw.

**Agent says:** "Draw something. Anything — a box, a face, an arrow. I'll look
at it properly, then draw on the same canvas."

**Agent runs:**

```bash
WB=$(surface create "Whiteboard" --template whiteboard --agent tour \
  --metadata '{"demo":true}' \
  --param title="Whiteboard" \
  --param prompt="Draw something and send it over." \
  --param tour_step="<n> of 7" --param tour_next="Next" --param tour_id="whiteboard" \
  | grep -oE '[0-9a-f-]{36}' | head -1)
surface open $WB --on <device>
```

The `snapshot` action carries `data.png` — a `data:image/png;base64,…` URL — and
`data.strokes`, the same drawing as normalised vectors. **Actually look at the
picture.** Write the base64 payload to a `.png` file (strip the
`data:image/png;base64,` prefix) and read that file with whatever image-reading
tool you have.

**Agent says:** one sentence about *what they actually drew*. Not "I received
your drawing." If it is a house, say it is a house. If it is unrecognisable, say
so cheerfully. This single sentence is the entire point of the step.

Then draw back. Strokes are `[{ points: [[x, y], …], width, erase }]` with `x`
and `y` from 0 to 1, origin top-left:

```bash
surface set $WB agent_strokes '[{"points":[[0.55,0.30],[0.75,0.30],[0.75,0.55],[0.55,0.55],[0.55,0.30]],"width":4}]'
surface notify "Drew on yours. Next when you've had a look." --id $WB --button "Next=next"
```

Add something to *their* drawing rather than starting your own in a corner.

---

## Step 2 — Tic-tac-toe

**Agent says:** "Your move. I'm playing along in real time — no refresh, no
'let me check', I just see it."

**Agent runs:**

```bash
TTT=$(surface create "Tic-tac-toe" --template tictactoe --agent tour \
  --metadata '{"demo":true}' \
  --param tour_step="<n> of 7" --param tour_next="Next" --param tour_id="tictactoe" \
  | grep -oE '[0-9a-f-]{36}' | head -1)
surface open $TTT --on <device>
```

Each `move` action carries `data.index`, 0–8, reading left to right, top to
bottom. Update the board and hand the turn back — `board` is nine characters,
`.` for empty:

```bash
surface set $TTT turn "agent"
surface set $TTT board "X...O...."
surface set $TTT turn "you"
```

Setting `turn` to `agent` first shows the board thinking. Play properly — take
the win, block the fork. Losing on purpose is obvious and it insults them.

When the game ends set `status` to `won`, `lost` or `draw`, put one line in
`note`, and hand off:

```bash
surface notify "Good game. Next when you're ready." --id $TTT --button "Next=next"
```

---

## Step 3 — The PR queue

**Agent says:** "Drag these where you think they belong. I'm not reading the
order you drop them in — I'm reading where on the plane they land."

**Agent runs:**

```bash
TRI=$(surface create "PR triage" --template triage --agent tour \
  --metadata '{"demo":true}' \
  --param title="PR triage" --param x_label="Effort" --param y_label="Impact" \
  --param items='[{"id":"pr-1","label":"Session expiry fix","meta":"#87 · +142 −18"},{"id":"pr-2","label":"Dashboard refresh","meta":"#86 · +2.1k −430"},{"id":"pr-3","label":"Bump a dependency","meta":"#82 · dependabot"},{"id":"pr-4","label":"Desktop bridge","meta":"#78 · +1.8k"},{"id":"pr-5","label":"Docs typo","meta":"#81 · +2 −2"}]' \
  --param tour_step="<n> of 7" --param tour_next="Next" --param tour_id="triage" \
  | grep -oE '[0-9a-f-]{36}' | head -1)
surface open $TRI --on <device>
```

The `ranked` action fires when they press **Send ranking**, and `data.items` is
every chip with `x`, `y` and the `quadrant` it landed in. They may send more
than once — read each one afresh rather than repeating yourself.

**Agent says:** read their layout back as a decision, in one or two sentences.
Name the specific things — "you'd ship the session fix first and let the
dependency bump wait" — not "I received five placements." Then:

```bash
surface set $TRI note "<the same read, one short line>"
surface notify "Done reading your triage. Next when you want the design review." --id $TRI --button "Next=next"
```

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
MK=$(surface create "Which button?" --template mockup --agent tour \
  --metadata '{"demo":true}' \
  --param title="Which button?" \
  --param question="Same action, four takes." \
  --param variants='[{"label":"A","caption":"Filled","html":"<button style=\"font:600 14px system-ui;color:#0a0a0a;background:#fff;border:0;border-radius:10px;padding:12px 22px\">Deploy to production</button>"}, …]' \
  --param tour_step="<n> of 7" --param tour_next="Next" --param tour_id="mockup" \
  | grep -oE '[0-9a-f-]{36}' | head -1)
surface open $MK --on <device>
```

The `vote` action's `data.choice` is the label; `data.text` is why, if they said.

**Agent says:** one sentence agreeing or pushing back with a reason. A design
review where the reviewer always agrees is not a review.

```bash
surface patch $MK '{"status":"voted","chosen":"<label>"}'
surface notify "Noted. Next when you're ready — a number that moves." --id $MK --button "Next=next"
```

---

## Step 5 — A number that moves

**Agent says:** "Watch the number. I'm not rebuilding the page — the page is
already there and I'm just changing what it says."

**Agent runs:**

```bash
G=$(surface create "Deploy" --template gauge --agent tour \
  --metadata '{"demo":true}' \
  --param title="Deploy" --param unit="%" --param max=100 \
  --param tour_step="<n> of 7" --param tour_next="Next" --param tour_id="gauge" \
  | grep -oE '[0-9a-f-]{36}' | head -1)
surface open $G --on <device>
```

Then move it, with real pauses — this only lands if they watch it change:

```bash
surface set $G value 12  && surface set $G label "Building"
sleep 2
surface set $G value 48  && surface set $G label "Running tests"
sleep 2
surface set $G value 91  && surface set $G label "Uploading"
sleep 2
surface set $G value 100 && surface set $G label "Live"
surface set $G note "The HTML never changed. Only the state did."
```

**Agent says:** "That's `surface set`. The same three words work on any surface
you leave up — a build, a queue depth, a countdown, whatever you want to glance
at."

```bash
surface notify "Next when you're ready — a document." --id $G --button "Next=next"
```

---

## Step 6 — A document, not markup

**Agent says:** "Not everything worth showing you is HTML. This is a PDF, opened
in your own browser's reader."

**Agent runs:** the tour ships one. It is inside the installed package:

```bash
PDF=$(surface present "$(npm root -g)/surface-display/examples/tour/surface-brief.pdf" \
  --title "Surface brief" --metadata '{"demo":true}' | grep -oE '[0-9a-f-]{36}' | head -1)
surface open $PDF --on <device>
```

**Agent says:** "`surface present` takes a PDF, an image, a markdown file —
anything you'd otherwise have to describe to me or screenshot at me."

A presented document has no rail, so the notification is the *only* way on.
Send it and then leave them alone — do not ask whether they have finished
reading:

```bash
surface notify "Read at your own pace. Next when you want the last one." --id $PDF --button "Next=next"
```

If they ask whether you can highlight or annotate inside it: no. It is the
browser's own reader and `surface exec` does not reach into it. What you can do
is re-render the same document as a `doc` surface, where a highlight is just
markup — offer that, do not pretend.

---

## Step 7 — Something to watch, that you can talk about

**Agent says:** "And it plays video — but watch the bar under it. Ask me
something while it's running and I'll know the second you asked at."

**Agent runs:**

```bash
V=$(surface create "For you" --template video --agent tour \
  --metadata '{"demo":true}' \
  --param url="https://youtu.be/DWcqbPm_Rn4?t=195" \
  --param autoplay=true --param loop=false \
  --param tour_step="<n> of 7" --param tour_next="Next" --param tour_id="video" \
  | grep -oE '[0-9a-f-]{36}' | head -1)
surface open $V --on <device>
```

Autoplay is muted — browsers require it — so say so:

**Agent says:** "It's muted. Browsers insist."

An `ask` action carries `{ text, t, duration, video_id }`: `t` is the second
they were on. **Answer in the surface, not the terminal** — that is the whole
point of the step:

```bash
surface patch $V '{"reply":"<your answer>"}'
```

You know the video id and the second. Fetch the transcript however you normally
would and answer from the passage at that timestamp — the surface tells you
*where*, finding out *what* is your job. If you can't get a transcript, say so
in the reply rather than bluffing.

Two things worth showing off once they've asked something:

```bash
# pin moments they can click
surface patch $V '{"markers":[{"t":195,"label":"where you asked"},{"t":236,"label":"the payoff"}]}'
# or just take them there
surface patch $V '{"seek_to":{"t":236,"nonce":1}}'
```

Then hand off:

```bash
surface notify "Last one. Next when you've had enough." --id $V --button "Next=next"
```

---

## Step 8 — What it's actually for

Now the useful part, and the only step that happens in the terminal.

Send one notification with buttons. This is also a demo: it is the lightest way
you have to ask for one bit of intent, and it survives a reload in their tray.

```bash
surface notify "That's the tour. Want the two-minute version of how to use this day to day?" \
  --id $TOUR --button "Go on=explain" --button "I'm good=skip"
```

If they press **I'm good**, say: "It's all in the tray icon up top if you want
it later," and go to cleanup.

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
- *Approvals* — long jobs that need one decision in the middle, answered from a
  phone instead of blocking a terminal all afternoon.
- *Documents* — PDFs, reports, images, anything you would otherwise squint at in
  a pager.
- *Dashboards* — one card you leave up, that the agent keeps current.

**One thing to try today.** Give them a concrete first move based on what they
just said, not a menu. If they mentioned reviewing code: "next time I'm about to
make a big change, tell me to surface the plan first."

### Cleanup

```bash
surface clear-demos
surface open --on <device>     # back to the grid
```

Stop the background watcher. Set `tutorial: "complete"` and `installed_at` to
the current ISO timestamp in `~/.surface/install-state.json`.

`clear-demos` only finds surfaces tagged `metadata.demo` — that is why every
create above carries `--metadata '{"demo":true}'`. If you skipped it, the tour
is still sitting in their grid; delete those ids yourself.

---

## If they want out

At any point, if they say stop: say "Fine — it's all in `surface --help` and the
tray icon when you want it," run the cleanup above, set `tutorial: "skipped"`,
and stop. Do not talk them back into it.

## Reference

| Command | What it does |
|---|---|
| `surface wait --follow` | stream every action as it happens — run this in the background |
| `surface create --template <t>` | build from a shipped template |
| `surface link <abs-path>` | serve a file from the user's project, live |
| `surface present <abs-path>` | one-shot PDF / image / markdown |
| `surface set <id> <key> <value>` | change what a surface says without touching its HTML |
| `surface patch <id> <json>` | change several keys at once |
| `surface open <id> --on <device>` | put a surface on a specific screen |
| `surface notify <text> --id <id> --button "L=a"` | a notification they can answer |
| `surface reply <id> <text>` | a toast on the surface they are looking at |
| `surface wait --id <id> --action <a>` | block until the user does the thing — fallback only |

Templates that ship with Surface: `ask`, `board`, `doc`, `gauge`, `mockup`,
`stream`, `tictactoe`, `tour`, `triage`, `video`, `whiteboard`.
