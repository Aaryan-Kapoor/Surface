# Surface — Pitch Script

**Track:** Nexlayer "All-In" (Startup)
**Format:** 4 min pitch + 3 min Q&A
**Judging room:** CLSO 150

---

## BEFORE YOU START

- Open Surface on your phone/laptop
- Navigate to the **pitch-deck** surface
- Have the grid visible behind it (back button ready)

---

## [SLIDE 1 — 0:00] HOOK

> "A picture speaks a thousand words. But right now, your AI agent can't show you a single one."

*Pause. Let it land.*

---

## [SLIDE 2 — 0:15] PROBLEM

> "Agents can think, act, and ship. They write your code, search the web, manage your files. But they have no screen. Everything they do comes back as text in a terminal. We think that's broken."

---

## [SLIDE 3 — 0:35] SOLUTION

> "So we built Surface. The first AI agent display."

---

## [SLIDE 4 — 0:45] META REVEAL

> "And by the way — this presentation you're watching right now? It's running on Surface. An AI agent built this slideshow and pushed it to my screen."

*Hit the back button. Go to the grid. Let them see all the surfaces.*

---

## [GRID — 0:55] LIVE DEMO

> "And this is the home screen. Everything here was built by an AI agent."

**Show these surfaces (tap in, show for 5 sec, tap back):**

1. **Chick-fil-A Near You** — "I told my agent I was hungry at the hackathon. It pulled up the nearest Chick-fil-A with a map. Didn't search for it, didn't open Google Maps. Just told my agent."

2. **Pomodoro Timer** — "Need a focus timer? Agent built it. Fully interactive."

3. **Gesture at the full grid** — "29 surfaces. Games, music players, research papers, study guides, maps, a typing test, a calculator. All agent-built. No templates, no drag and drop."

---

## [TAP BACK INTO PITCH DECK, SLIDE 5 — 1:45] WHAT IT IS

> "Think of Surface as a second monitor — but it belongs to your AI agent. It can put anything on it."

> "It works with Claude Code, OpenClaw, or any agent that speaks HTTP. Single line setup — just `npx surface`. And there's a marketplace where people share what their agents build with everyone."

---

## [SLIDE 6 — 2:15] KARPATHY VALIDATION

> "Andrej Karpathy — the person who coined the term 'vibe coding' — has said we need a new kind of workspace built natively for AI. Every IDE out there is a VS Code fork. Surface is what a native agent workspace actually looks like. Not for writing code — but for everything else."

---

## [SLIDE 7 — 2:40] WHY NOW

> "Every company is building agents that DO things. Nobody has solved where the user SEES things."

> "We're not building an app. We're building the platform underneath all of them. The more agents exist, the more displays they need."

---

## [SLIDE 8 — 3:15] CLOSE

> "What if you never had to download an app again? You just tell your agent what you need, and it appears."

> "That's Surface."

*Stop talking. Smile. Let them come to you with questions.*

---

## DEMO FLOW CHEAT SHEET

```
1. Open pitch-deck surface (slides 1-4)
2. After meta reveal -> hit BACK to grid
3. Tap "Chick-fil-A Near You" -> back
4. Tap "Pomodoro Timer" -> back
5. Gesture at grid (29 surfaces)
6. Tap "pitch-deck" again -> resume slide 5
7. Finish slides 5-8
```

---

## Q&A PREP — HAVE THESE ANSWERS READY

**"Who's the user?"**
> Developers and teams building with AI agents who need a display target. Today it's Claude Code users. Tomorrow it's every agent framework.

**"How do you make money?"**
> Marketplace cut on shared surfaces and themes. Pro tier for teams. Enterprise licensing for companies deploying agents internally.

**"Why can't the agent just use the browser?"**
> It can, but that's like saying why do you need a phone when you have a computer. Surface is purpose-built, frictionless, and the agent owns it end to end. No tab switching, no URLs, no HTML files dumped on your desktop.

**"What exists already?"**
> a2ui does UI generation but doesn't own the display. No one has built a dedicated, persistent, agent-controlled display with a marketplace and real-time bidirectional communication. We're first.

**"Can it work with other agents?"**
> Yes. Any agent that can make HTTP calls can use Surface. The protocol is open. We've used it with Claude Code and OpenClaw. It plugs into any agent toolchain.

**"How does it work technically?"**
> Express server, SQLite, Server-Sent Events for real-time updates. The agent connects via MCP or HTTP. It pushes HTML/CSS/JS to the display. The user interacts, actions flow back to the agent. It's a full bidirectional loop.

**"What about enterprise?"**
> In enterprise, knowledge is scattered across 15 systems and nobody can find anything. Surface gives your internal AI agent a display to surface the right information, right when someone needs it. No more digging through Confluence, Jira, and Slack.

**"Why should this exist beyond the hackathon?"**
> Because every agent needs a display and none of them have one. This isn't a hackathon project — we've been building this. 29 surfaces created by real usage, a marketplace, theming engine, real-time communication. This is a product.

**[BACK POCKET] If they push back on the concept:**
> "Even Karpathy has said we need a native AI workspace. We're not speculating — the demand is already here. We use Surface every day. Our agents built everything you just saw."

**[BACK POCKET] If they ask about Nexlayer specifically:**
> "Surface and Nexlayer are complementary. Nexlayer is where the app runs. Surface is where the user sees it. Together it's the complete agent-native pipeline — from code to cloud to screen."

---

## SURFACES TO SHOW (all already built)

### Primary Demo (use these during the pitch)
| Surface | Why show it |
|---------|------------|
| **Chick-fil-A Near You** | Relatable, proves real-world utility, "I was hungry at the hackathon" |
| **Pomodoro Timer** | Clean, interactive, everyone knows what it is |
| **The grid itself** | 29 surfaces = volume, proves this is real usage not a demo |

### If Judges Want to See More (tap through quickly)
| Surface | Why |
|---------|-----|
| **ROAST-GPT** | An LLM running inside a surface — AI inside AI |
| **Econ Quiz Explainer** | Shows educational use case |
| **Spotify** | Media embedding, familiar app |
| **Calculator** | Classic utility, interactive |
| **Snake / Pac-Man / AI Pong** | Games — shows range, fun factor |
| **Monkeytype** | Typing test — interactive, polished |
| **PDF Creation Progress** | Agent progress tracking — the "second monitor" story |
| **Mini Piano** | Playable instrument — delightful surprise |

### Don't Show (skip these during pitch)
| Surface | Why skip |
|---------|---------|
| Nexlayer Deploy | Auth isn't working, don't risk it |
| Auto-Quant / TurboQuant specs | Too niche, judges won't relate |
| HF Paper PDF | Not visually interesting |
| Welcome to Surface | Generic |
| Daily Quote | Too simple |

---

## TIMING CHECK

| Section | Duration | Cumulative |
|---------|----------|------------|
| Hook | 15s | 0:15 |
| Problem | 20s | 0:35 |
| Solution | 10s | 0:45 |
| Meta reveal | 10s | 0:55 |
| Live demo | 50s | 1:45 |
| What it is | 30s | 2:15 |
| Karpathy | 25s | 2:40 |
| Why now | 35s | 3:15 |
| Close | 30s | 3:45 |
| Buffer | 15s | 4:00 |
