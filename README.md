# Surface

**The last app.** A universal display that AI agents own end-to-end.

Instead of installing a weather app, a reading app, a game app — you have one Surface. Agents decide what goes on it.

> "Surface me a game."
> "Put today's paper on my surface."
> "Make my surface look cyberpunk."

Artifacts are the durable content agents create; surfaces are the live display views for those artifacts. The PWA homescreen is your app drawer. Agents have full control — theming, navigation, overlays, live JS execution, custom renderers that replace the entire homescreen.

## Quick Start

```bash
npm install
npm run dev        # → http://localhost:3000
```

Create a displayable HTML artifact:

```bash
curl -X POST localhost:3000/artifacts \
  -H "Content-Type: application/json" \
  -d '{"title": "Hello", "mime": "text/html", "content": "<h1 style=\"color:white\">Hello from Surface</h1>"}'
```

Open `localhost:3000` — it appears instantly via SSE.

## Connect an Agent

For a step-by-step agent bootstrap, read [`INSTALL_FOR_AGENTS.md`](INSTALL_FOR_AGENTS.md).

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

The agent-facing MCP API uses artifacts for durable content and surfaces for display/runtime state:

| Tool | What it does |
|------|-------------|
| `artifact_create` | Create durable content from HTML, text, or files |
| `artifact_read` | Read artifact metadata, version, and file manifest |
| `artifact_update` | Create a new immutable artifact version |
| `artifact_versions` | List artifact versions |
| `artifact_rollback` | Restore an earlier artifact version |
| `artifact_delete` | Remove an artifact and its surface view |
| `artifact_present_file` | Present an existing local file |
| `artifact_list` | List durable artifacts |
| `surface_list` | List displayable surface cards |
| `surface_exec` | Run JS in a live surface without replacing HTML |
| `surface_actions` | Read pending user actions from surfaces |
| `surface_ack` | Acknowledge an action |
| `reply` | Send a toast notification to a surface |
| `display_set_theme` | Change colors, fonts, background, inject CSS, set a custom renderer/overlay/home widget |
| `display_reset_theme` | Reset everything to default |
| `display_navigate` | Force what's on screen |
| `display_status` | See what the user is viewing |
| `display_notify` | Push ephemeral notifications |

### Direct HTTP

All the same capabilities via REST:

```
POST   /artifacts             Create durable artifact
GET    /artifacts             List artifacts
GET    /artifacts/:id         Read artifact
PUT    /artifacts/:id         Create new artifact version / update metadata
DELETE /artifacts/:id         Delete artifact and surface view
GET    /artifacts/:id/versions List versions
POST   /artifacts/:id/rollback Roll back current version
GET    /artifacts/:id/view    Render artifact
POST   /surfaces              Compatibility: create HTML artifact-backed surface
GET    /surfaces              List surfaces
GET    /surfaces/:id          Get surface
PUT    /surfaces/:id          Compatibility: update backing artifact
DELETE /surfaces/:id          Delete backing artifact or legacy surface
GET    /surfaces/:id/html     Serve surface HTML (iframe src)
POST   /surfaces/:id/exec     Execute JS in surface iframe
POST   /surfaces/:id/actions  Post an action from a surface
POST   /surfaces/:id/reply    Send toast to surface
GET    /stream                Global SSE (created/updated/deleted events)
GET    /surfaces/:id/stream   Per-surface SSE (updates + agent replies)
PUT    /display/config        Set theme/renderer/overlay
POST   /display/reset         Reset to default
POST   /display/navigate      Force navigation
POST   /display/notify        Push notification
GET    /display/status        Get display state
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

The agent receives this via the `surface_actions` tool or channel notifications, and can respond with `artifact_update`, `surface_exec`, or `reply`.

## Stack

- Express 5 + SQLite (better-sqlite3)
- SSE for live updates
- Vanilla JS PWA
- MCP SDK (`@modelcontextprotocol/sdk`)
- `tsx` for dev, `bun` for MCP server
