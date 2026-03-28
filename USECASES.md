# Surface: Use Cases & Hackathon Playbook

> **Surface** — The last app. A universal display that AI agents own end-to-end.

---

## The Pitch

**One sentence:** Surface is a single PWA that replaces every app on your phone — because your AI agent builds whatever you need, live, on the fly.

**Elevator pitch (30 seconds):**

Every app you use is just HTML rendered in a rectangle. Surface gives that rectangle to your AI agent. Need a timer? The agent builds one. Need a dashboard? Built. A game? Done. A CRM? Materialized. The agent doesn't just answer questions — it ships full, interactive software to your screen in real time, watches you use it, and updates it while you're looking at it. One app. Every app. The last app you install.

**The tagline options:**

- "The last app."
- "One app. Every app."
- "Your AI builds the app. You just use it."
- "Software on demand."

---

## Why Surface Is Different

### vs. Widgets (iOS/Android)
Widgets are static, pre-built, developer-defined. Surface widgets are generated on the fly by AI, fully interactive, run JavaScript, and update in real time via SSE. Your agent can change every pixel while you watch.

### vs. Notion / Coda
These are structured document tools with templates. Surface is raw creative power — the agent pushes arbitrary HTML/CSS/JS. There's no template. No schema. No constraints. The agent can build a 3D solar system as easily as a spreadsheet.

### vs. Dashboard tools (Grafana, Retool)
Dashboards require data source configuration, query builders, and drag-and-drop layout. Surface: you tell your agent what you want and it appears. No configuration. No drag and drop. Just intent to interface.

### vs. Artifacts (Claude, ChatGPT Canvas)
Artifacts live inside the chat window. They're previews. Surface is a standalone PWA that lives on your homescreen. It persists. It hot-reloads. The agent can remote-control navigation, push notifications, execute JavaScript in running surfaces, and the user can send actions back to the agent. It's two-way. It's an OS.

### vs. Custom GPTs / Assistants
Those give you a chat interface with a system prompt. Surface gives you a DISPLAY. The agent doesn't talk to you — it builds for you. The output isn't text — it's software.

---

## Use Cases by Category

---

### Personal Productivity

#### 1. Instant Pomodoro Timer
**Pitch:** Say "I need to focus for 25 minutes" and a beautiful animated Pomodoro timer materializes on your screen with sound effects and session tracking.

**Technical:** `surface_create` with HTML/CSS/JS timer app. `overlay` for a persistent countdown bar across all views. `display_notify` when the timer ends (style: "success"). `surface_exec` to pause/resume without rebuilding. Two-way: user clicks "Break" button, agent receives the action and pushes a 5-minute break timer.

**Why it's compelling:** No app download. No configuration. You described a need in natural language and got a full interactive app in seconds. The overlay means you see the countdown no matter what else you're doing on Surface.

#### 2. Dynamic To-Do List with Smart Prioritization
**Pitch:** A living, breathing to-do list that the agent reorganizes in real-time based on deadlines, dependencies, and your behavior.

**Technical:** `surface_create` for the to-do interface. Two-way communication: user checks off items, agent receives `surface_action`, updates priorities, and pushes a reordered list via `surface_update`. `display_notify` for deadline reminders. `surface_exec` to animate completed items flying off screen.

**Why it's compelling:** The list is alive. It rearranges itself. It nags you with toasts. The agent watches your behavior and adapts.

#### 3. Meeting Prep Dashboard
**Pitch:** "I have a meeting with Acme Corp in 10 minutes" — and Surface builds a briefing page with their LinkedIn profiles, your last email thread summary, talking points, and a live clock.

**Technical:** `surface_create` for the briefing. `home` widget for a countdown to meeting time. `display_navigate` to force it on screen. `display_notify` as a 2-minute warning. After the meeting, agent replaces it with a follow-up action items surface.

**Why it's compelling:** Context-aware, ephemeral software. It exists for exactly as long as you need it, then transforms.

#### 4. Daily Morning Briefing
**Pitch:** Every morning at 7am, your Surface lights up with weather, calendar, top news, and a motivational quote. One glance. No scrolling. No apps.

**Technical:** `surface_create` or `surface_update` a persistent "Morning Brief" surface. `home` widget for an analog clock. `display_set_theme` to shift colors based on weather (warm orange for sunny, cool blue for rain). `display_navigate` to push it on screen. `overlay` for ambient weather particle effects (rain, snow, sun rays).

**Why it's compelling:** Your phone becomes a personalized information display. No app switching. No notification hell. Just signal.

#### 5. Habit Tracker with Streak Visualization
**Pitch:** A gorgeous habit tracker where each day's completion lights up a tile in an ever-growing mosaic. Break a streak and tiles visually crack.

**Technical:** `surface_create` for the tracker grid. `surface_exec` to animate tile completion on tap. Two-way: user taps a habit, agent logs it and calls `surface_exec` to run a confetti animation. `display_notify` (style: "success") for milestone streaks. `overlay` for a persistent streak counter.

**Why it's compelling:** The visual feedback is instant and visceral. No habit app offers this level of custom animation.

---

### Entertainment / Gaming

#### 6. Live Snake Game
**Pitch:** "Make me a game" and a fully playable Snake game appears with touch/keyboard controls, high score tracking, and custom themes.

**Technical:** `surface_create` with a complete canvas-based Snake game. `display_set_theme` to match the game's color scheme (dark neon). `surface_exec` to inject cheat codes or difficulty adjustments. Two-way: game posts high scores, agent congratulates via `reply` (toast).

**Why it's compelling:** A real, playable game materialized from a sentence. Not a link. Not a download. The game IS the app.

#### 7. Interactive Fiction Engine
**Pitch:** The agent writes a branching narrative and renders it as a beautiful choose-your-own-adventure interface. Every choice sends a message back to the agent, which writes the next chapter live.

**Technical:** `surface_create` for the story UI. Two-way: every choice triggers a `surface_action`. Agent processes it, generates the next story beat, and calls `surface_update` with new HTML. `display_set_theme` to change ambiance (dark/horror, warm/romance, cold/sci-fi). `overlay` for ambient mood effects (flickering for horror, particles for sci-fi).

**Why it's compelling:** The narrative is infinite. The agent IS the game engine. The entire visual environment shifts to match the story's mood.

#### 8. Trivia Night Host
**Pitch:** Surface becomes a live trivia game show. Questions appear with countdown timers, answer buttons, scoring, and leaderboards — all for a group gathered around one phone or tablet.

**Technical:** `surface_create` for the trivia interface. `surface_exec` to inject questions one at a time with timer animations. Two-way: players tap answers, agent scores in real-time. `display_notify` for correct/wrong feedback. `display_set_theme` for game show aesthetics (bright, bold, animated). `renderer` for a custom game-show homescreen between rounds.

**Why it's compelling:** No app to download. No account to create. Someone says "let's play trivia" and it's running in 5 seconds.

#### 9. Ambient Music Visualizer
**Pitch:** A mesmerizing, full-screen audio-reactive visual experience — without any audio API needed. The agent generates evolving fractal patterns, wave simulations, and color fields that shift over time.

**Technical:** `surface_create` with WebGL/Canvas animations. `renderer` to take over the entire screen with generative art. `display_set_theme` with nebula effects and matching colors. `surface_exec` to shift parameters (speed, color palette, geometry) in real-time based on agent decisions or time of day.

**Why it's compelling:** Your phone becomes a piece of living art. A digital lava lamp controlled by AI.

#### 10. Pac-Man / Retro Arcade
**Pitch:** Say "I'm bored" and a pixel-perfect retro arcade game drops onto your screen, complete with authentic sound effects and CRT scan-line overlay.

**Technical:** `surface_create` for the game. `overlay` for CRT scan-line effect (CSS repeating-linear-gradient overlay). `display_set_theme` with retro green-on-black color scheme, monospace font. `renderer` to display a retro arcade cabinet interface as the homescreen showing all available games.

**Why it's compelling:** The CRT overlay demonstrates how the overlay system adds atmosphere to ANY surface. The agent transforms your entire phone into a retro arcade cabinet.

---

### Information / Dashboards

#### 11. Real-Time Crypto/Stock Ticker
**Pitch:** A live, auto-updating financial dashboard that the agent keeps fresh — with charts, price alerts, and portfolio summaries.

**Technical:** `surface_create` for the dashboard. `surface_exec` to inject updated price data periodically without full page reload. `display_notify` (style: "warning") for price alerts. `overlay` for a persistent ticker tape along the top of the screen. `home` widget for a mini portfolio summary on the homescreen.

**Why it's compelling:** The agent can update individual numbers via `surface_exec` without any page flicker. The overlay ticker tape works across ALL views.

#### 12. Weather Station
**Pitch:** A gorgeous weather display with animated conditions (rain particles, sun rays, cloud movements), hourly forecasts, and radar maps.

**Technical:** `surface_create` for the main weather surface. `display_set_theme` to match current weather (blue sky gradient, dark storm clouds). `overlay` for rain/snow particle effects that fall across everything. `home` widget for current temp and icon. `display_notify` for severe weather alerts (style: "error").

**Why it's compelling:** The entire phone's atmosphere changes with the weather. Rain falls across your card grid. The background shifts from sunny gradients to storm clouds.

#### 13. Flight Tracker
**Pitch:** Track a flight in real time with an animated map, progress bar, arrival countdown, and gate information — all generated from a flight number.

**Technical:** `surface_create` for the flight dashboard. `surface_exec` to update the plane's position on the map over time. `display_notify` for status changes ("Now boarding", "Delayed 15 min"). `overlay` for a persistent flight status bar.

**Why it's compelling:** No Flightradar24 app needed. You said a flight number and got a custom tracking dashboard.

#### 14. Package Tracking Central
**Pitch:** One surface showing all your in-transit packages with progress bars, estimated delivery times, and a map — auto-updated as the agent monitors tracking numbers.

**Technical:** `surface_create` for the tracking dashboard. `surface_exec` to update individual package statuses without reloading. `display_notify` (style: "success") when a package is delivered. `order` to pin this surface at the top of the grid.

**Why it's compelling:** Consolidates a dozen tracking links into one live-updating view.

---

### Education / Learning

#### 15. Interactive Flashcard System
**Pitch:** The agent creates beautiful, animated flashcards for any topic. Swipe mechanics, spaced repetition, progress tracking, and an encouraging toast when you nail a streak.

**Technical:** `surface_create` for the flashcard UI with swipe/tap interactions. Two-way: user answers via buttons, agent receives actions, tracks correct/incorrect, adjusts card order (spaced repetition). `surface_update` to add new cards or change difficulty. `display_notify` (style: "success") for streaks. `home` widget showing study progress.

**Why it's compelling:** A complete spaced-repetition learning system materialized from "help me study organic chemistry."

#### 16. Live Code Playground
**Pitch:** An in-Surface code editor with syntax highlighting, a run button, and live output — perfect for learning to code or prototyping.

**Technical:** `surface_create` with a Monaco-style editor (or custom textarea with highlighting). Two-way: user clicks "Run", code is sent as an action, agent evaluates it (or it runs client-side) and pushes output via `surface_update` or `surface_exec`. `display_notify` for errors (style: "error").

**Why it's compelling:** A full IDE in your pocket, built on demand. The agent can also provide hints and corrections by injecting code suggestions via `surface_exec`.

#### 17. Interactive Timeline
**Pitch:** "Teach me about the Roman Empire" and a scrollable, interactive timeline appears with events, images, and expandable detail cards. Touch any event to deep-dive.

**Technical:** `surface_create` for the timeline interface. Two-way: tapping an event sends an action, agent generates a detailed sub-surface and calls `display_navigate` to show it. Back button returns to timeline. `display_set_theme` with period-appropriate styling (marble textures, serif fonts for Rome).

**Why it's compelling:** The agent creates an entire interactive museum exhibit. The theming makes it immersive.

#### 18. Math Problem Visualizer
**Pitch:** The agent doesn't just solve equations — it renders animated visualizations. Watch a quadratic equation graph itself, see matrix transformations in real-time, or watch a sorting algorithm execute step by step.

**Technical:** `surface_create` with Canvas/SVG animations. `surface_exec` to step through algorithm visualizations frame by frame. Two-way: user controls speed, selects different algorithms. `display_set_theme` with a clean, academic aesthetic.

**Why it's compelling:** Math becomes visual and interactive. The agent is a personal tutor with infinite patience and a whiteboard.

---

### Creative Tools

#### 19. Collaborative Mood Board
**Pitch:** Tell the agent a vibe — "70s sunset road trip" — and it generates a mood board with color palettes, typography suggestions, layout ideas, and image placeholders.

**Technical:** `surface_create` for the mood board layout. `display_set_theme` to make the entire Surface environment match the mood (warm oranges, retro fonts, grain texture via CSS). `overlay` for a subtle film-grain effect. Two-way: user marks favorites, agent refines.

**Why it's compelling:** The agent doesn't just show you the mood — it transforms your entire phone into that mood.

#### 20. ASCII Art Generator
**Pitch:** The agent converts concepts into beautiful ASCII art, displayed in a monospace terminal aesthetic. "Draw a cat." Done.

**Technical:** `surface_create` with monospace font, terminal-green-on-black styling. `display_set_theme` with CRT aesthetics, scanline overlay, monospace font globally. `surface_exec` to animate the ASCII art being "typed out" character by character.

**Why it's compelling:** The typing animation sells it. Watching ASCII art render character by character is mesmerizing.

#### 21. Color Palette Explorer
**Pitch:** Tell the agent a feeling, a brand, or a season, and it generates harmonious color palettes with hex codes, contrast ratios, and live previews applied to your Surface theme.

**Technical:** `surface_create` for palette display with swatches. `display_set_theme` to live-preview each palette AS the Surface theme (the phone itself becomes the preview). Two-way: user picks a palette, agent locks it in. `display_notify` with the hex codes.

**Why it's compelling:** The preview IS the product. Selecting a palette literally transforms the entire app's appearance.

#### 22. Pixel Art Canvas
**Pitch:** A touch-friendly pixel art editor with a palette, undo/redo, and export — built entirely in a surface.

**Technical:** `surface_create` for the pixel grid canvas. Two-way: user draws, finished art is sent as an action, agent can provide suggestions or apply filters via `surface_exec`. `display_set_theme` with pixel-art-appropriate aesthetics (chunky, 8-bit).

**Why it's compelling:** A creative tool materialized from nothing. No App Store. No purchase. No signup.

---

### Social / Communication

#### 23. Live Poll / Voting Surface
**Pitch:** Create a live poll in seconds. Share the Surface URL. Watch votes animate in real-time with a bar chart that grows.

**Technical:** `surface_create` for the poll UI. Two-way: each vote is a `surface_action`. Agent tallies votes and calls `surface_exec` to animate the bar chart. `display_notify` for milestones ("50 votes!"). `renderer` to show a dramatic results reveal.

**Why it's compelling:** Zero infrastructure. No Google Forms. No SurveyMonkey. A live, animated, interactive poll in seconds.

#### 24. Shared Playlist Visualizer
**Pitch:** A collaborative playlist where each person adds songs via Surface actions, and the agent renders an evolving visual mix-tape with album art grids, genre breakdowns, and mood analysis.

**Technical:** `surface_create` for the playlist display. Two-way: users submit songs. Agent updates the grid via `surface_update`. `display_set_theme` to match the playlist's mood (energetic = bright neons, chill = muted pastels). `surface_exec` for smooth add-to-list animations.

**Why it's compelling:** Music becomes visual and collaborative without any streaming service integration needed.

#### 25. Event Countdown Board
**Pitch:** "We're getting married on June 15th" — and a gorgeous countdown surface appears with days/hours/minutes, confetti animations, and milestone celebrations.

**Technical:** `surface_create` for the countdown. `surface_exec` to update the clock every second. `overlay` for confetti that appears at milestone moments. `display_notify` (style: "success") at 100 days, 30 days, 1 week, etc. `display_set_theme` with wedding-appropriate theming.

**Why it's compelling:** Deeply personal, beautiful, and effortless. Share the URL and everyone sees the same live countdown.

---

### Developer Tools

#### 26. API Health Dashboard
**Pitch:** Monitor your APIs with a real-time status board — green/yellow/red indicators, response times, uptime percentages, and incident logs.

**Technical:** `surface_create` for the dashboard. `surface_exec` to update individual endpoint statuses without full reload. `display_notify` (style: "error") for downtime alerts. `overlay` for a persistent global status indicator (green dot = all systems go). `home` widget for a quick at-a-glance summary.

**Why it's compelling:** No Datadog setup. No PagerDuty integration. Describe your endpoints and the agent builds a monitoring board.

#### 27. Git Commit Visualizer
**Pitch:** A live visualization of your repository's commit history — branching trees, contributor activity heatmaps, and file-change flame graphs.

**Technical:** `surface_create` with SVG/Canvas visualizations. `surface_update` to refresh with new data. `display_set_theme` with dark IDE-like aesthetics (Dracula/Monokai colors). Two-way: click a commit to see details.

**Why it's compelling:** Makes your codebase's history tangible and visual. Useful for standups and retrospectives.

#### 28. JSON/Data Inspector
**Pitch:** Paste any JSON, CSV, or data blob, and the agent renders it as a beautiful, collapsible tree view, a table, or a chart — whatever makes sense for the data shape.

**Technical:** `surface_create` for the data viewer with interactive tree/table. Two-way: user clicks nodes to expand. Agent can annotate anomalies via `surface_exec` (highlight outliers, flag missing fields). `display_set_theme` with IDE-like colors.

**Why it's compelling:** The agent chooses the best visualization for the data automatically. Not just a JSON viewer — a data understanding tool.

#### 29. Regex Tester
**Pitch:** A live regex playground where matches highlight in real-time, with explanation of what each part of the pattern does.

**Technical:** `surface_create` for the regex interface. Two-way: user types regex and test string, agent processes and pushes highlighted results via `surface_update`. Agent-generated explanations appear alongside matches. `display_notify` for invalid regex (style: "error").

**Why it's compelling:** Interactive, educational, and instantly available. The agent explains the regex, not just matches it.

---

### Health / Wellness

#### 30. Breathing Exercise Guide
**Pitch:** A calming, animated breathing guide with expanding/contracting circles, haptic-like visual cues, and session tracking. "Help me calm down" and it appears.

**Technical:** `surface_create` with CSS animation breathing circle. `display_set_theme` with calming colors (soft blues, purples), no starfield, gentle nebula. `overlay` for ambient calm (soft pulsing gradient). `surface_exec` to adjust timing (4-7-8 breathing vs. box breathing) without reloading. `display_notify` (style: "success") after session completes.

**Why it's compelling:** The entire phone transforms into a calming instrument. No app branding. No upsells. Just a breathing circle.

#### 31. Water Intake Tracker
**Pitch:** A visual water tracker with an animated glass that fills up as you log drinks, celebrating when you hit your daily goal.

**Technical:** `surface_create` for the glass visualization. Two-way: tap to log a drink, agent increments and animates via `surface_exec`. `overlay` for a persistent hydration progress bar. `display_notify` (style: "success") at 50% and 100% of goal. `home` widget showing current progress.

**Why it's compelling:** Simple, delightful, and the animation of water filling a glass is oddly satisfying.

#### 32. Workout Timer
**Pitch:** "I want to do a HIIT workout — 30 seconds on, 10 seconds rest, 8 rounds" and a full-screen workout timer appears with round tracking, audio-style visual cues, and rest-period countdowns.

**Technical:** `surface_create` for the timer. `surface_exec` to manage state transitions (work/rest) with smooth animations. `display_set_theme` with high-energy colors during work (red/orange), calming during rest (blue/green). `display_notify` for round transitions. `overlay` for a persistent round counter.

**Why it's compelling:** The entire phone changes color based on your workout state. Red = push hard. Blue = breathe. No gym app competes with this level of immersion.

---

### Finance

#### 33. Budget Snapshot
**Pitch:** A clean, at-a-glance view of where your money went this month — category breakdowns, burn rate, and days until payday.

**Technical:** `surface_create` for the budget dashboard with donut charts and category bars. `surface_exec` to update amounts without reloading. `home` widget for remaining budget. `display_notify` (style: "warning") when approaching budget limits. `order` to pin it as the first card.

**Why it's compelling:** No Mint. No YNAB. No bank-app login. A clean financial snapshot from a conversation.

#### 34. Tip / Bill Split Calculator
**Pitch:** At dinner, say "split $127.50 four ways with 20% tip" and a gorgeous split calculator appears showing each person's share.

**Technical:** `surface_create` for the calculator display. Two-way: tap to adjust tip percentage or number of people, agent recalculates and pushes via `surface_exec`. `display_set_theme` with clean, restaurant-receipt aesthetics.

**Why it's compelling:** Faster than any calculator app. Purpose-built in real-time for your exact situation.

#### 35. Invoice Generator
**Pitch:** "Create an invoice for 10 hours of consulting at $150/hour for Acme Corp" and a professional, printable invoice surface appears.

**Technical:** `surface_create` for the invoice with print-friendly CSS. Two-way: user edits line items, agent recalculates totals via `surface_update`. PDF embedding via the `/proxy/pdf` endpoint for previewing alongside reference documents.

**Why it's compelling:** A fully formatted, professional invoice from a sentence. No QuickBooks. No template hunting.

---

### Smart Home / IoT

#### 36. Smart Home Control Panel
**Pitch:** A custom control panel for your lights, thermostat, and devices — with big, touch-friendly buttons and real-time status indicators.

**Technical:** `surface_create` for the control panel. Two-way: user taps buttons (e.g., "Living Room Lights"), agent receives the action and proxies to smart home APIs, then calls `surface_exec` to update the button state. `display_set_theme` matching room ambiance. `home` widget for quick-access controls.

**Why it's compelling:** No SmartThings app. No HomeKit. A control panel designed by AI specifically for YOUR devices, YOUR layout preferences.

#### 37. Security Camera Grid
**Pitch:** A mosaic view of all your security cameras with live snapshots updating at intervals.

**Technical:** `surface_create` with an iframe-or-img grid of camera feeds. `surface_exec` to rotate through cameras or update snapshots. `display_notify` (style: "error") for motion alerts. `display_navigate` to force the camera surface on screen when motion is detected.

**Why it's compelling:** The agent can force-navigate to the security view when something happens. Your phone becomes a security monitor automatically.

#### 38. Plant Care Dashboard
**Pitch:** Track your houseplants with watering schedules, health indicators, and time-since-last-watered visualizations. Each plant is a card with a visual health meter.

**Technical:** `surface_create` for the plant dashboard. Two-way: tap to mark as watered, agent resets timer via `surface_exec`. `display_notify` (style: "warning") for overdue plants. `home` widget for today's watering list. `overlay` for a subtle leaf-particle effect.

**Why it's compelling:** A niche use case that demonstrates Surface can do ANYTHING. The leaf-particle overlay is a nice touch.

---

### Wild / Viral / Demo-Worthy

#### 39. CRT TV Homescreen
**Pitch:** Your Surface homescreen becomes a vintage CRT television. Each surface is a "channel." Turn a knob to switch. Static between channels. Scanlines. The whole experience.

**Technical:** `renderer` to completely replace the homescreen with a CRT TV interface — rounded screen corners, scan-line overlay, static noise transitions between channels. Each surface is a channel accessed via a dial. `window.navigate(id)` to switch channels. `window.__surfaces` to populate the channel list. `display_set_theme` with green phosphor colors, CRT font. `overlay` for persistent scanline effect.

**Why it's compelling:** This is PURE hackathon gold. The nostalgia factor is off the charts. People will take videos of this and share them. It demonstrates the insane flexibility of the renderer system.

#### 40. Solar System Navigator
**Pitch:** Every surface is a planet orbiting a sun. The homescreen is a 3D solar system. Click a planet to visit that surface. Planets grow larger as surfaces get more activity.

**Technical:** `renderer` with a CSS 3D or Canvas solar system animation. `window.__surfaces` mapped to planets. `window.parseMeta()` to get icons/descriptions for planet labels. `window.navigate(id)` on planet click. `window.onSurfaceChange()` to add/remove planets live when surfaces are created/deleted. `display_set_theme` with deep space colors, starfield enabled, nebula enabled.

**Why it's compelling:** It's beautiful, it's interactive, and it's LIVE — new surfaces appear as new planets in real-time. The spatial metaphor makes information architecture tangible.

#### 41. Operating System Simulator
**Pitch:** Surface becomes a fake desktop OS — complete with a taskbar, start menu, draggable windows, and a desktop with icons. Each surface is a "program."

**Technical:** `renderer` for the full OS interface (taskbar, desktop icons, window management). `window.__surfaces` as installed programs. `window.navigate(id)` opens a surface in a "window." `display_set_theme` with Windows 95 or macOS aesthetics. `overlay` for a persistent taskbar clock. `window.onSurfaceChange()` to add icons when new surfaces are created.

**Why it's compelling:** Running an "operating system" inside a PWA that's controlled by AI is the kind of recursive absurdity that gets tech Twitter very excited.

#### 42. The Matrix Rain
**Pitch:** Your entire Surface display runs Matrix-style green character rain — and the surfaces are hidden behind the rain, revealed when you touch the screen.

**Technical:** `overlay` for the Matrix rain effect (canvas animation, pointer-events: none so you can still interact). `display_set_theme` with Matrix green (#00ff41) as accent, black void, monospace font. `renderer` for a Matrix-styled surface list where titles appear as falling code.

**Why it's compelling:** It's iconic. Everyone recognizes it. It demonstrates overlay persistence perfectly — the rain falls over EVERYTHING, including individual surfaces.

#### 43. Tamagotchi Pet
**Pitch:** A virtual pet living in your Surface. It gets hungry, sleepy, bored. Feed it by tapping. The agent monitors its mood and sends you notifications when it needs attention.

**Technical:** `surface_create` for the pet interface with pixel-art animations. Two-way: tap actions (feed, play, sleep) are sent to the agent. Agent tracks pet state and pushes updates via `surface_update`. `display_notify` (style: "warning") when the pet is hungry. `home` widget showing pet status. `surface_exec` to run mood-change animations. Agent can force `display_navigate` to the pet when it's desperate.

**Why it's compelling:** The two-way communication makes this genuinely interactive. The pet sends YOU notifications. The agent force-navigates you to it. Your phone is alive.

#### 44. Live Collaborative Whiteboard
**Pitch:** A shared drawing canvas. Multiple people open the same Surface URL. Draw with touch. See each other's strokes in real-time.

**Technical:** `surface_create` for the canvas. Two-way: strokes are sent as actions with coordinate data. Agent broadcasts strokes to all viewers via `surface_exec` (inject draw commands). `display_set_theme` with clean white or dark canvas aesthetics.

**Why it's compelling:** Real-time collaboration without any backend beyond what Surface already provides. The agent is the collaboration server.

#### 45. AI Art Gallery
**Pitch:** The agent curates an art gallery in Surface. Each surface is a "room" with generated art, descriptions, and an immersive theme. Walk through rooms. The gallery evolves over time.

**Technical:** Multiple `surface_create` calls for gallery rooms. `renderer` for a gallery lobby with room thumbnails. `display_set_theme` per room (change colors/font/background as you navigate). `display_navigate` for guided tours. `overlay` for a persistent "now viewing" label. `display_notify` for curator notes.

**Why it's compelling:** The per-room theming means each room FEELS different. Walking through the gallery is genuinely immersive. The whole phone transforms.

#### 46. Live Concert Visualizer
**Pitch:** Surface becomes a concert stage. Pulsing lights, laser beam animations, waveforms, fog effects. Set it on your desk and it's ambiance.

**Technical:** `renderer` for the full-screen stage visualization with WebGL. `display_set_theme` with deep blacks and neon accents. `surface_exec` to change visual modes (lasers, strobes, waves). `overlay` for persistent haze/fog effect. Starfield for a galaxy background.

**Why it's compelling:** Turn your phone into a light show. Place it behind a bottle at dinner and it's ambient art. Pure vibe.

#### 47. Escape Room Puzzle
**Pitch:** The agent builds a multi-room escape room entirely in Surface. Each room is a surface with puzzles. Solve one to unlock the next. Hints via toast notifications.

**Technical:** Multiple `surface_create` for rooms. Two-way: user interactions (click objects, enter codes) are sent as actions. Agent validates solutions and calls `display_navigate` to the next room. `display_notify` for hints. `display_set_theme` to change atmosphere per room. `surface_exec` for puzzle animations (doors opening, locks clicking).

**Why it's compelling:** A complete multi-level game experience built entirely by the agent, played on a single URL. The room transitions with theme changes are cinematic.

#### 48. Fake Hacker Terminal
**Pitch:** Your phone becomes a Hollywood-style hacking terminal. Green text cascading. "ACCESS GRANTED" appearing. Progress bars filling. Completely fake, completely awesome.

**Technical:** `surface_create` with terminal UI. `surface_exec` to inject sequential "hacking" commands with delays. `display_set_theme` with green-on-black, monospace font, no nebula. `overlay` for a persistent "SECURE CONNECTION" header. `display_notify` for dramatic reveals ("FIREWALL BYPASSED", style: "success"). Sound-effect-like visual flashes via `surface_exec`.

**Why it's compelling:** People LOVE this stuff. It's the kind of thing that gets 10M views on TikTok. And it's being built live by an AI agent.

---

## The 5 Killer Demos

These are the demos to show at a hackathon judging panel, a product launch, or a Twitter/X video. They're ordered for maximum dramatic impact.

---

### Demo 1: "Build Me a Game" (30 seconds)

**Setup:** Open Surface on your phone. It shows the empty state: "Surface something. Your agents are waiting."

**What happens:**
1. Tell your agent: "Make me a Snake game."
2. In ~5 seconds, a fully playable Snake game card materializes on the grid with a live preview thumbnail.
3. Tap the card. Play the game. It works with swipe controls.
4. Die. The game sends your score back to the agent.
5. A toast notification appears: "High score: 47! Want to try again?"

**Why it kills:** Zero to game in seconds. The live preview thumbnail shows the game is real. The two-way communication (score feedback) shows it's not static HTML — there's a living agent behind it.

**Tools used:** `surface_create`, two-way `surface_action`, `reply` (toast)

---

### Demo 2: "Change Everything" (20 seconds)

**Setup:** The Snake game from Demo 1 is still there, plus a few other surfaces.

**What happens:**
1. Tell your agent: "Make this look like an 80s arcade."
2. The ENTIRE app transforms: background shifts to deep purple, card borders glow neon pink, font changes to a blocky pixel font, nebula colors shift to hot pink and electric blue, a CRT scanline overlay fades in over everything.
3. All the surface cards now look like arcade cabinets.
4. Every surface you tap into has the scanline effect on top.

**Why it kills:** The audience sees EVERYTHING change at once — colors, fonts, effects, overlays. It demonstrates that the agent owns the entire display, not just content. The overlay following you into individual surfaces proves persistence.

**Tools used:** `display_set_theme` (colors, font, nebula, background, css, overlay)

---

### Demo 3: "The CRT TV" (30 seconds)

**Setup:** Several surfaces exist (the game, a clock, a dashboard).

**What happens:**
1. Tell your agent: "Make the homescreen a CRT television."
2. The entire homescreen dissolves and is replaced by a vintage CRT TV with rounded screen corners, a physical TV frame with knobs, scan lines, and static.
3. A channel number appears in the corner. "Ch. 1 — Snake Game."
4. Turn the channel knob. STATIC burst — then "Ch. 2 — Dashboard" appears.
5. Each surface is a channel. The TV is fully interactive.
6. Create a new surface → a new channel appears automatically (live SSE).

**Why it kills:** This is the "holy shit" moment. The agent didn't just push content — it redesigned the entire operating system metaphor. The static transitions between channels. The live channel addition via SSE. People will literally gasp.

**Tools used:** `display_set_theme` (renderer), `window.__surfaces`, `window.navigate()`, `window.onSurfaceChange()`

---

### Demo 4: "The Two-Way Agent" (30 seconds)

**Setup:** Create a surface with a "mood check" interface (happy/sad/stressed buttons).

**What happens:**
1. Show the mood check surface. "How are you feeling?"
2. Tap "Stressed."
3. The agent receives the action. A toast appears: "I'm on it."
4. The surface updates: a breathing exercise guide with an expanding/contracting circle replaces the mood buttons.
5. The entire Surface theme shifts to calm blues and soft purples.
6. A nebula effect glows softly. The starfield dims.
7. An overlay adds a subtle ambient pulse across all views.
8. After 60 seconds, a notification: "Feeling better? Tap when you're ready."

**Why it kills:** The phone RESPONDED to an emotion. It didn't just show content — it changed its entire being to match. This is the moment people realize Surface isn't a display. It's an empathetic operating system.

**Tools used:** `surface_create`, two-way `surface_action`, `surface_update`, `display_set_theme` (colors, nebula, overlay), `display_notify`

---

### Demo 5: "The Last App" (45 seconds)

**Setup:** Surface is empty.

**What happens (rapid-fire):**
1. "Show me the weather." → A weather dashboard with animated rain particles appears. (3 sec)
2. "What's Bitcoin at?" → A crypto ticker card materializes below it with live price. (3 sec)
3. "Start a 5-minute focus timer." → A timer overlay appears at the top of the screen, counting down across all views. (3 sec)
4. "I'm bored. Give me a game." → Pac-Man drops onto the grid. (3 sec)
5. "Make this whole thing look like a spaceship cockpit." → Everything transforms: dark hull grey, HUD-green accents, monospace font, radar-sweep overlay. (3 sec)
6. Pan across all the surfaces. They all live together. The timer overlay persists. The theme is cohesive.
7. "Delete everything." → Cards dissolve one by one with a blur-out animation. The grid returns to "Surface something. Your agents are waiting."

**Why it kills:** Five different "apps" created in 15 seconds. A persistent overlay across all of them. A complete visual transformation. Then total cleanup. This is the "last app" demo. You just watched a weather app, a finance app, a productivity app, a game, and a theme engine all exist in one place, controlled by one agent, and then vanish without a trace.

**Tools used:** `surface_create` (x4), `overlay`, `display_set_theme` (full transformation), `surface_delete` (x4), every major capability shown

---

## Technical Differentiators to Emphasize

| Capability | What to Say |
|---|---|
| **SSE Live Updates** | "No polling. No refresh. Content appears the instant the agent pushes it." |
| **surface_exec** | "The agent can reach into a running app and change a single number without reloading the page." |
| **Two-way Actions** | "The app talks back. User taps a button, the agent receives it, reasons about it, and responds." |
| **Renderer** | "The agent can replace the entire operating system interface. Not just content — the OS." |
| **Overlay** | "Persistent layers that follow you everywhere. Rain effects. Status bars. Clocks. They never go away." |
| **Theme System** | "The agent controls every pixel. Colors, fonts, backgrounds, nebula effects, card shapes — everything." |
| **Same-origin Iframes** | "Full JavaScript execution. Canvas, WebGL, fetch, Web APIs — no sandbox restrictions." |
| **PWA** | "Install it to your homescreen. It runs standalone. No browser chrome. It IS an app." |
| **OpenClaw Integration** | "Any AI agent platform can drive it. Claude, GPT, Gemini, open-source — any agent, one display." |

---

## What Makes People Say "Holy Shit"

1. **Speed of creation** — Surface fills with real, working, interactive apps faster than you can open the App Store.
2. **Live updates** — Watching content change without touching anything (SSE) feels like magic.
3. **The renderer** — Replacing the entire homescreen metaphor (CRT TV, solar system, OS desktop) is a paradigm-breaking moment.
4. **Environmental transformation** — When the ENTIRE phone shifts mood (colors, nebula, particles, fonts) to match context, it feels sentient.
5. **The overlay** — Rain falling on top of your Snake game. A timer persisting across every view. It proves Surface isn't pages — it's layers.
6. **Two-way communication** — The app talking back to the agent and receiving intelligent responses crosses from "display" to "operating system."
7. **surface_exec** — Surgically updating one element in a running app without any flicker or reload. It's like the agent has hands inside your screen.
8. **Destruction** — Watching apps dissolve and vanish with a sentence is the perfect contrast to creation. Easy come, easy go. That's what "last app" means.

---

## Closing Line for Presentations

> "Every app on your phone was built by a developer who guessed what you might need. Surface is built by an agent who knows what you need right now. One app. Every app. The last app."
