# Surface Tutorial

> **For agents:** narrate each step to the user. Run the commands shown. Wait for visual confirmation before advancing. Update the `tutorial` field in `~/.surface/install-state.json` to `in_progress` after Step 1 and `complete` after Step 7. If the user wants to stop, set it to `skipped`.

This is a five-minute tour. By the end the user has a card on their display, has watched a hot reload, and has clicked a button you reacted to.

---

## Step 1 — Welcome and ping

**Agent says:** "Surface is your universal display. I push content to it, you click things, I react. Let me check it's running."

**Agent runs:**

```bash
surface status
```

**Expect:** a JSON object with a `devices` list (each entry has `current_view`, `viewport_width`, etc. — empty until a browser has loaded the dashboard). If the command errors with `ECONNREFUSED`, the service isn't running — point the user at `scripts/install-systemd-user-service.sh` or `npm run dev` and retry.

Set `tutorial: in_progress` in `~/.surface/install-state.json`.

---

## Step 2 — Open the display

**Agent says:** "Open `http://127.0.0.1:3000` in your browser. You'll see an empty grid with a starfield."

**User does:** opens the URL. Confirms the page loads.

---

## Step 3 — Your first artifact

**Agent says:** "I'll push a hello card. It'll appear instantly via SSE — no refresh needed."

**Agent runs:**

```bash
surface create "Hello" --mime text/html --content - <<'EOF'
<!doctype html>
<html><body style="background:#0a0a0a;color:#fff;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
  <h1>Hello from Surface 👋</h1>
</body></html>
EOF
```

**Expect:** a new card on the grid within a second. Note the returned `artifact.id` — you'll reuse it.

---

## Step 4 — Link a file from the user's project

**Agent says:** "Now let's link a file you own. I'll create a small HTML in your current directory and point Surface at it. You'll be able to edit it with your normal tools and Surface will re-serve it live."

**Agent runs (in the user's chosen project dir):**

```bash
cat > demo.html <<'EOF'
<!doctype html>
<html><body style="background:#101820;color:#fee715;font-family:ui-monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
  <h1 id="t">Linked demo</h1>
</body></html>
EOF

surface link "$(pwd)/demo.html" --title "Demo"
```

**Expect:** a second card titled "Demo". Click it. The page renders from your file on disk, not a copy. Note this artifact's `id` for the next step.

---

## Step 5 — Hot reload

**Agent says:** "Watch this. I'll change the page's color, then tell Surface the file changed. No version bump, no diff — just the filesystem and a notification."

**Agent runs:**

```bash
# Edit demo.html in place — flip yellow text to neon green
sed -i 's/#fee715/#39ff14/' demo.html

surface touch <id-from-step-4>
```

**Expect:** the open Demo surface (or its grid card) updates to green within a second. If the user is on the grid, the card preview refreshes; if they're inside the surface, the iframe reloads.

---

## Step 6 — React to a click

**Agent says:** "Surfaces can talk back. I'll add a button, then *wait* for it in the background — when you click, my shell wakes me up automatically. No polling, no webhook server."

**Agent runs:**

```bash
cat > demo.html <<'EOF'
<!doctype html>
<html><body style="background:#101820;color:#39ff14;font-family:ui-monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:24px">
  <h1 data-surface-bind="message">Click me</h1>
  <button id="ping" style="padding:12px 24px;background:#39ff14;color:#101820;border:none;border-radius:8px;cursor:pointer;font-family:inherit;font-weight:bold">Ping the agent</button>
  <script>
    document.getElementById("ping").addEventListener("click", () => {
      Surface.action("pinged", { ts: Date.now() });
    });
  </script>
</body></html>
EOF

surface touch <id-from-step-4>
surface set <id-from-step-4> message "Click me"

# In a background shell — exits as soon as the user clicks.
surface wait --id <id-from-step-4> --action pinged --timeout 600 > /tmp/ping.json &
```

User clicks the button.

**Expect:** the background `surface wait` exits 0; the agent's harness sees the background task complete. The agent reads `/tmp/ping.json`:

```json
{
  "id": "...",
  "surface_id": "...",
  "action": "pinged",
  "data": { "ts": 1747358400000 }
}
```

**Agent runs (after waking):**

```bash
surface reply <id-from-step-4> "Got your ping at $(date +%H:%M:%S)"
surface set <id-from-step-4> message "Ping received"
```

**Expect:** a toast appears at the bottom of the surface, and the heading changes live from the state update without rewriting the HTML file.

Other delivery modes:

- `surface actions [<id>]` + `surface ack <action-id>` — pull when you decide to check.
- `surface stream` — tail every SSE event as JSONL, never exits on its own.

Use `surface wait` when you want the *user's click* to be the event that wakes you up.

---

## Step 7 — Customize the look

**Agent says:** "You own the display end-to-end. Try a different theme."

**Agent runs:**

```bash
surface theme '{"background":"linear-gradient(135deg,#0a0012,#1a0028)","colors":{"accent":"#ff0080"}}'
```

**Expect:** the grid background shifts to purple. Reset with `surface theme reset`.

---

## Wrap-up

You've covered:

- `surface create` / `surface link` / `surface present` — three ways to put content on the display
- `surface touch` — the entire "hot reload" story for linked artifacts (no diff tool needed)
- `surface actions` + `surface ack` + `surface reply` — two-way interaction
- `surface theme` — display customization

Where to go next:

- `surface --help` and `surface <cmd> --help` for the full command surface
- `SKILL.md` for when-to-use guidance
- `docs/architecture.md` for the data model and process shape
- `SECURITY.md` before exposing Surface beyond `127.0.0.1`

Set `tutorial: complete` and `installed_at: <ISO timestamp>` in `~/.surface/install-state.json`.
