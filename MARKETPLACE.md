# Surface Marketplace: Comprehensive Brainstorm

> An app store for AI-generated interactive experiences.

---

## Table of Contents

1. [The Vision](#the-vision)
2. [Existing Marketplace Models: What to Steal](#existing-marketplace-models-what-to-steal)
3. [Architecture & Technical Design](#architecture--technical-design)
4. [Business Model & Monetization](#business-model--monetization)
5. [Discovery & Curation](#discovery--curation)
6. [Creator Experience](#creator-experience)
7. [User Experience](#user-experience)
8. [Community & Social](#community--social)
9. [Name Ideas](#name-ideas)
10. [MVP Scope & Phased Rollout](#mvp-scope--phased-rollout)
11. [Competitive Landscape](#competitive-landscape)
12. [What Makes This Go Viral](#what-makes-this-go-viral)

---

## The Vision

Surface is already "the last app" -- a single PWA where AI agents push live HTML/CSS/JS experiences to your screen. But right now every user starts from zero: they ask their agent to build every surface from scratch. This is like having a 3D printer but no Thingiverse.

The marketplace changes that equation. Instead of "describe what you want and wait," it becomes "browse, tap, installed." A pomodoro timer. A CRT TV homescreen. A Snake game. A budgeting dashboard. A breathing exercise. One tap. Done. Running on your Surface in under a second.

But unlike a traditional app store, every surface you install is:
- **Transparent** -- you can see the full HTML/CSS/JS source
- **Forkable** -- one tap to remix it into your own version
- **Agent-compatible** -- your AI agent can modify it after install
- **Live** -- surfaces that need agent interaction declare that, and your agent picks up the contract

This is not an app store. This is a **living library of interactive experiences** that AI agents and humans co-create, share, remix, and evolve.

---

## Existing Marketplace Models: What to Steal

### SkillHub (Claude Code Skills Marketplace)

**How it works:** Skills are markdown files (SKILL.md) in GitHub repos. SkillHub indexes them automatically. Installation is a single CLI command. Skills are rated by AI on 5 dimensions (Practicality, Clarity, Automation, Quality, Impact) with S/A/B/C rankings. Over 7,000 skills indexed.

**What to steal:**
- **GitHub-native packaging.** A surface is a file in a repo. Push it, it gets indexed. Zero friction.
- **AI-powered quality scoring.** Don't rely solely on human reviews. AI can evaluate code quality, accessibility, security, visual appeal.
- **Single-command install.** `surface install @creator/pomodoro` or one tap in the PWA.
- **Auto-indexing from GitHub.** Creators don't need to "submit" -- they push a `surface.json` manifest and it appears.

**What to avoid:**
- SkillHub's discovery is still basic. No categories, no trending, no visual previews. For surfaces (which are visual by nature), discovery MUST be visual-first.

### Raycast Extensions Store

**How it works:** Extensions are React/TypeScript packages in a monorepo (`raycast/extensions`). Publishing means opening a PR. Automated CI checks manifest, linting, assets. After merge, it auto-publishes to the store. Single latest version (no version history).

**What to steal:**
- **Monorepo PR workflow.** Dead simple. One repo, one PR, automated checks, merge = published. Community reviews PRs.
- **Developer-grade tooling.** CLI scaffolding (`npx create-surface`), local dev server, hot reload.
- **Strict quality bar through automation.** CI validates manifest, checks for security issues, validates HTML structure, screenshots required.

**What to avoid:**
- Single-version model is too limiting. Surfaces evolve; users need version pinning and rollback.
- Monorepo doesn't scale to thousands of community contributions. Better: registry that indexes from individual repos.

### Figma Community

**How it works:** Designers publish files, plugins, and widgets. Users can duplicate and customize them. Figma handles payment for premium resources. Discovery through search, categories, and curated collections.

**What to steal:**
- **"Duplicate" as the core interaction.** Every surface is forkable. Install it, then make it yours.
- **Visual-first browsing.** Figma Community shows rich previews. Surfaces should show live running previews in the browse UI.
- **Creator profiles.** See everything a creator has published. Follow them.
- **Curated collections.** "Retro Gaming Pack," "Productivity Starter Kit," "Dark Mode Themes."

**What to avoid:**
- Figma's monetization is invitation-only and clunky. Be open from day one.

### Chrome Web Store

**How it works:** Extensions uploaded as ZIP packages. Review process combines manual and automated checks. Discovery through search, categories, featured/recommended. Ratings and reviews from verified installs.

**What to steal:**
- **Category taxonomy.** Mature categorization: productivity, games, developer tools, themes. Adapt for surfaces.
- **Verified install reviews.** Only users who installed a surface can review it.
- **Safety/security automated scanning.** Crucial for surfaces that run arbitrary JS.

**What to avoid:**
- The review process is slow (days to weeks). Surfaces should publish instantly with post-publish automated scanning, not pre-publish gatekeeping.
- The Chrome Web Store feels corporate and lifeless. Surfaces need personality.

### Shopify Theme Store

**How it works:** Curated themes reviewed by Shopify. 15% revenue share (reduced from 30%). Themes go through a design review process. Clear pricing ($0-$350+). Preview before purchase.

**What to steal:**
- **Live preview before install.** Shopify lets you preview a theme on YOUR store. Surface marketplace should let you preview a theme/renderer on YOUR homescreen with YOUR actual surfaces.
- **Revenue share model.** 15% is fair and proven. $0 for first $1M (like Shopify's app store) incentivizes early creators.
- **Design quality bar.** For themes and renderers, visual quality matters. Curate the "official" collection.

**What to avoid:**
- Heavy-handed curation gate. Allow anyone to publish; curate a "featured" tier.

### OpenAI GPT Store / ChatGPT App Directory

**How it works:** Evolved from custom GPTs (prompt-only) to full SDK apps (December 2025). Categories, trending, staff picks. AI can suggest relevant apps during conversation. Revenue share averages ~$0.03/conversation.

**What to steal:**
- **In-context discovery.** When a user asks their agent "make me a timer," the agent should suggest marketplace surfaces before building from scratch. "There's a great Pomodoro timer on the marketplace -- install it?"
- **Conversational install.** The agent can install a surface for you: "I found a highly-rated Pomodoro timer. Want me to install it?"
- **Categories by use case**, not by technology.

**What to avoid:**
- GPT Store's monetization is dismal ($0.03/conversation). The payouts don't incentivize quality. Surfaces need a better model.
- The GPT Store is flooded with low-quality entries. Quality curation is critical.

### HuggingFace Spaces

**How it works:** Git-based repositories. Push code, it auto-builds and deploys. Supports Gradio, Streamlit, Docker, or static HTML. Free tier with 16GB RAM. Git-native workflow. Configuration via YAML frontmatter.

**What to steal:**
- **Git-based everything.** Spaces are git repos. Push to deploy. This maps perfectly to surfaces.
- **Static HTML support.** HF Spaces can be plain HTML/CSS/JS -- exactly what surfaces are.
- **"Duplicate this Space" button.** One-click fork. This is the remix model.
- **Hardware tiers** (if surfaces ever need server-side compute).

**What to avoid:**
- HF Spaces targets ML engineers, not consumers. Surface marketplace must feel consumer-friendly.

### Roblox Experience Marketplace

**How it works:** User-generated 3D experiences. Creators earned $1B+ globally (March 2024-2025). Monetization via virtual currency (Robux), experience subscriptions, immersive ads, UGC item sales. 111M daily active users.

**What to steal:**
- **Creator-first economics.** Roblox moves "as much money as we can from the top line to the creator community." Surface should adopt this philosophy.
- **Scale of ambition.** Roblox isn't a "template store" -- it's an experience platform. Surface marketplace should think this big.
- **Multiple monetization vectors.** Not just "buy the surface" -- tips, subscriptions, in-surface purchases.

**What to avoid:**
- Roblox's 70% platform take on UGC is exploitative. Be more generous.

### Replit Templates / Glitch Remix

**How it works:** "Remix" an app to get a full copy of the code AND environment. If the original works, the remix works. No installation, no configuration. Replit's Agent can continue modifying remixed apps.

**What to steal:**
- **Remix = install + fork in one action.** When you install a surface, you get a full copy that works AND that you can modify.
- **Agent continuity.** After remixing, the agent can keep working on it. Critical for surfaces -- install a Pomodoro timer, then tell your agent "add a longer break option."
- **Zero-config.** If it works for the creator, it works for you. No setup.

### CodePen

**How it works:** 1.6M users, 14.6M Pens. Social follow/like/collect. Fork any Pen. Embed anywhere. Collections group related Pens. Challenges drive engagement.

**What to steal:**
- **The social layer.** Follow, like, collect, comment. Surfaces are inherently shareable and visual.
- **Embed anywhere.** Surfaces should be embeddable on any website.
- **Challenges/prompts.** Weekly challenges: "Build the best clock surface." Drives creation and engagement.
- **Trending feed.** Show what's hot. Surfaces with the most installs/remixes this week.

### WeChat Mini Programs

**How it works:** 4.3M mini programs. 450M daily active users. NO centralized store by design -- discovery through QR codes, social sharing, search. "De-centralized" philosophy.

**What to steal:**
- **QR code sharing.** Scan a code, surface installs. Perfect for sharing with friends in person.
- **Social discovery over algorithmic discovery.** Surfaces spread through sharing, not just browsing.
- **Instant load.** Mini programs open instantly. Surfaces must install instantly too.

**What to avoid:**
- The "no centralized store" philosophy limits discovery for new users. Have a store, but also enable peer-to-peer sharing.

### iOS App Store / Google Play

**What to steal:**
- **Screenshots and app preview videos.** Required. Surface listings need visual proof.
- **Update notes.** "What's new" when a surface updates.
- **App privacy labels.** Surfaces should declare: "This surface runs entirely locally" vs "This surface communicates with external APIs."

**What to avoid:**
- Apple's review process (days/weeks). Apple is now cracking down on "vibe coded" apps, rejecting AI-generated submissions. Surface marketplace should embrace AI-generated content, not gatekeep it.
- 30% commission. Way too high for a community marketplace.

---

## Architecture & Technical Design

### Surface Package Format

A surface package is a single JSON file called `surface.json` that contains everything needed to install:

```json
{
  "manifest": {
    "id": "creator/pomodoro-timer",
    "version": "1.2.0",
    "title": "Pomodoro Timer",
    "description": "A beautiful animated Pomodoro timer with session tracking",
    "author": {
      "name": "Jane Smith",
      "github": "janesmith",
      "url": "https://janesmith.dev"
    },
    "icon": "tomato",
    "category": "productivity",
    "tags": ["timer", "focus", "pomodoro", "productivity"],
    "license": "MIT",
    "screenshots": [
      "https://raw.githubusercontent.com/janesmith/pomodoro-surface/main/screenshots/1.png"
    ],
    "preview_video": null,
    "requires_agent": false,
    "agent_contract": null,
    "external_apis": [],
    "size_bytes": 12400,
    "created_at": "2026-03-01T00:00:00Z",
    "updated_at": "2026-03-15T00:00:00Z"
  },
  "surface": {
    "title": "Pomodoro Timer",
    "html": "<!DOCTYPE html>...(complete HTML/CSS/JS)...",
    "metadata": {
      "icon": "tomato",
      "description": "Focus timer with 25/5 splits"
    }
  }
}
```

**Key design decisions:**

1. **Single-file packaging.** A surface is fundamentally one HTML blob. Keep it simple. No ZIP files, no multi-file packages. The HTML can inline CSS and JS, or reference CDN-hosted libraries.

2. **`surface.json` in a GitHub repo.** This is the canonical source. The registry indexes it. To publish, you push a `surface.json`. To update, you push a new version.

3. **Semantic versioning.** `version` field follows semver. The registry tracks version history. Users can pin versions or auto-update.

4. **`requires_agent` flag.** Critical distinction:
   - `false`: Standalone surface. Works without any agent interaction. Install and use.
   - `true`: Agent-interactive surface. Declares an `agent_contract` that describes what actions the surface sends and what it expects the agent to do.

5. **`external_apis` declaration.** Transparency about what external services a surface calls. Empty array means fully offline/local.

### Theme/Renderer Package Format

Themes and renderers use the same structure but with a `type` field:

```json
{
  "manifest": {
    "id": "creator/crt-tv-theme",
    "version": "1.0.0",
    "type": "theme",
    "title": "CRT Television",
    "description": "Your homescreen becomes a vintage CRT TV with channels",
    "category": "themes",
    "tags": ["retro", "crt", "tv", "nostalgic"]
  },
  "theme": {
    "renderer": "<!DOCTYPE html>...(full CRT TV renderer HTML)...",
    "css": ".surface-card { border: 2px solid #00ff41; }...",
    "overlay": "<!DOCTYPE html>...(scanline overlay HTML)...",
    "colors": {
      "void": "#0a0a0a",
      "accent": "#00ff41",
      "glass": "rgba(0,255,65,0.05)"
    },
    "font": "'VT323', monospace",
    "starfield": false,
    "nebula": false
  }
}
```

**Package types:**
- `surface` -- a standalone interactive experience
- `theme` -- colors, CSS, font, background
- `renderer` -- a complete homescreen replacement (HTML/JS)
- `overlay` -- a persistent layer (HTML/JS)
- `bundle` -- a collection (theme + renderer + overlay + surfaces)

### Installation Flow

```
User taps "Install" in marketplace
         |
         v
  POST /surfaces  (for surfaces)
  PUT /display/config  (for themes/renderers/overlays)
         |
         v
  Surface appears on homescreen instantly via SSE
  Theme applies immediately
         |
         v
  Registry records install (for analytics/popularity)
```

**One-click install is non-negotiable.** The entire install is a single API call. The marketplace UI makes that call. Done.

For agent-mediated install:
```
User: "I want a pomodoro timer"
Agent: "I found 'Pomodoro Timer' by Jane Smith (4.8 stars, 2k installs).
        Want me to install it, or should I build you a custom one?"
User: "Install it"
Agent: calls surface_create with the marketplace HTML
Agent: "Installed! Opening it now."
Agent: calls display_navigate
```

### Versioning Strategy

- **Registry tracks all versions.** Every push to the `surface.json` in the repo creates a new version.
- **Users default to latest.** Surfaces auto-update unless the user pins a version.
- **Breaking changes via major version.** If a surface's agent contract changes, it bumps a major version. Users on the old version keep working.
- **Rollback with one click.** "This update broke something" -> tap to roll back to previous version.
- **Update notification.** Toast: "Pomodoro Timer was updated to v1.3.0 -- 'Added long break option'"

### Agent Contract Specification

For surfaces that need agent interaction, the manifest declares a contract:

```json
{
  "agent_contract": {
    "description": "This surface sends mood check responses and expects the agent to update the surface with appropriate content.",
    "actions_sent": [
      {
        "name": "mood_selected",
        "description": "User selected a mood",
        "data_schema": { "mood": "string (happy|sad|stressed|anxious)" }
      }
    ],
    "expected_responses": [
      {
        "description": "Agent should update the surface with content matching the selected mood",
        "method": "surface_update or surface_exec"
      }
    ]
  }
}
```

This lets agents understand what they need to do when they detect actions from this surface. It's a loose contract -- not strict RPC -- because agents reason about intent.

### Security Considerations

1. **Content Security Policy.** Surfaces run in iframes (currently same-origin). The marketplace should add a Content-Security-Policy header to surface iframes that restricts:
   - No `eval()` outside the surface's own scope
   - No access to parent frame's DOM
   - Optional: restrict external fetch calls to declared APIs

2. **Automated security scanning.** On publish:
   - Static analysis for known XSS patterns
   - Check for crypto miners, keyloggers, data exfiltration
   - Scan external URLs against blocklists
   - Flag surfaces that request geolocation, camera, etc.

3. **Size limits.**
   - Surfaces: 500KB max HTML blob (covers even complex games with inlined assets)
   - Themes/renderers: 200KB max
   - Overlays: 100KB max
   - External assets (images, fonts) can be CDN-hosted; total load budget of 2MB

4. **Sandboxing tiers.**
   - `sandbox: "strict"` -- no external network requests, no dangerous APIs
   - `sandbox: "standard"` -- external CDN allowed, fetch allowed to declared APIs
   - `sandbox: "open"` -- current behavior, full access (for power users)

5. **Reputation system.** New creators start unverified. After 10+ surfaces, 100+ total installs, and passing automated review, they become "verified." Verified surfaces get less friction.

### Registry Backend: Recommendation

**Phase 1 (MVP): GitHub-based registry.**
- A single GitHub repo: `surface-marketplace/registry`
- Each surface is a directory: `surfaces/creator/surface-name/surface.json`
- Publishing = opening a PR (can be automated via CLI)
- GitHub Actions runs validation, security scan, screenshot generation
- A static JSON index file is generated on merge: `index.json`
- The Surface PWA fetches `index.json` to populate the marketplace tab
- Cost: $0. Scales to thousands of surfaces. Community can review PRs.

**Phase 2: Custom API.**
- Express API: `GET /marketplace/surfaces`, `GET /marketplace/surfaces/:id`, `POST /marketplace/surfaces/:id/install`
- Backed by SQLite (same as Surface server) or Postgres
- Indexes from GitHub repos automatically (webhook on push)
- Handles install tracking, ratings, analytics
- CDN-fronted for fast global access

**Phase 3 (if needed): Decentralized.**
- Surface packages on IPFS for permanence
- Registry as a lightweight pointer index
- Enable self-hosted registries (like npm registries)

---

## Business Model & Monetization

### The Opinionated Recommendation: Open Core + Creator Tips

The marketplace should be **free and open** at its core, with optional monetization layers. Here is why:

1. Surface is early. Charging creates friction. Growth > revenue right now.
2. Surfaces are HTML blobs. They're inherently copyable. DRM is futile and hostile.
3. The network effect of a thriving free marketplace is worth more than per-surface revenue.

### Revenue Model Tiers

**Tier 1: Completely Free (Launch)**
- All surfaces are free to publish and install
- No fees, no commissions, no premium tier
- Fund through the core Surface product (if it ever charges)
- Goal: maximize adoption and content creation

**Tier 2: Creator Tips (Month 2-3)**
- Optional "Tip this creator" button on surface listings
- Surface takes 0% of tips (yes, zero). Use a direct payment link (Stripe, Buy Me a Coffee, GitHub Sponsors)
- Creators include their tip link in the manifest: `"tip_url": "https://buymeacoffee.com/janesmith"`
- This costs Surface nothing and gives creators upside

**Tier 3: Premium Surfaces (Month 6+)**
- Creators can set a price ($1-$50) for premium surfaces
- Surface takes 10% commission (lower than any competitor: Apple 30%, Shopify 15%, Chrome 5%)
- Payment via Stripe Connect
- Free surfaces remain the majority; premium surfaces are for high-quality, complex experiences
- First $10,000 in creator earnings: 0% commission (incentivizes early creators)

**Tier 4: Subscriptions (Year 1+)**
- "Surface Pro" for creators: analytics dashboard, priority listing, custom branding, private surfaces
- $5-10/month
- "Surface Pro" for users: automatic backups, sync across devices, private marketplace for teams

### Why Not Ads?

Ads in surfaces would be hostile and ugly. Surfaces are meant to be beautiful, immersive experiences. Injecting ads would destroy the product's soul. Never do this.

### Comparison of Revenue Shares

| Platform | Revenue Share (Platform Take) |
|---|---|
| Apple App Store | 30% (15% for small devs) |
| Google Play | 30% (15% for first $1M) |
| Shopify Themes | 15% |
| Shopify Apps | 0% first $1M, then 15% |
| Chrome Web Store | 5% |
| Roblox UGC | 70% (!) |
| OpenAI GPT Store | ~$0.03/conversation (negligible) |
| **Surface (recommended)** | **0% first $10K, then 10%** |

---

## Discovery & Curation

### Category Taxonomy

**Primary Categories:**
- **Productivity** -- timers, to-do lists, calendars, trackers, calculators
- **Games** -- arcade, puzzle, casual, multiplayer, interactive fiction
- **Dashboards** -- weather, finance, health, analytics, monitoring
- **Tools** -- code editors, converters, generators, calculators
- **Education** -- flashcards, visualizers, interactive lessons, quizzes
- **Creative** -- drawing tools, music visualizers, mood boards, generators
- **Health & Wellness** -- breathing exercises, workout timers, trackers
- **Social** -- polls, countdowns, shared canvases, collaborative tools
- **Entertainment** -- visualizers, ambient displays, art installations

**Meta Categories (for display customization):**
- **Themes** -- color schemes, fonts, backgrounds
- **Renderers** -- complete homescreen replacements (CRT TV, solar system, OS desktop)
- **Overlays** -- persistent layers (clocks, rain effects, status bars, scanlines)
- **Bundles** -- curated combinations (theme + renderer + overlay + surfaces)

### Discovery Mechanisms

**1. Visual browsing with live previews.**
Every surface listing shows a live thumbnail -- not a screenshot, but an actual iframe rendering of the surface at thumbnail scale. This is Surface's killer differentiator in discovery. You can SEE the pomodoro timer ticking. You can SEE the game running. You can SEE the rain effect falling.

**2. Featured & trending.**
- "Staff Picks" -- manually curated weekly
- "Trending" -- most installs in the last 7 days
- "New & Notable" -- recently published, quality-filtered
- "Most Remixed" -- surfaces that spawned the most forks
- "Rising Creators" -- creators with fast-growing install counts

**3. AI-powered recommendations.**
- "Based on your surfaces..." -- collaborative filtering
- "Pairs well with..." -- surfaces that are commonly installed together
- "Your agent suggested..." -- when a user asks for something, the agent can check the marketplace first

**4. Search and tagging.**
- Full-text search across titles, descriptions, tags
- Tag-based filtering: `#retro`, `#minimal`, `#animated`, `#offline`
- Author-based search

**5. Collections and bundles.**
- Creator-curated: "My Productivity Setup" (3 surfaces + a theme)
- Community-curated: "Best of Retro Gaming" (10 retro game surfaces + CRT theme)
- Official: "Surface Starter Pack" (5 essential surfaces for new users)

**6. "My Setup" discovery.**
Users can share their complete Surface configuration -- which surfaces, theme, renderer, overlay, and card order they use. Others can browse setups and install the entire thing with one tap.

**7. QR code sharing.**
Every surface listing has a QR code. Scan it and it installs. Perfect for in-person sharing: "Hey, check out this game on my Surface" -> scan -> installed.

### Quality Signals

- **AI quality score** (0-10) on five dimensions, following SkillHub's model:
  - Visual quality (design, polish, responsiveness)
  - Code quality (clean HTML, no antipatterns, performant)
  - Interactivity (how engaging is it?)
  - Accessibility (ARIA labels, keyboard navigation, color contrast)
  - Security (no suspicious patterns)
- **Install count** (total and trending)
- **Remix count** (how many forks exist)
- **User ratings** (1-5 stars, only from verified installs)
- **Written reviews** (optional text with ratings)
- **Creator verification badge**

---

## Creator Experience

### Publishing Workflow

**Option A: GitHub-native (Recommended for v1)**

```bash
# 1. Create your surface locally
npx create-surface my-pomodoro-timer
cd my-pomodoro-timer

# 2. Develop with live preview
npx surface dev
# Opens your Surface PWA with hot-reloading

# 3. Write your surface.json manifest
# (auto-generated by create-surface, edit as needed)

# 4. Publish
npx surface publish
# - Validates manifest
# - Runs security checks
# - Takes automated screenshots
# - Opens a PR to the registry (or pushes to your own repo)
# - On merge/push: indexed and available in the marketplace
```

**Option B: Web-based publisher (v2)**

A web form at `marketplace.surface.app/publish`:
- Paste your HTML or upload a file
- Fill in metadata (title, description, category, tags)
- Live preview of how it will look
- Auto-generates screenshots
- One-click publish

**Option C: In-PWA publishing (v3)**

From within the Surface PWA itself:
- Long-press any surface you've created
- "Publish to Marketplace"
- Fills in metadata from the surface's existing title/metadata
- Adds a description and tags
- Published directly

**Option D: Agent-assisted publishing**

```
User: "Publish my Pomodoro Timer to the marketplace"
Agent: checks the surface, auto-generates description and tags
Agent: "Here's the listing I prepared:
        Title: Pomodoro Timer
        Description: Animated focus timer with 25/5 splits and session tracking
        Category: Productivity
        Tags: timer, focus, pomodoro
        Ready to publish?"
User: "Looks good, publish it"
Agent: calls marketplace API
```

### Creator SDK & Tooling

**`create-surface` CLI:**
```bash
npx create-surface my-surface
# Scaffolds:
#   my-surface/
#     surface.json      # manifest
#     index.html        # your surface HTML
#     screenshot.png    # auto-generated on build
#     README.md         # usage instructions
```

**`surface dev` local server:**
- Starts the full Surface server locally
- Injects your surface
- Hot-reloads on save
- Shows both grid view and fullscreen view
- Validates HTML structure and size limits

**`surface test` automated checks:**
- Renders the surface in a headless browser
- Takes screenshots at multiple viewport sizes (mobile, tablet, desktop)
- Runs Lighthouse-style checks (performance, accessibility)
- Validates the agent contract if `requires_agent: true`
- Reports size and external dependency analysis

**`surface publish` deployment:**
- Validates everything
- Generates screenshots if missing
- Calculates size
- Pushes to registry

### Creator Analytics Dashboard

Available at `marketplace.surface.app/dashboard`:
- Total installs over time
- Active installs (surfaces currently in use)
- Remix count (how many forks)
- Ratings and reviews
- Geographic distribution
- Referral sources (direct, search, agent suggestion, QR code)
- Version adoption (what % of users are on latest)

### Starter Templates

Pre-built templates to jumpstart creation:

| Template | What You Get |
|---|---|
| `blank` | Empty HTML with Surface best practices |
| `game-canvas` | Canvas-based game with touch controls, score tracking |
| `dashboard` | Grid layout with data cards, charts placeholder |
| `timer` | Countdown/stopwatch with controls and notifications |
| `interactive-fiction` | Branching narrative engine with two-way actions |
| `data-viz` | D3.js-ready visualization template |
| `tool` | Input/output tool (converter, calculator) |
| `theme` | Color scheme + CSS + overlay starter |
| `renderer` | Full homescreen replacement with `__surfaces` API wired up |

---

## User Experience

### Where Does the Marketplace Live?

**Recommendation: Inside the Surface PWA itself.**

The marketplace is a new tab/view in the PWA, not a separate website. Reasons:
- Zero friction between browsing and installing
- Live previews render in the same engine the surfaces will run in
- One-tap install that immediately appears on your homescreen
- The marketplace IS a surface experience

**Implementation:**
- New "Explore" icon on the grid view (bottom nav or header)
- Tapping it loads the marketplace view
- Marketplace data fetched from the registry API (or static JSON)
- Each listing shows live thumbnail preview
- "Install" button triggers `POST /surfaces` directly
- Surface appears on the grid instantly via SSE

### The Install Flow (UX detail)

```
1. User taps "Explore" in the Surface PWA
2. Marketplace grid appears with live-preview thumbnails
3. User taps a surface card
4. Detail view shows:
   - Large live preview (actual running surface in an iframe)
   - Title, author, description
   - Install count, rating, AI quality score
   - Screenshots at different sizes
   - "Requires agent: Yes/No" badge
   - Tags and category
   - Version history
   - Reviews
   - "View Source" button
   - "Install" button (prominent, single-tap)
   - "Remix" button (fork and customize)
5. User taps "Install"
6. Surface immediately appears on their homescreen grid
7. Toast notification: "Pomodoro Timer installed!"
8. Optional: auto-navigate to the surface
```

### Preview Before Install

For **themes and renderers**, the preview is even more powerful:
- "Preview this theme" temporarily applies it to YOUR homescreen with YOUR actual surfaces
- You see exactly what it will look like before committing
- "Apply" to keep it, "Cancel" to revert
- This is Shopify's "preview on your store" concept applied to Surface

### Automatic Updates

- Surfaces auto-update by default (new version published -> your copy updates)
- Update happens via SSE push -- seamless, no page reload needed
- Opt-out: "Pin to version 1.2.0" in surface settings
- Update notification toast: "Pomodoro Timer updated to v1.3.0"
- Changelog visible in surface details

### Customization After Install (Remix)

Every installed surface can be remixed:
1. Long-press the surface card on the homescreen
2. "Remix" option
3. A copy is created with "(Remix)" appended to the title
4. The copy is fully editable -- your agent can modify it
5. Optionally publish the remix back to the marketplace (with attribution)

This creates a **remix tree** -- you can trace a surface's lineage back through its forks. Like GitHub's fork graph but for interactive experiences.

### Separate Web Portal (Complementary)

In addition to the in-PWA marketplace, a web portal at `marketplace.surface.app`:
- SEO-friendly listings (Google indexes surfaces)
- Embed links for sharing: `marketplace.surface.app/s/creator/pomodoro-timer`
- "Open in Surface" deep link that installs into the user's PWA
- Creator profiles and dashboards
- API documentation

---

## Community & Social

### Remix/Fork Culture

The core social mechanic is **remixing**. Every surface is open source by default. Forks are celebrated, not hidden.

- **Remix tree visualization.** See the family tree of a surface -- the original and all its forks. Which fork added what feature?
- **"Remixed from"** attribution badge on forked surfaces
- **Remix count** as a quality signal. High remix count = high utility.
- **Remix challenges.** "Take this blank timer template and make it uniquely yours. Best remix wins."

### Sharing Mechanics

- **Share a single surface.** Generate a shareable URL or QR code. One-tap install for the recipient.
- **Share "My Setup".** Export your complete Surface configuration (surfaces, theme, renderer, overlay, card order) as a shareable link. Others can install the whole thing.
- **Share to social media.** Auto-generated OG image showing the surface's live preview. "Check out this surface I installed" -> visual card on Twitter/X, Discord, etc.

### Creator Profiles

At `marketplace.surface.app/@creator`:
- Avatar, bio, links
- All published surfaces, themes, renderers
- Total installs across all works
- "Follow" button (get notified of new publications)
- Contribution graph (GitHub-style green squares for publishing activity)

### Community Interactions

- **Star/Like surfaces.** Simple, low-friction appreciation.
- **Written reviews.** Text reviews from verified installs.
- **Comments on listings.** Bug reports, feature requests, praise.
- **"Surface of the Week"** community vote.
- **Creator spotlights.** Blog posts or newsletter features.

### GitHub-Style Contributions

Since surfaces are in GitHub repos:
- Anyone can open a PR to improve a surface (fix a bug, add a feature)
- Creator merges the PR, new version auto-publishes
- Contributors are credited in the surface's listing
- This turns the marketplace into a collaborative open-source community, not just a download catalog

---

## Name Ideas

The marketplace name should feel native to the "Surface" brand. It should evoke exploration, discovery, creation, or the physical metaphor of surfaces/spaces.

### Top Tier (Strong Recommendations)

| Name | Rationale |
|---|---|
| **Surface Exchange** | Clear, implies trading/sharing. "The Exchange." |
| **The Grid** | Surfaces live on a grid. "Browse The Grid." Tron vibes. |
| **Surface Gallery** | Art gallery metaphor. Surfaces are exhibits. |
| **Arcade** | Playful, implies interactive experiences. "The Surface Arcade." |
| **Depot** | Like a warehouse of surfaces. "Surface Depot." Industrial, practical. |
| **Shelf** | Surfaces sit on a shelf. "The Shelf." Clean, simple. |

### Second Tier (Good Options)

| Name | Rationale |
|---|---|
| **SurfaceHub** | Straightforward hub metaphor. |
| **The Workshop** | Implies creation and craft. |
| **The Bazaar** | Open marketplace energy. Eclectic, vibrant. |
| **Surface Commons** | Community-owned, public good feel. |
| **Facets** | Surfaces have many facets. Exploration metaphor. |
| **Layer Market** | Surfaces are layers. "Browse the layers." |
| **Canvas Store** | Canvas = creative freedom. |
| **The Forge** | Where surfaces are crafted. |

### Third Tier (Creative/Experimental)

| Name | Rationale |
|---|---|
| **Panes** | Like window panes. Glass/transparent metaphor. |
| **Topside** | "The top side" of the surface. Fresh, spatial. |
| **Surface Port** | Port = import/export. Arrival point for surfaces. |
| **The Lot** | Like a parking lot of experiences. Casual. |
| **Plane** | A geometric plane. Abstract, clean. |
| **Strata** | Geological layers. Depth metaphor. |
| **Glaze** | A surface finish. Premium feel. |
| **Veneer** | A thin surface layer. Elegant. |
| **Patina** | A surface that develops character over time. |
| **Tessera** | Mosaic tile. Each surface is a piece of the whole. |

### The Pick

**"The Grid"** is the strongest name. It's:
- Short, punchy, memorable
- Directly tied to Surface's homescreen (which IS a grid)
- Carries Tron/cyberpunk energy that matches the starfield/nebula aesthetic
- Works as both noun and destination: "Check The Grid," "New on The Grid," "Published to The Grid"
- Verb-friendly: "Grid it" (publish), "Off the Grid" (removed)

Runner-up: **"Surface Exchange"** for a more professional/mature marketplace feel.

---

## MVP Scope & Phased Rollout

### Hackathon Demo (1-2 days)

**Goal:** Show the concept is real. 10-20 pre-loaded surfaces, browsable and installable.

**What to build:**
1. A static `registry.json` file with 10-20 hand-curated surfaces:
   - Pomodoro Timer
   - Snake Game
   - Breathing Exercise
   - Weather Dashboard (static/mock data)
   - Habit Tracker
   - CRT TV Theme (renderer)
   - Matrix Rain Overlay
   - Retro Arcade Theme (bundle)
   - Bill Split Calculator
   - ASCII Art Display
2. A new "Explore" view in the PWA (simple grid of marketplace items)
3. Each item shows title, icon, description, category, and a live iframe preview
4. "Install" button that calls `POST /surfaces` with the HTML from the registry
5. For themes: "Apply" button that calls `PUT /display/config`
6. Surface appears on homescreen immediately

**What to skip:** Search, ratings, creator accounts, versioning, GitHub integration, analytics.

**Demo script:**
1. Open Surface -- empty homescreen
2. Tap "Explore" -- marketplace grid with live previews
3. Browse categories
4. Install "Pomodoro Timer" -- appears on grid instantly
5. Install "CRT TV Theme" -- entire homescreen transforms
6. Install "Snake Game" -- appears as a new channel on the CRT TV
7. "All of these were built by the community. Any of them can be remixed."

### v1 (2-4 weeks)

**Goal:** A functional marketplace with community publishing.

**What to build:**
1. **GitHub-based registry.** `surface-marketplace/registry` repo with PR-based publishing.
2. **`surface.json` manifest standard.** Documented, validated by CI.
3. **CLI tooling.** `npx create-surface`, `npx surface dev`, `npx surface publish`.
4. **In-PWA marketplace tab.** Browse, search, filter by category, install, preview.
5. **Theme/renderer marketplace.** Same flow, different install target.
6. **Install tracking.** Count installs per surface (anonymous).
7. **AI quality scoring.** Run automated quality checks on publish.
8. **Basic search.** Full-text search across titles and descriptions.
9. **Version tracking.** Show version number, auto-update on new publish.
10. **Shareable links.** `marketplace.surface.app/s/creator/surface-name` with OG images.

**What to skip:** Ratings/reviews, creator analytics, monetization, remix tracking, collections.

### v2 (Month 2-3)

**Goal:** Social layer and creator tools.

1. Ratings and reviews (verified installs only)
2. Creator profiles
3. Remix/fork functionality with attribution
4. Collections and bundles
5. "My Setup" sharing
6. Creator analytics dashboard
7. Trending/featured/new sections
8. QR code sharing
9. Creator tip links
10. Agent-mediated discovery ("I found a surface for that...")

### v3 (Month 4-6)

**Goal:** Monetization and scale.

1. Premium surfaces with Stripe payments
2. Revenue sharing (0% first $10K, then 10%)
3. Creator verification program
4. Custom API registry (move off pure GitHub)
5. CDN for fast global access
6. Embed surfaces on external websites
7. Weekly challenges and community events
8. "Surface Pro" subscription for advanced creator/user features

---

## Competitive Landscape

### Direct Competitors

**Nobody is doing exactly this.** The intersection of "marketplace for AI-generated interactive HTML experiences that run on a shared canvas" does not exist yet. That's the opportunity.

### Adjacent Competitors

| Competitor | What They Do | Why Surface Wins |
|---|---|---|
| **OpenAI GPT Store** | Marketplace for AI chatbot configurations | GPTs output text. Surfaces output interactive software. |
| **Replit Templates** | Remixable full-stack app templates | Replit is an IDE. Surface is a consumer PWA. Lower friction. |
| **CodePen** | Social coding playground | CodePen is for developers. Surface marketplace is for everyone. |
| **Glitch** | Remixable web apps | Glitch is an IDE/hosting platform. Surface is a display with agent integration. |
| **HuggingFace Spaces** | ML demo hosting | HF is for ML engineers. Surface is for anyone with an AI agent. |
| **Chrome Web Store** | Browser extensions | Extensions modify the browser. Surfaces ARE the app. |
| **Figma Community** | Design file sharing | Figma is for designers. Surface is for users. |
| **iOS/Android App Stores** | Native app distribution | 30% commission, multi-day review, requires developer accounts. Surface: 10%, instant, free to publish. |
| **Vibe-coded app stores** | AI-generated native apps flooding app stores | Apple is cracking down. Surface embraces AI-generated content. |

### The Moat

1. **Surface is the runtime.** You can't run a surface without Surface. The marketplace and the platform are one.
2. **Agent integration.** No other marketplace has surfaces that can talk to your AI agent bidirectionally. This creates experiences no static app can match.
3. **Remix culture.** Every surface is open source, forkable, agent-modifiable. This creates a compounding content flywheel.
4. **Live previews in the marketplace.** Not screenshots -- actual running code. This is impossible in any app store.
5. **Instant install.** One API call. No download, no compile, no review process. Sub-second from browse to running.
6. **Zero barrier to creation.** Any AI agent can create a surface. The supply side is infinite.

### The Flywheel

```
More surfaces in marketplace
         |
         v
   More users install Surface
         |
         v
   More users = more installs = better discovery data
         |
         v
   Better discovery = more motivation for creators
         |
         v
   More creators publish surfaces
         |
         v
   (repeat)
```

The agent angle accelerates this: agents can BOTH create surfaces (supply) AND discover/install them (demand). The marketplace becomes a shared knowledge base that all agents tap into.

---

## What Makes This Go Viral

### 1. Live Preview Browsing

A marketplace where every listing is a running, interactive application -- not a screenshot -- is visually stunning and immediately shareable. Record a screen capture of browsing the marketplace and it looks like magic: dozens of tiny live apps running simultaneously.

### 2. One-Tap Complete Transformation

Install a "CRT TV" bundle and your entire phone transforms in one second. Before: normal grid. After: vintage television with channels. This is a TikTok-ready moment.

### 3. "My Setup" Sharing

"Here's my Surface setup" posts -- showing a gorgeous custom theme, curated surfaces, and a wild renderer -- become a flexing/sharing meme. Like sharing your desktop rice on r/unixporn, but for AI-powered interactive experiences.

### 4. Remix Chains

When surface B is a remix of surface A, and surface C is a remix of B, and they're all meaningfully different -- that's a story. "Look how this breathing exercise evolved through 47 remixes into a full meditation studio."

### 5. Agent as Curator

"My AI agent recommended this surface to me based on my usage patterns" is a delightful, novel experience. The agent becomes a personal shopper for interactive experiences.

### 6. Speed of Creation

"I described an idea to my agent, it published a surface to the marketplace, and 100 people installed it within an hour." The speed from idea to published, installed, used software is unprecedented.

### 7. Weekly Challenges

"This week's challenge: build the best clock surface." Community votes. Winner gets featured. Creates recurring engagement and a steady supply of creative content.

### 8. The "Last App Store"

The meta-narrative is powerful: "The last app store -- because every app in it was built by AI." It's not just a marketplace. It's a proof that AI agents can replace the entire software development and distribution pipeline.

---

## Technical Appendix: New API Endpoints

These endpoints would be added to the Surface server to support the marketplace:

```typescript
// ── Marketplace Registry (if self-hosted, not GitHub-based) ──

// Browse marketplace
GET /marketplace/surfaces?category=&search=&sort=trending&page=1
GET /marketplace/themes
GET /marketplace/renderers
GET /marketplace/overlays
GET /marketplace/bundles

// Get marketplace item detail
GET /marketplace/items/:id
GET /marketplace/items/:id/versions
GET /marketplace/items/:id/reviews

// Install from marketplace
POST /marketplace/items/:id/install
// -> Internally calls POST /surfaces or PUT /display/config

// Track installs (anonymous)
POST /marketplace/items/:id/track

// Ratings and reviews
POST /marketplace/items/:id/rate   { stars: 4, review: "Great timer!" }

// Creator endpoints
POST /marketplace/publish          { surface_json: "..." }
GET  /marketplace/creators/:name
GET  /marketplace/creators/:name/items

// My Setup
POST /marketplace/setups           { surfaces: [...], theme: {...}, name: "My Retro Setup" }
GET  /marketplace/setups/:id
POST /marketplace/setups/:id/install
```

### Registry Index Format (for GitHub-based MVP)

```json
{
  "version": 1,
  "generated_at": "2026-03-27T00:00:00Z",
  "items": [
    {
      "id": "janesmith/pomodoro-timer",
      "type": "surface",
      "title": "Pomodoro Timer",
      "description": "Animated focus timer with session tracking",
      "author": "janesmith",
      "version": "1.2.0",
      "category": "productivity",
      "tags": ["timer", "focus", "pomodoro"],
      "icon": "tomato",
      "installs": 2847,
      "rating": 4.8,
      "ai_score": 9.2,
      "requires_agent": false,
      "size_bytes": 12400,
      "screenshot_url": "https://raw.githubusercontent.com/.../screenshot.png",
      "source_url": "https://github.com/janesmith/pomodoro-surface",
      "html_url": "https://raw.githubusercontent.com/.../surface.json",
      "created_at": "2026-03-01",
      "updated_at": "2026-03-15"
    }
  ],
  "categories": [
    { "id": "productivity", "label": "Productivity", "icon": "clipboard", "count": 127 },
    { "id": "games", "label": "Games", "icon": "joystick", "count": 89 }
  ],
  "featured": ["janesmith/pomodoro-timer", "retromaker/crt-tv-theme"],
  "trending": ["gamer42/snake-deluxe", "zenmaster/breathing-circle"]
}
```

---

## Summary of Key Decisions

| Decision | Recommendation | Rationale |
|---|---|---|
| Package format | Single `surface.json` file | Surfaces are HTML blobs. Keep it simple. |
| Registry backend | GitHub repo (MVP) -> Custom API (v2) | Zero cost, community-native, proven by Raycast. |
| Install mechanism | Single API call from PWA | Must be instant. One tap. Sub-second. |
| Monetization | Free (launch) -> Tips -> 10% commission on paid | Growth first. Lower take than all competitors. |
| Discovery | In-PWA with live previews | Killer differentiator. No other marketplace does this. |
| Publishing | CLI + GitHub PR (v1) -> Web form + in-PWA (v2) | Meet creators where they are. |
| Quality control | AI scoring + automated security scan | No human review bottleneck. Post-publish, not pre-publish. |
| Naming | "The Grid" | Short, branded, memorable, visually evocative. |
| MVP scope | 10-20 curated surfaces, Explore tab in PWA, one-tap install | Buildable in 1-2 days. Demoable. Impressive. |
| Core philosophy | Every surface is open, forkable, agent-modifiable | This is what makes Surface different from every other marketplace. |

---

*This document is a living brainstorm. The best marketplace is the one that ships.*
