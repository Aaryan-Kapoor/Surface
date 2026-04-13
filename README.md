# Surface

**The last app.** A universal display that AI agents own end-to-end.

Instead of installing a weather app, a reading app, a game app — you have one Surface. Agents decide what goes on it.

> "Surface me a game."
> "Put today's paper on my surface."
> "Make my surface look cyberpunk."

Each surface is a live HTML/CSS/JS mini-app an agent created. The PWA homescreen is your app drawer. Agents have full control — theming, navigation, overlays, live JS execution, custom renderers that replace the entire homescreen.

## Two kinds of surfaces

**Widgets (declarative).** An agent pushes a JSON spec that composes trusted components (`Stack`, `Card`, `Text`, `Button`, `Input`, `Checkbox`, `Image`, `ProgressBar`, `ProgressRing`, `List`, `Spacer`, `Box`). State lives client-side and mutates through a small set of declarative ops (`set`, `inc`, `dec`, `toggle`, `push`, `remove`, `post`). Bindings like `"$.count"` resolve against state at render time. Timers are declared in the spec, not scripted.

```bash
curl -X POST localhost:3000/surfaces -H 'Content-Type: application/json' -d '{
  "title": "Counter", "kind": "widgets",
  "spec": {
    "root": {"type":"Stack","direction":"vertical","align":"center","gap":20,"children":[
      {"type":"Text","value":"$.count","size":"3xl"},
      {"type":"Button","label":"+1","variant":"accent",
       "onClick":[{"op":"inc","path":"count"}]}
    ]},
    "state": {"count": 0}
  }
}'
```

Widgets are cheaper to author/update and state survives agent-pushed updates automatically — a mid-countdown Pomodoro keeps ticking while the agent pushes a new spec.

**HTML (raw).** For anything the widget catalog can't express — games, canvas, WebGL, exotic typography. Set `kind='html'` (or omit it) and pass `html`.

## Editing HTML surfaces without losing state

Use `surface_edit` (MCP) / `PATCH /surfaces/:id` (HTTP) instead of `surface_update` whenever you're making targeted changes:

```bash
curl -X PATCH localhost:3000/surfaces/my-timer -H 'Content-Type: application/json' -d '{
  "edits": [
    {"old_string": "FOCUS",  "new_string": "BREAK"},
    {"old_string": "#ff6b6b", "new_string": "#51cf66", "replace_all": true}
  ]
}'
```

Each edit's `old_string` must match exactly once (or set `replace_all=true`). The server validates, applies, bumps the revision, and broadcasts the edits to the connected client, which morphs the DOM in place. Running timers, scroll position, focus, uncontrolled input values, and canvas contexts are all preserved.

`surface_revisions` shows the history; `surface_restore` rolls back.

## Quick Start

```bash
npm install
npm run dev        # → http://localhost:3000
```

Create a surface:

```bash
curl -X POST localhost:3000/surfaces \
  -H "Content-Type: application/json" \
  -d '{"title": "Hello", "html": "<h1 style=\"color:white\">Hello from Surface</h1>"}'
```

Open `localhost:3000` — it appears instantly via SSE.

## Connect an Agent

### Claude Code / Cursor (MCP)

Add to your MCP config:

```json
{
  "mcpServers": {
    "surface": {
      "command": "npx",
      "args": ["tsx", "/path/to/surface/server/mcp.ts"],
      "env": { "SURFACE_URL": "http://localhost:3000" }
    }
  }
}
```

The agent gets 18 tools:

| Tool | What it does |
|------|-------------|
| `surface_create` | Push a new surface. `kind='widgets'` (declarative JSON) or `kind='html'` (raw HTML/CSS/JS). |
| `surface_read` | Read current surface content |
| `surface_update` | Replace a surface's content (html or spec). Prefer `surface_edit` for small changes. |
| `surface_edit` | Find/replace diff edits on `kind='html'` surfaces. Cheap in tokens, preserves running state via DOM morphing. |
| `surface_revisions` | List the revision history for a surface |
| `surface_restore` | Roll back to a past revision |
| `surface_delete` | Remove a surface |
| `surface_list` | List all surfaces |
| `surface_exec` | Run JS in a live surface without replacing HTML |
| `surface_actions` | Read pending user actions from surfaces |
| `surface_ack` | Acknowledge an action |
| `reply` | Send a toast notification to a surface |
| `display_set_theme` | Change colors, fonts, background, inject CSS, set a custom renderer/overlay/home widget |
| `display_reset_theme` | Reset everything to default |
| `display_navigate` | Force what's on screen |
| `display_status` | See what the user is viewing |
| `display_notify` | Push ephemeral notifications |
| `display_widget_catalog` | Return the full widgets component reference (components, props, ops, example spec) |

### Direct HTTP

All the same capabilities via REST:

```
POST   /surfaces                             Create surface (kind=html or widgets)
GET    /surfaces                             List surfaces
GET    /surfaces/:id                         Get surface
PUT    /surfaces/:id                         Replace surface (html or spec)
PATCH  /surfaces/:id                         Apply text-diff edits (kind=html only)
DELETE /surfaces/:id                         Delete surface
GET    /surfaces/:id/html                    Serve surface HTML (iframe src)
GET    /surfaces/:id/revisions               List revision history
GET    /surfaces/:id/revisions/:n            Fetch a past revision
POST   /surfaces/:id/revisions/:n/restore    Roll back to a revision
POST   /surfaces/:id/exec                    Execute JS in surface iframe
POST   /surfaces/:id/actions                 Post an action from a surface
POST   /surfaces/:id/reply                   Send toast to surface
GET    /stream                               Global SSE (created/updated/deleted events)
GET    /surfaces/:id/stream                  Per-surface SSE (updates, edits, exec, replies)
PUT    /display/config                       Set theme/renderer/overlay
POST   /display/reset                        Reset to default
POST   /display/navigate                     Force navigation
POST   /display/notify                       Push notification
GET    /display/status                       Get display state
```

## Marketplace

Browse and install pre-made surfaces, themes, renderers, and overlays from the built-in marketplace.

Click **Explore** on the homescreen, or use the API:

```bash
# List everything
curl localhost:3000/marketplace

# Filter by type
curl "localhost:3000/marketplace?type=theme"

# Install
curl -X POST localhost:3000/marketplace/mp-pomodoro/install
```

**10 surfaces** (Pomodoro, Clock, Calculator, Piano, Color Palette, Habit Tracker, Notes, Weather, Breathing Guide, Stopwatch), **3 themes** (Cyberpunk Neon, Minimal Light, Deep Forest), **1 renderer** (Retro Terminal), **1 overlay** (Floating Clock).

## Display Control

Agents don't just push content — they own the display.

**Theming** — colors, fonts, backgrounds, starfield/nebula effects, card radius, raw CSS injection:

```bash
curl -X PUT localhost:3000/display/config \
  -H "Content-Type: application/json" \
  -d '{"background":"linear-gradient(135deg,#0a0012,#1a0028)","colors":{"accent":"#ff0080"}}'
```

**Custom renderer** — replace the entire homescreen with your own HTML/CSS/JS. Your code gets `window.__surfaces`, `navigate(id)`, `onSurfaceChange()`, and more injected automatically.

**Overlays** — persistent HTML layer across all views (floating clocks, status bars).

**Home widgets** — HTML/JS iframe above the card grid.

**Live JS execution** — run code in a surface's iframe without replacing HTML:

```bash
curl -X POST localhost:3000/surfaces/my-game/exec \
  -H "Content-Type: application/json" \
  -d '{"js":"document.getElementById(\"score\").textContent = 42"}'
```

## Architecture

```
AI Agent (Claude, OpenClaw, etc.)
    │ MCP tools or HTTP
    ▼
Surface Server (Express + SQLite + SSE)
    │ SSE live updates
    ▼
Surface PWA (vanilla JS, hash routing, sandboxed iframes)
```

- **Server**: Express 5, SQLite via better-sqlite3, SSE for real-time updates
- **Client**: Vanilla JS PWA, installable via Add to Home Screen
- **MCP**: stdio transport, works with Claude Code, Cursor, OpenClaw, any MCP client
- **Surfaces**: Rendered in same-origin iframes (`/surfaces/:id/html`) so scripts work
- **Previews**: Live iframe thumbnails for simple surfaces, icon fallback for complex ones
- **PDFs**: Server-side proxy at `/proxy/pdf?url=` bypasses X-Frame-Options

## OpenClaw Integration

Surface actions (button clicks, form submissions) can automatically fan out to OpenClaw's gateway for real-time push-based agent responses.

Set in `.env`:

```
OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789
OPENCLAW_HOOKS_TOKEN=your-hooks-token
```

When a user interacts with a surface, the action is POSTed to `POST /hooks/agent` on the OpenClaw gateway. The OpenClaw agent wakes up immediately, processes the action, and can respond by calling the Surface HTTP API.

## Two-Way Communication

Surfaces can talk back to agents. Inside your surface HTML:

```javascript
// Send an action to the agent
parent.postMessage({
  type: 'surface_action',
  action: 'button_clicked',
  data: { button: 'submit', value: 42 }
}, '*');
```

The agent receives this via `surface_actions` tool or channel notifications, and can respond with `surface_update`, `surface_exec`, or `reply`.

## Stack

- Express 5 + SQLite (better-sqlite3)
- SSE for live updates
- Vanilla JS PWA
- MCP SDK (`@modelcontextprotocol/sdk`)
- `tsx` for dev, `bun` for MCP server
