const app = document.getElementById("app");
let surfaces = [];
let globalSSE = null;
let surfaceSSE = null;
let currentSurfaceId = null;
let displayConfig = {};
let features = { marketplace: false };

// ── postMessage bridge (iframe → server) ──

window.addEventListener("message", (e) => {
  if (!e.data) return;

  // Renderer/overlay/widget navigation
  if (e.data.type === "surface_navigate") {
    if (e.data.surface_id) {
      navigate("/surface/" + e.data.surface_id);
    } else {
      navigate("/");
    }
    return;
  }

  // Surface action bridge (iframe → server)
  if (e.data.type !== "surface_action") return;
  const surfaceId = currentSurfaceId;
  if (!surfaceId) return;

  fetch(`/surfaces/${surfaceId}/actions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: e.data.action,
      data: e.data.data || {},
    }),
  }).catch(() => {});
});

// ── Empty-state cycling suggestions ──
// Shows a rotating list of things the user could ask their agent for.
// Each suggestion "prints in" with the same scan-wipe used elsewhere.

const EMPTY_SUGGESTIONS = [
  "Surface me a pomodoro",
  "Put today's weather on my surface",
  "Surface me a snake game",
  "a meditation guide",
  "Surface me a 7-minute workout",
  "a bill-split calculator",
  "Put today's headlines on my surface",
  "the chord progression to wonderwall",
  "Surface me a habit tracker",
  "an ascii art cat",
  "Surface a breathing circle",
  "Put a flashcard deck for biology on my surface",
  "Surface me a kanban board",
  "a recipe for tonight's dinner",
];

// Typewriter cycle: type-in → hold → type-out → next. Letters print at
// 38ms each, hold 2400ms, delete at 24ms each, 250ms pause between.
let emptySuggestionT = null;
function cycleEmptySuggestions(root) {
  if (emptySuggestionT) { clearTimeout(emptySuggestionT); emptySuggestionT = null; }
  const slot = root.querySelector(".empty-suggestion-text");
  if (!slot) return;
  let i = Math.floor(Math.random() * EMPTY_SUGGESTIONS.length);

  const step = (phase, text, charPos) => {
    // Stop when the slot has been removed from the document. We can't
    // use `body.contains(slot)` here because the very first call runs
    // while the container is still detached (renderGrid attaches it
    // a few lines later); `isConnected` would short-circuit then.
    if (!slot.parentNode) return;
    if (phase === "type-in") {
      slot.textContent = text.slice(0, charPos);
      if (charPos < text.length) {
        emptySuggestionT = setTimeout(() => step("type-in", text, charPos + 1), 38 + Math.random() * 24);
      } else {
        emptySuggestionT = setTimeout(() => step("hold", text, charPos), 2400);
      }
    } else if (phase === "hold") {
      emptySuggestionT = setTimeout(() => step("type-out", text, text.length), 0);
    } else if (phase === "type-out") {
      slot.textContent = text.slice(0, charPos);
      if (charPos > 0) {
        emptySuggestionT = setTimeout(() => step("type-out", text, charPos - 1), 24);
      } else {
        i = (i + 1) % EMPTY_SUGGESTIONS.length;
        // Seed the first character of the next suggestion immediately so
        // the line never sits empty between cycles.
        slot.textContent = EMPTY_SUGGESTIONS[i].slice(0, 1);
        emptySuggestionT = setTimeout(() => step("type-in", EMPTY_SUGGESTIONS[i], 2), 120);
      }
    }
  };
  // Seed the first character of the first suggestion immediately too.
  step("type-in", EMPTY_SUGGESTIONS[i], 1);
}

// ── Toast notifications ──

function showToast(text, duration = 4000, style = "info") {
  const toast = document.createElement("div");
  toast.className = "toast";
  if (style && style !== "info") toast.classList.add("toast--" + style);
  toast.textContent = text;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("toast--visible"));
  setTimeout(() => {
    toast.classList.remove("toast--visible");
    toast.addEventListener("transitionend", () => toast.remove());
  }, duration);
}

// ── Clipboard helper ──
// async Clipboard API first; falls back to a hidden-textarea +
// document.execCommand("copy") so non-secure contexts still get a real
// auto-copy without forcing the user to ⌘C themselves.

async function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return true; } catch {}
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.left = "0";
  ta.style.opacity = "0";
  ta.style.pointerEvents = "none";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand("copy"); } catch {}
  ta.remove();
  return ok;
}

// ── Tutorial modal ──
// The "Take the tour" button on the empty state opens this. It hands
// the user a copy-pasteable prompt that activates their agent's
// tutorial-walkthrough flow (defined in docs/TUTORIAL.md and gated by
// INSTALL_FOR_AGENTS.md). Surface itself does not run the tutorial —
// the agent does — so the modal is intentionally just a prompt + copy.

const TUTORIAL_PROMPT =
  "Walk me through the Surface tutorial in docs/TUTORIAL.md. Update the tutorial state in INSTALL_FOR_AGENTS.md as you progress.";

function showTutorialModal() {
  // Don't double-open
  if (document.getElementById("tutorial-modal")) return;

  const overlay = document.createElement("div");
  overlay.id = "tutorial-modal";
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="tutorial-title">
      <button type="button" class="modal-close" aria-label="Close">×</button>
      <div class="modal-eyebrow">Tutorial</div>
      <h2 id="tutorial-title" class="modal-title">Hand this to your agent</h2>
      <p class="modal-lede">Surface doesn't run the tour itself — your agent does. Paste the prompt below into your agent's chat and it will walk you through the five-minute tour.</p>
      <pre class="modal-prompt" id="tutorial-prompt-text">${escapeHtml(TUTORIAL_PROMPT)}</pre>
      <div class="modal-actions">
        <button type="button" class="modal-copy-btn" id="tutorial-copy-btn">
          <span class="modal-copy-glyph" aria-hidden="true"></span>
          Copy prompt
        </button>
      </div>
      <div class="modal-sub">After running, your agent updates <span class="modal-mono">INSTALL_FOR_AGENTS.md</span> so re-runs skip the tour.</div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => {
    overlay.classList.remove("modal-overlay--visible");
    overlay.addEventListener("transitionend", () => overlay.remove(), { once: true });
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };

  overlay.querySelector(".modal-close").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", onKey);

  const copyBtn = overlay.querySelector("#tutorial-copy-btn");
  const setBtnLabel = (label, done) => {
    copyBtn.innerHTML = `<span class="modal-copy-glyph" aria-hidden="true"></span>${escapeHtml(label)}`;
    copyBtn.classList.toggle("modal-copy-btn--done", !!done);
  };
  copyBtn.addEventListener("click", async () => {
    const ok = await copyToClipboard(TUTORIAL_PROMPT);
    setBtnLabel(ok ? "Copied" : "Copy failed", ok);
    setTimeout(() => setBtnLabel("Copy prompt", false), 2200);
  });

  requestAnimationFrame(() => overlay.classList.add("modal-overlay--visible"));
}

// Make available to inline onclick attributes
window.showTutorialModal = showTutorialModal;

// ── Surface-idea portal ──
// A giant white circle on the right of the empty state, cycling
// through evocative one-line surface ideas. Clicking opens a modal
// with a fleshed-out prompt the user can hand to their agent.

// Each idea has a `demo` field — a self-contained HTML document that
// runs in an iframe inside the portal disc. Inline scripts are fine:
// the iframes are sandboxed (allow-scripts only) so they can animate
// without reaching into the parent. The demos are the surface itself,
// not a description of it; clicking opens the prompt modal.

const DEMO_BREATHING = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:100%;height:100%;background:#000;overflow:hidden;display:flex;align-items:center;justify-content:center;font-family:-apple-system,Helvetica,Arial,sans-serif;color:#fff}.b{width:64px;height:64px;border-radius:50%;background:#fff;animation:b 14s cubic-bezier(.45,0,.55,1) infinite}@keyframes b{0%{transform:scale(1)}28.5%,57%{transform:scale(3.4)}100%{transform:scale(1)}}</style></head><body><div class="b"></div></body></html>`;

const DEMO_CONSTELLATION = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:100%;height:100%;background:#000;overflow:hidden;font-family:-apple-system,Helvetica,Arial,sans-serif}.s{position:absolute;background:#fff;border-radius:50%;animation:tw 4s ease-in-out infinite}@keyframes tw{0%,100%{opacity:.3;transform:scale(1)}50%{opacity:1;transform:scale(1.4)}}</style></head><body><script>let h='';for(let i=0;i<70;i++){const sz=Math.random()<.08?4:Math.random()<.22?2.4:1.4;const op=.3+Math.random()*.6;h+='<div class="s" style="left:'+(Math.random()*100)+'%;top:'+(Math.random()*100)+'%;width:'+sz+'px;height:'+sz+'px;opacity:'+op+';animation-delay:'+(Math.random()*4)+'s"></div>'}document.body.innerHTML=h;</script></body></html>`;

const DEMO_POSTMARK = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:100%;height:100%;background:#000;overflow:hidden;display:flex;align-items:center;justify-content:center;font-family:Georgia,'Times New Roman',serif;color:#111}.p{width:230px;background-color:#ffffff;padding:28px 24px;color:#111;font-size:12px;line-height:1.65}.f{font-family:-apple-system,Helvetica,sans-serif;font-size:9px;color:#888;margin-bottom:14px;text-transform:uppercase;letter-spacing:1.4px}.l{margin-top:10px}.sig{margin-top:14px;text-align:right;font-style:italic;color:#444}</style></head><body><div class="p"><div class="f">Postmark · 2030</div><div class="l">Dear you,</div><div class="l">The thing you spent today worrying about — you won't remember it next month.</div><div class="l">The thing you started this morning, though, you'll think about for years.</div><div class="sig">— me</div></div></body></html>`;

const DEMO_4AM = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:100%;height:100%;background:#000;overflow:hidden;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:-apple-system,Helvetica,Arial,sans-serif;color:#fff;gap:14px}.t{font-size:80px;font-weight:300;font-variant-numeric:tabular-nums;letter-spacing:-.03em;animation:p 3.4s ease-in-out infinite}.s{font-size:11px;color:rgba(255,255,255,.45);letter-spacing:1.6px;text-transform:uppercase}@keyframes p{0%,100%{opacity:.82}50%{opacity:1}}</style></head><body><div class="t" id="t">03:47</div><div class="s">the world is asleep</div><script>const hrs=[23,0,1,2,3,4];const h=hrs[Math.floor(Math.random()*hrs.length)];const m=Math.floor(Math.random()*60);document.getElementById('t').textContent=String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')</script></body></html>`;

const DEMO_GARDEN = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:100%;height:100%;background:#000;overflow:hidden;display:flex;align-items:flex-end;justify-content:center;padding-bottom:50px}svg{width:170px;height:320px;animation:sw 6s ease-in-out infinite;transform-origin:50% 100%}@keyframes sw{0%,100%{transform:rotate(-1.2deg)}50%{transform:rotate(1.2deg)}}.st{stroke:#fff;stroke-width:1.6;fill:none;stroke-linecap:round}.lf{fill:#fff;opacity:.88}.fl{fill:#fff}.fl-h{fill:#fff;opacity:.55}</style></head><body><svg viewBox="0 0 170 320"><path class="st" d="M85,315 Q85,250 85,190 Q78,158 64,134 Q54,112 60,86 Q66,62 78,40"/><ellipse class="lf" cx="64" cy="156" rx="15" ry="6.5" transform="rotate(-32 64 156)"/><ellipse class="lf" cx="76" cy="215" rx="13" ry="5.5" transform="rotate(28 76 215)"/><circle class="fl" cx="78" cy="38" r="10"/><circle class="fl-h" cx="78" cy="32" r="4.5"/></svg></body></html>`;

const DEMO_TAROT = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:100%;height:100%;background:#000;overflow:hidden;display:flex;align-items:center;justify-content:center;font-family:-apple-system,Helvetica,Arial,sans-serif}.k{position:relative;width:160px;height:230px}.c{position:absolute;inset:0;background:#000;border:1px solid rgba(255,255,255,.55);border-radius:5px}.c:nth-child(1){transform:translate(-8px,5px) rotate(-2.4deg)}.c:nth-child(2){transform:translate(-3px,2px) rotate(-.8deg)}.c:nth-child(3){transform:translate(2px,0) rotate(.5deg)}.c:nth-child(4){transform:translate(7px,-3px) rotate(1.8deg);animation:wob 6s ease-in-out infinite;display:flex;align-items:center;justify-content:center}.dot{width:5px;height:5px;border-radius:50%;background:rgba(255,255,255,.6)}@keyframes wob{0%,100%{transform:translate(7px,-3px) rotate(1.8deg)}50%{transform:translate(10px,-7px) rotate(2.6deg)}}</style></head><body><div class="k"><div class="c"></div><div class="c"></div><div class="c"></div><div class="c"><div class="dot"></div></div></div></body></html>`;

const DEMO_MEMENTO = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:100%;height:100%;background:#000;overflow:hidden;display:flex;align-items:center;justify-content:center}.g{display:grid;grid-template-columns:repeat(64,4px);gap:1px}.w{width:4px;height:4px;background:transparent;border:1px solid rgba(255,255,255,.16)}.w.f{background:#fff;border-color:transparent}</style></head><body><div class="g" id="g"></div><script>const C=64,R=63,T=C*R,L=Math.floor(T*0.36);let h='';for(let i=0;i<T;i++)h+='<div class="w'+(i<L?' f':'')+'"></div>';document.getElementById('g').innerHTML=h;</script></body></html>`;

const DEMO_SMALLWINS = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:100%;height:100%;background:#000;overflow:hidden;font-family:-apple-system,Helvetica,Arial,sans-serif;color:#fff;font-size:13px;position:relative}.col{position:absolute;left:0;right:0;display:flex;flex-direction:column;align-items:center;gap:18px;padding-top:60%;animation:sc 32s linear infinite}.e{display:flex;gap:12px;align-items:baseline;white-space:nowrap}.d{font-size:11px;color:rgba(255,255,255,.32);font-variant-numeric:tabular-nums}.t{color:rgba(255,255,255,.9)}@keyframes sc{from{transform:translateY(0)}to{transform:translateY(-50%)}}</style></head><body><div class="col" id="col"></div><script>const w=["Wrote the email I'd been avoiding","Made tea instead of doomscrolling","Sent the PR","Walked outside before noon","Said no to the meeting","Read 20 pages","Called Dad","Closed 7 tabs","Shipped the typo fix","Asked for help","Cooked from scratch","Got the haircut","Apologized first","Logged off at 6","Finished the chapter"];const td=new Date();const fmt=d=>String(d.getMonth()+1).padStart(2,'0')+'/'+String(d.getDate()).padStart(2,'0');let h='';for(let p=0;p<2;p++){for(let i=0;i<w.length;i++){const d=new Date(td);d.setDate(d.getDate()-i);h+='<div class="e"><span class="d">'+fmt(d)+'</span><span class="t">'+w[i]+'</span></div>'}}document.getElementById('col').innerHTML=h;</script></body></html>`;

const DEMO_LIGHTHOUSE = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:100%;height:100%;background:#000;overflow:hidden;display:flex;align-items:center;justify-content:center;font-family:-apple-system,Helvetica,Arial,sans-serif;color:#fff;position:relative}.q{font-size:19px;font-weight:400;line-height:1.45;max-width:280px;text-align:center;color:rgba(255,255,255,.88);position:relative;z-index:2;padding:0 30px}.b{position:absolute;top:0;bottom:0;width:55%;left:-55%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.08),transparent);animation:sw 9s linear infinite;z-index:1;pointer-events:none}@keyframes sw{0%{left:-55%}100%{left:100%}}</style></head><body><div class="q">"What am I doing this year? Why this and not something else?"</div><div class="b"></div></body></html>`;

const DEMO_CONFESSIONAL = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:100%;height:100%;background:#000;overflow:hidden;display:flex;flex-direction:column;justify-content:center;align-items:center;padding:0 60px;gap:14px;font-family:-apple-system,Helvetica,Arial,sans-serif;color:#fff;font-size:13px}.pst{color:rgba(255,255,255,.32);text-align:center;animation:fd 9s linear infinite;font-size:12px}.nw{color:#fff;text-align:center}.nw::after{content:"";display:inline-block;width:1px;height:14px;background:#fff;vertical-align:text-bottom;margin-left:3px;animation:bl 1s steps(2,end) infinite}@keyframes fd{0%{opacity:.45}100%{opacity:0}}@keyframes bl{0%,50%{opacity:1}51%,100%{opacity:0}}.ts{font-size:9px;color:rgba(255,255,255,.2);margin-left:5px}</style></head><body><div class="pst">I am tired of pretending <span class="ts">deletes in 47 min</span></div><div class="pst" style="animation-delay:-3s">I didn't mean what I said <span class="ts">deletes in 21 min</span></div><div class="nw">I think I'm done</div></body></html>`;

const DEMO_BONFIRE = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:100%;height:100%;background:#000;overflow:hidden;font-family:-apple-system,Helvetica,Arial,sans-serif;color:#fff;font-size:14px;font-weight:400;position:relative}.r{position:absolute;left:50%;transform:translateX(-50%);animation:rs 10s linear infinite;white-space:nowrap;color:rgba(255,255,255,.72)}@keyframes rs{0%{bottom:18%;opacity:.7;letter-spacing:0;filter:blur(0)}55%{opacity:.32;letter-spacing:4px;filter:blur(.5px)}90%,100%{bottom:80%;opacity:0;letter-spacing:14px;filter:blur(3px)}}</style></head><body><span class="r" style="animation-delay:0s">the thing he said</span><span class="r" style="animation-delay:-3.3s">tonight's argument</span><span class="r" style="animation-delay:-6.6s">that old ambition</span></body></html>`;

const DEMO_SUNDIAL = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:100%;height:100%;background:#000;overflow:hidden;display:flex;align-items:center;justify-content:center;font-family:-apple-system,Helvetica,Arial,sans-serif}.r{position:relative;width:340px;height:340px}.m{position:absolute;left:50%;top:50%;width:2px;height:14px;background:#fff;margin-left:-1px;margin-top:-156px;transform-origin:1px 156px;border-radius:1px}.pk{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);color:rgba(255,255,255,.32);font-size:10px;letter-spacing:2px;text-transform:uppercase}</style></head><body><div class="r" id="r"></div><script>const pk=16;let h='';for(let i=0;i<24;i++){const dist=Math.min(Math.abs(i-pk),24-Math.abs(i-pk));const op=Math.max(.12,1-dist*0.16);h+='<div class="m" style="transform:rotate('+(i*15)+'deg);opacity:'+op+'"></div>'}h+='<div class="pk">4 PM</div>';document.getElementById('r').innerHTML=h;</script></body></html>`;

const SURFACE_IDEAS = [
  {
    title: "A constellation of your week",
    sub: "Tasks as stars. Closer deadlines burn brighter.",
    demo: DEMO_CONSTELLATION,
    prompt: 'Make me a Surface called "Constellation". Show my upcoming week as a starfield on pure black — each task is a single white star, the closer its deadline the brighter and larger it glows. Hovering a star reveals the title; clicking marks it done and the star fades out like a dying ember. Add tasks by clicking empty space (prompt me for title + date). Persist via the Surface artifact API. White-on-black only, no other colors. The feeling should be: looking up at a sky that is actually mine.',
  },
  {
    title: "A breathing room",
    sub: "One slow circle. Inhale, hold, exhale.",
    demo: DEMO_BREATHING,
    prompt: 'Make me a Surface called "Breathing Room". A single white circle that grows for 4 seconds (inhale), holds for 4 (hold), shrinks for 6 (exhale), with the matching word fading in at each phase. The rest of the screen is black. No buttons, no settings, no counts, no streaks. Tapping anywhere switches to a stillness mode that just sits as long as I want. Should feel like the room is breathing with me.',
  },
  {
    title: "Letters from your future self",
    sub: "A daily letter. Postmarked from someone older.",
    demo: DEMO_POSTMARK,
    prompt: 'Make me a Surface called "Postmark 2030". Every morning, show one short letter (3-5 sentences) written by me-from-the-future to me-now — kind, specific, never preachy. Frame it like an opened envelope on a desk; serif body type, monochrome. I can write a one-paragraph reply that gets saved but never shown again — it is a release. Persist letters as artifacts. The mood is quiet correspondence across time.',
  },
  {
    title: "The 4am club",
    sub: "A journal that only opens when the world is asleep.",
    demo: DEMO_4AM,
    prompt: 'Make me a Surface called "4am Club". A black journal that only accepts entries between 11pm and 5am — outside those hours it shows a closed envelope and the time until it next opens. Inside, each entry is timestamped with how late I was up. No editing past entries, no streaks, no rewards — just an honest log of the hours when I think differently. Persist via Surface artifacts. Should feel like sneaking into your own confessional.',
  },
  {
    title: "A garden that grows with focus",
    sub: "Don't switch tabs. Watch it bloom.",
    demo: DEMO_GARDEN,
    prompt: 'Make me a Surface called "Focus Garden". A pure-white plant in pure black soil — when this tab is in focus and active, it grows by tiny visible increments; when I switch away, growth pauses. After 25 unbroken minutes, it flowers. After days of broken focus, it slowly wilts. Use document.visibilitychange to detect attention. No notifications, no scolding — the plant just lives or doesn\'t. Persist its state via Surface artifacts. The feeling: caring for something fragile that mirrors my attention.',
  },
  {
    title: "A tarot deck for decisions",
    sub: "Shuffle. Draw. Decide.",
    demo: DEMO_TAROT,
    prompt: 'Make me a Surface called "Decision Deck". A stack of 22 black cards face-down in the center. I click to draw — the top card flips with a flick animation and reveals one of 22 hand-written prompts ("Choose the option that scares you slightly more", "Wait until tomorrow", "Pick what you\'d tell a friend to pick", etc.). One draw per day; persist today\'s card. Pure typography on the cards, no illustrations. Should feel like consulting an oracle that respects me.',
  },
  {
    title: "A clock that counts weeks, not minutes",
    sub: "4,000 weeks. Some already spent.",
    demo: DEMO_MEMENTO,
    prompt: 'Make me a Surface called "Memento Mori". A tight grid of 4,000 small squares — one for each week of an 80-year life. Squares for weeks I\'ve already lived (ask me once for my birth date) are filled white; the rest are 1px hairline outlines. Below the grid: a single line reading "X weeks remaining". No countdown ticking, no animation — it\'s a still photograph of my finite time. Persist my birth date as artifact metadata.',
  },
  {
    title: "A ledger of small wins",
    sub: "Only the tiny victories. Logged in your own hand.",
    demo: DEMO_SMALLWINS,
    prompt: 'Make me a Surface called "Small Wins". A long scrollable column of single-line entries, each prefixed with today\'s date and dimming with age. The only input is a text field at the top: "What was a small win today?" Enter to log. No deletes, no edits, no shame for empty days — but no streaks either. The wins compound visually as the list lengthens. Persist as a Surface artifact. The feeling: a private accumulation of evidence that I am, in fact, building a life.',
  },
  {
    title: "The lighthouse",
    sub: "One question, all day, every day.",
    demo: DEMO_LIGHTHOUSE,
    prompt: 'Make me a Surface called "Lighthouse". The center of the screen holds a single question I answered once on setup ("What am I doing this year? Why this and not something else?") — and it stays there, only that question, every time I open this surface. An edit affordance refines the answer; previous versions fade into a small history below. Nothing else on screen. The metaphor: a beam I can return to when I drift.',
  },
  {
    title: "A confession booth",
    sub: "Write a secret. It deletes itself in an hour.",
    demo: DEMO_CONFESSIONAL,
    prompt: 'Make me a Surface called "Confessional". A black void with a single blinking caret. I type whatever I need to get out. There is no save button — entries auto-delete one hour after I close the tab, and they never leave my machine. While visible, each previous entry shows with a faint timestamp ("deletes in 47 min"). Persist with Surface artifacts but with an expiry; sweep expired ones on next render. Should feel like an unjudging room with the door closing behind me.',
  },
  {
    title: "A bonfire for things you're letting go of",
    sub: "Write what you're done carrying. Watch it burn.",
    demo: DEMO_BONFIRE,
    prompt: 'Make me a Surface called "Bonfire". A black screen with a small text field at the bottom: "What are you putting down?" When I submit, the text rises slowly to the center of the screen, lingers a few seconds, then dissolves character-by-character into faint scattered dots that fade out. Nothing is saved anywhere — no record, no list, no history. The whole point is that it\'s gone. Should feel like watching paper curl in flame.',
  },
  {
    title: "A sundial of your peak hour",
    sub: "A ring of 24 marks. The brightest one is when you ship.",
    demo: DEMO_SUNDIAL,
    prompt: 'Make me a Surface called "Sundial". A large white ring divided into 24 hourly marks. Every time I press the spacebar while on this surface, it logs the current hour. Over days, the most-pressed marks brighten — slowly forming a personal map of when I\'m actually awake to my own life. After a week I can see my real peak hours vs. the ones I tell myself. Persist hourly press counts via the Surface artifact API. Spare: a single ring, no labels until I hover a mark.',
  },
];

let portalIndex = -1;
let portalT = null;

function pickNextIdeaIndex() {
  if (SURFACE_IDEAS.length <= 1) return 0;
  let next;
  do { next = Math.floor(Math.random() * SURFACE_IDEAS.length); }
  while (next === portalIndex);
  return next;
}

function paintPortal(portal) {
  const idea = SURFACE_IDEAS[portalIndex];
  portal.querySelector(".portal-title").textContent = idea.title;
  portal.querySelector(".portal-sub").textContent = idea.sub;
  const frame = portal.querySelector(".portal-demo");
  if (frame) frame.srcdoc = idea.demo;
}

function cyclePortal(root) {
  if (portalT) { clearTimeout(portalT); portalT = null; }
  const portal = root.querySelector(".empty-portal");
  if (!portal) return;
  const disc = portal.querySelector(".portal-disc");
  const meta = portal.querySelector(".portal-meta");

  portalIndex = pickNextIdeaIndex();
  paintPortal(portal);

  portal.addEventListener("click", () => {
    showIdeaModal(SURFACE_IDEAS[portalIndex]);
  });

  const step = () => {
    if (!portal.isConnected) return;
    // Pause cycling while user is hovering or focused on the portal
    if (portal.matches(":hover") || portal.matches(":focus-visible")) {
      portalT = setTimeout(step, 1600);
      return;
    }
    disc.classList.add("portal-disc--hidden");
    meta.classList.add("portal-meta--hidden");
    portalT = setTimeout(() => {
      if (!portal.isConnected) return;
      portalIndex = pickNextIdeaIndex();
      paintPortal(portal);
      disc.classList.remove("portal-disc--hidden");
      meta.classList.remove("portal-meta--hidden");
      portalT = setTimeout(step, 8000);
    }, 480);
  };
  portalT = setTimeout(step, 8000);
}

function showIdeaModal(idea) {
  if (document.getElementById("idea-modal")) return;

  const overlay = document.createElement("div");
  overlay.id = "idea-modal";
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="idea-title">
      <button type="button" class="modal-close" aria-label="Close">×</button>
      <div class="modal-eyebrow">A surface you could make</div>
      <h2 id="idea-title" class="modal-title">${escapeHtml(idea.title)}</h2>
      <p class="modal-lede">${escapeHtml(idea.sub)}</p>
      <pre class="modal-prompt">${escapeHtml(idea.prompt)}</pre>
      <div class="modal-actions">
        <button type="button" class="modal-copy-btn" id="idea-copy-btn">Copy prompt</button>
      </div>
      <div class="modal-sub">Paste into your agent's chat and let it build.</div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => {
    overlay.classList.remove("modal-overlay--visible");
    overlay.addEventListener("transitionend", () => overlay.remove(), { once: true });
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };

  overlay.querySelector(".modal-close").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", onKey);

  const copyBtn = overlay.querySelector("#idea-copy-btn");
  const setBtnLabel = (label, done) => {
    copyBtn.textContent = label;
    copyBtn.classList.toggle("modal-copy-btn--done", !!done);
  };
  copyBtn.addEventListener("click", async () => {
    const ok = await copyToClipboard(idea.prompt);
    setBtnLabel(ok ? "Copied" : "Copy failed", ok);
    setTimeout(() => setBtnLabel("Copy prompt", false), 2200);
  });

  requestAnimationFrame(() => overlay.classList.add("modal-overlay--visible"));
}

window.showIdeaModal = showIdeaModal;

// ── Theme system ──

function jsonParse(v) {
  if (typeof v === "string") { try { return JSON.parse(v); } catch { return v; } }
  return v;
}

function applyTheme(config) {
  if (!config || Object.keys(config).length === 0) {
    // Reset to defaults
    document.documentElement.removeAttribute("style");
    document.body.removeAttribute("style");
    const themeCSS = document.getElementById("theme-css");
    if (themeCSS) themeCSS.remove();
    const overlay = document.getElementById("display-overlay");
    if (overlay) overlay.remove();
    const hw = document.getElementById("home-widget");
    if (hw) hw.remove();
    displayConfig = {};
    return;
  }
  const root = document.documentElement;

  // Normalize stringified fields
  config.colors = jsonParse(config.colors);
  config.nebulaColors = jsonParse(config.nebulaColors);
  config.order = jsonParse(config.order);
  if (typeof config.starfield === "string") config.starfield = config.starfield === "true";
  if (typeof config.nebula === "string") config.nebula = config.nebula === "true";

  // CSS custom properties
  if (config.colors && typeof config.colors === "object") {
    const map = {
      void: "--void",
      glass: "--glass",
      glassBorder: "--glass-border",
      glassGlow: "--glass-glow",
      textPrimary: "--text-primary",
      textSecondary: "--text-secondary",
      textGhost: "--text-ghost",
      accent: "--accent",
    };
    for (const [key, prop] of Object.entries(map)) {
      if (config.colors[key]) root.style.setProperty(prop, config.colors[key]);
    }
  }

  // Background
  if (config.background) {
    document.body.style.background = config.background;
  } else if (config.colors && config.colors.void) {
    document.body.style.background = config.colors.void;
  }

  // Font
  if (config.font) {
    document.body.style.fontFamily = config.font;
  }

  // Card radius
  if (config.cardRadius) {
    root.style.setProperty("--card-radius", config.cardRadius);
  }

  // Cosmic substrate — on by default. An explicit `starfield: false`
  // from a theme hides every cosmic layer (starfield, nebulae, aurora,
  // grain, comets). Themes that want their own background opt out
  // wholesale by passing `starfield: false`.
  const substrateOn = config.starfield !== false;
  const starfield = document.getElementById("starfield");
  if (starfield) starfield.style.display = substrateOn ? "" : "none";
  document.querySelectorAll(".nebula, .aurora, .grain").forEach((el) => {
    el.style.display = substrateOn ? "" : "none";
  });

  // Optional nebula color overrides (back-compat).
  if (config.nebulaColors && config.nebulaColors.length >= 2) {
    const n1 = document.querySelector(".nebula--1");
    const n2 = document.querySelector(".nebula--2");
    if (n1) n1.style.background = `radial-gradient(circle, ${config.nebulaColors[0]}, transparent 70%)`;
    if (n2) n2.style.background = `radial-gradient(circle, ${config.nebulaColors[1]}, transparent 70%)`;
  }

  // Custom CSS injection — wrapped in @layer theme so shell styles always win
  let customStyle = document.getElementById("theme-css");
  if (config.css) {
    if (!customStyle) {
      customStyle = document.createElement("style");
      customStyle.id = "theme-css";
      document.head.appendChild(customStyle);
    }
    customStyle.textContent = config.css;
  } else if (customStyle) {
    customStyle.remove();
  }

  // Theme color meta tag
  if (config.colors && config.colors.void) {
    let meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = config.colors.void;
  }

  // Persistent overlay (across all views)
  renderOverlay(config);

  // Refresh home widget if it changed
  const hw = document.getElementById("home-widget");
  if (hw && config.home) {
    hw.src = "/display/home/html?" + Date.now();
  } else if (hw && !config.home) {
    hw.remove();
  }

  displayConfig = config;
}

function renderOverlay(config) {
  let overlay = document.getElementById("display-overlay");
  if (config.overlay) {
    if (!overlay) {
      overlay = document.createElement("iframe");
      overlay.id = "display-overlay";
      overlay.src = "/display/overlay/html";
      document.body.appendChild(overlay);
    } else {
      overlay.src = "/display/overlay/html?" + Date.now();
    }
  } else if (overlay) {
    overlay.remove();
  }
}

// ── Theme suspend/resume (for Explore view) ──

function suspendTheme() {
  const themeCSS = document.getElementById("theme-css");
  if (themeCSS) themeCSS.disabled = true;
  document.documentElement.removeAttribute("style");
  document.body.removeAttribute("style");
  const overlay = document.getElementById("display-overlay");
  if (overlay) overlay.style.display = "none";
}

function resumeTheme() {
  const themeCSS = document.getElementById("theme-css");
  if (themeCSS) themeCSS.disabled = false;
  if (displayConfig && Object.keys(displayConfig).length > 0) {
    applyTheme(displayConfig);
  }
  const overlay = document.getElementById("display-overlay");
  if (overlay) overlay.style.display = "";
}

// ── Presence reporting ──

function reportPresence() {
  const route = getRoute();
  fetch("/display/presence", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      current_view: route.view,
      current_surface_id: route.view === "surface" ? route.id : null,
      viewport_width: window.innerWidth,
      viewport_height: window.innerHeight,
    }),
  }).catch(() => {});
}

// ── Routing ──

function navigate(path) {
  window.location.hash = path;
}

function getRoute() {
  const hash = window.location.hash.slice(1) || "/";
  if (hash === "/") return { view: "grid" };
  if (hash === "/explore") return { view: "explore" };
  const match = hash.match(/^\/surface\/(.+)$/);
  if (match) return { view: "surface", id: match[1] };
  return { view: "grid" };
}

window.addEventListener("hashchange", render);

// ── Cosmic substrate ──
// One container holds: aurora ribbon, two/three nebulae, three star
// layers (parallax via initParallax), and a positioning surface for
// comets. The container is always inserted; an explicit theme
// `starfield: false` hides everything cosmic via display:none.

function createAurora() {
  const el = document.createElement("div");
  el.className = "aurora";
  el.id = "aurora";
  return el;
}

function createGrain() {
  const el = document.createElement("div");
  el.className = "grain";
  el.id = "grain";
  return el;
}

// Fire one comet at a random angle from offscreen-left across the
// upper third of the canvas. Throttled by `pulseSpace`.
function fireComet() {
  const starfield = document.getElementById("starfield");
  if (!starfield || starfield.style.display === "none") return;
  const c = document.createElement("div");
  c.className = "comet";
  const y = 8 + Math.random() * 38;
  const angle = 12 + Math.random() * 14;
  c.style.setProperty("--cy", y + "%");
  c.style.setProperty("--cx", (-5 - Math.random() * 8) + "%");
  c.style.setProperty("--angle", angle + "deg");
  starfield.appendChild(c);
  setTimeout(() => c.remove(), 1700);
}

// SSE event coupling: aurora pulses, occasionally a comet streaks.
let spacePulseT = 0;
function pulseSpace(opts) {
  const starfield = document.getElementById("starfield");
  if (!starfield) return;
  if (Date.now() - spacePulseT < 450) return; // throttle
  spacePulseT = Date.now();
  starfield.classList.remove("aurora-burst");
  void starfield.offsetWidth; // reflow to restart aurora animation
  starfield.classList.add("aurora-burst");
  setTimeout(() => starfield.classList.remove("aurora-burst"), 1500);
  // Comet on bigger events (creates, theme changes) — not on every tick.
  if (opts && opts.comet) fireComet();
}

// Background comet shower — one streak every 22-52s when the tab is
// visible. The cosmos isn't static, just patient.
let cometShowerT = null;
function startCometShower() {
  if (cometShowerT) clearTimeout(cometShowerT);
  const tick = () => {
    if (document.visibilityState === "visible") fireComet();
    cometShowerT = setTimeout(tick, 22000 + Math.random() * 30000);
  };
  cometShowerT = setTimeout(tick, 6000 + Math.random() * 8000);
}

// ── Starfield (3 parallax layers) — always on, themes opt out ──

function createStarfield() {
  const el = document.createElement("div");
  el.className = "starfield";
  el.id = "starfield";

  // Aurora goes inside so it benefits from the same z=0 stacking +
  // can be color-pulsed by toggling .aurora-burst on the parent.
  el.appendChild(createAurora());

  const layers = [
    { class: "star--far",  count: 110, parallax: 0.008 },
    { class: "star--mid",  count: 55,  parallax: 0.022 },
    { class: "star--near", count: 18,  parallax: 0.048 },
  ];

  layers.forEach((layer) => {
    const layerEl = document.createElement("div");
    layerEl.className = "star-layer";
    layerEl.dataset.parallax = layer.parallax;
    for (let i = 0; i < layer.count; i++) {
      const star = document.createElement("div");
      star.className = "star " + layer.class;
      star.style.left = Math.random() * 100 + "%";
      star.style.top = Math.random() * 100 + "%";
      star.style.animationDelay = Math.random() * 8 + "s";
      layerEl.appendChild(star);
    }
    el.appendChild(layerEl);
  });

  // Cosmic substrate is on by default. Themes that set
  // `starfield: false` hide the whole stack (applyTheme handles it).
  if (displayConfig.starfield === false) el.style.display = "none";

  return el;
}

function createNebulae() {
  const frag = document.createDocumentFragment();
  const n1 = document.createElement("div");
  n1.className = "nebula nebula--1";
  const n2 = document.createElement("div");
  n2.className = "nebula nebula--2";
  const n3 = document.createElement("div");
  n3.className = "nebula nebula--3";

  if (displayConfig.nebulaColors && displayConfig.nebulaColors.length >= 2) {
    n1.style.background = `radial-gradient(circle, ${displayConfig.nebulaColors[0]}, transparent 70%)`;
    n2.style.background = `radial-gradient(circle, ${displayConfig.nebulaColors[1]}, transparent 70%)`;
  }

  if (displayConfig.starfield === false) {
    n1.style.display = "none";
    n2.style.display = "none";
    n3.style.display = "none";
  }

  frag.appendChild(n1);
  frag.appendChild(n2);
  frag.appendChild(n3);
  return frag;
}

// ── Parallax on pointer/gyro ──

function initParallax() {
  document.addEventListener("mousemove", (e) => {
    const cx = (e.clientX / window.innerWidth - 0.5) * 2;
    const cy = (e.clientY / window.innerHeight - 0.5) * 2;
    applyParallax(cx, cy);
  });

  if (window.DeviceOrientationEvent) {
    window.addEventListener("deviceorientation", (e) => {
      if (e.gamma === null) return;
      const cx = Math.max(-1, Math.min(1, e.gamma / 30));
      const cy = Math.max(-1, Math.min(1, (e.beta - 45) / 30));
      applyParallax(cx, cy);
    });
  }
}

function applyParallax(cx, cy) {
  const layers = document.querySelectorAll(".star-layer");
  layers.forEach((layer) => {
    const p = parseFloat(layer.dataset.parallax) || 0;
    const x = cx * p * 200;
    const y = cy * p * 200;
    layer.style.transform = `translate(${x}px, ${y}px)`;
  });
}

initParallax();

// Card tilt-to-pointer — 3D rotateX/Y based on pointer position within
// the card bounds. Clamped to ±3.2deg. Resets on mouseleave.
function bindCardTilt(card) {
  card.addEventListener("mousemove", (e) => {
    const r = card.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;   // -0.5..0.5
    const py = (e.clientY - r.top)  / r.height - 0.5;
    const rx = +(px * 6.4).toFixed(2);  // rotateY
    const ry = +(-py * 4.2).toFixed(2); // rotateX (inverted)
    card.style.setProperty("--rx", rx + "deg");
    card.style.setProperty("--ry", ry + "deg");
    card.classList.add("tilt");
  });
  card.addEventListener("mouseleave", () => {
    card.classList.remove("tilt");
    card.style.setProperty("--rx", "0deg");
    card.style.setProperty("--ry", "0deg");
  });
}

// ── Helpers ──

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr + "Z").getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + "h ago";
  const days = Math.floor(hrs / 24);
  return days + "d ago";
}

function parseMetadata(meta) {
  if (typeof meta === "string") {
    try { return JSON.parse(meta); } catch { return {}; }
  }
  return meta || {};
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function iconForMime(mime) {
  if (mime === "application/pdf") return "PDF";
  if (mime === "text/markdown") return "MD";
  if (mime === "text/html") return "HTML";
  if (mime && mime.startsWith("image/")) return "IMG";
  if (mime && mime.startsWith("video/")) return "VID";
  if (mime && mime.startsWith("audio/")) return "AUD";
  return "\u25C9";
}

function labelForMime(mime) {
  if (mime === "application/pdf") return "PDF";
  if (mime === "text/markdown") return "Markdown";
  if (mime === "text/html") return "HTML";
  if (mime === "image/svg+xml") return "SVG";
  if (mime && mime.startsWith("image/")) return "Image";
  if (mime && mime.startsWith("video/")) return "Video";
  if (mime && mime.startsWith("audio/")) return "Audio";
  if (mime && mime.startsWith("text/")) return "Text";
  return mime || "Artifact";
}

// ── Grid View ──

function renderGrid() {
  if (surfaceSSE) { surfaceSSE.close(); surfaceSSE = null; }
  currentSurfaceId = null;
  resumeTheme();

  // Custom renderer — agent controls entire grid view
  if (displayConfig.renderer) {
    const iframe = document.createElement("iframe");
    iframe.id = "renderer-frame";
    iframe.src = "/display/renderer/html?" + Date.now();
    iframe.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border:none;background:transparent;";
    app.innerHTML = "";
    app.appendChild(iframe);
    connectGlobalSSE();
    return;
  }

  const container = document.createElement("div");
  container.appendChild(createStarfield());
  container.appendChild(createNebulae());
  container.appendChild(createGrain());
  startCometShower();

  const gridView = document.createElement("div");
  gridView.className = "grid-view";
  if (surfaces.length > 0) gridView.classList.add("has-cards");

  const title = displayConfig.title || "Surface";
  const header = document.createElement("div");
  header.className = "grid-header";
  const exploreBtn = features.marketplace
    ? `<button class="explore-btn" onclick="navigate('/explore')">Explore</button>`
    : "";
  const count = surfaces.length;
  const countLabel = count === 0 ? "" : `${String(count).padStart(2, "0")} ${count === 1 ? "surface" : "surfaces"}`;
  header.innerHTML = `
    <div class="grid-title-block">
      <div class="grid-title">${escapeHtml(title)}</div>
      <div class="grid-subtitle">a universal display for your agents</div>
    </div>
    <div class="grid-meta" id="grid-meta">
      ${count > 0 ? `<span class="grid-meta-count">${escapeHtml(countLabel)}</span>` : ""}
      <span class="grid-meta-live">station</span>
    </div>
    ${exploreBtn}
  `;
  gridView.appendChild(header);

  // Home widget (full HTML/JS iframe on the homescreen)
  if (displayConfig.home) {
    const widget = document.createElement("iframe");
    widget.id = "home-widget";
    widget.className = "home-widget";
    widget.src = "/display/home/html";
    gridView.appendChild(widget);
    // Auto-size: listen for content height
    widget.onload = () => {
      try {
        const h = widget.contentDocument.documentElement.scrollHeight;
        widget.style.height = Math.max(h, 60) + "px";
      } catch { widget.style.height = "200px"; }
    };
  }

  // Sort surfaces by agent-defined order
  if (displayConfig.order && displayConfig.order.length > 0) {
    const orderMap = {};
    displayConfig.order.forEach((id, i) => { orderMap[id] = i; });
    surfaces.sort((a, b) => {
      const ai = orderMap[a.id] !== undefined ? orderMap[a.id] : Infinity;
      const bi = orderMap[b.id] !== undefined ? orderMap[b.id] : Infinity;
      if (ai !== bi) return ai - bi;
      return new Date(b.updated_at) - new Date(a.updated_at);
    });
  }

  if (surfaces.length === 0 && !displayConfig.home) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = `
      <div class="empty-text">
        <div class="empty-prompt">What should I make?</div>
        <div class="empty-suggestions">
          <span class="empty-suggestion-arrow">›</span><span class="empty-suggestion-text"></span>
        </div>
        <div class="empty-sub">tell your agent</div>
        <button type="button" class="empty-tour-btn" onclick="showTutorialModal()">Start Tutorial</button>
      </div>
      <button type="button" class="empty-portal" id="empty-portal" aria-label="Surface ideas — click to see a buildable prompt">
        <div class="portal-disc">
          <iframe class="portal-demo" tabindex="-1" sandbox="allow-scripts" srcdoc=""></iframe>
        </div>
        <div class="portal-meta">
          <div class="portal-label">A surface you could make</div>
          <div class="portal-title"></div>
          <div class="portal-sub"></div>
          <div class="portal-hint">click for the prompt</div>
        </div>
      </button>
    `;
    container.appendChild(empty);
    cycleEmptySuggestions(empty);
    cyclePortal(empty);
  } else {
    const grid = document.createElement("div");
    grid.className = "grid";
    grid.id = "surface-grid";

    surfaces.forEach((s, i) => {
      const card = createCard(s, i);
      grid.appendChild(card);
    });

    gridView.appendChild(grid);
  }

  container.appendChild(gridView);
  app.innerHTML = "";
  app.appendChild(container);

  // Re-apply theme to newly created elements
  applyTheme(displayConfig);

  connectGlobalSSE();
}

function createCard(s, index) {
  const meta = parseMetadata(s.metadata);
  const card = document.createElement("div");
  card.className = "surface-card";
  card.dataset.id = s.id;
  card.style.animationDelay = ((index || 0) * 0.08) + "s";
  // Stagger the ambient gleam so cards don't sweep in unison.
  card.style.setProperty("--gleam-delay", (-(Math.random() * 7.2)).toFixed(2) + "s");
  card.onclick = () => navigate("/surface/" + s.id);
  bindCardTilt(card);
  const gleam = document.createElement("div");
  gleam.className = "card-gleam";
  card.appendChild(gleam);

  // Preview thumbnail
  const preview = document.createElement("div");
  preview.className = "card-preview";
  const previewUrl = s.preview_url || (s.artifact ? `/artifacts/${s.artifact.id}/view?preview=1` : `/surfaces/${s.id}/html`);
  const mime = s.artifact_mime || (s.artifact && s.artifact.mime) || "";
  const shouldUseIframePreview =
    previewUrl &&
    !mime.startsWith("video/") &&
    !mime.startsWith("audio/") &&
    mime !== "application/pdf" &&
    s.artifact_kind !== "project";
  const hasExternalScripts = s.html && (s.html.includes('<script src') || s.html.includes('import('));
  if (shouldUseIframePreview) {
    const iframe = document.createElement("iframe");
    iframe.sandbox = "allow-scripts allow-same-origin";
    if (s.html && s.html.length < 8000 && !hasExternalScripts) {
      iframe.srcdoc = s.html;
    } else {
      iframe.src = previewUrl;
    }
    iframe.tabIndex = -1;
    iframe.loading = "lazy";
    preview.appendChild(iframe);
    const overlay = document.createElement("div");
    overlay.className = "card-preview-overlay";
    preview.appendChild(overlay);
  } else {
    const iconEl = document.createElement("div");
    iconEl.className = "card-preview-icon";
    iconEl.textContent = meta.icon || iconForMime(mime);
    preview.appendChild(iconEl);
  }

  // Live pip — surfaces touched in the last 60s wear an orange dot
  if (s.updated_at) {
    const ageMs = Date.now() - new Date(s.updated_at + "Z").getTime();
    if (ageMs < 60000) {
      const live = document.createElement("div");
      live.className = "card-live";
      live.textContent = "live";
      preview.appendChild(live);
    }
  }

  card.appendChild(preview);

  // Card body
  const body = document.createElement("div");
  body.className = "card-body";
  body.innerHTML = `
    <div class="card-body-top">
      ${meta.icon ? `<span class="card-icon">${meta.icon}</span>` : ""}
      <div class="card-title">${escapeHtml(s.title)}</div>
      ${mime ? `<div class="card-badge">${escapeHtml(labelForMime(mime))}</div>` : ""}
    </div>
    ${meta.description ? `<div class="card-description">${escapeHtml(meta.description)}</div>` : ""}
    <div class="card-time">${timeAgo(s.updated_at)}</div>
  `;
  card.appendChild(body);

  return card;
}

// ── Surface View ──

async function renderSurface(id) {
  if (globalSSE) { globalSSE.close(); globalSSE = null; }
  currentSurfaceId = id;
  resumeTheme();

  const res = await fetch("/surfaces/" + id);
  if (!res.ok) { navigate("/"); return; }
  const surface = await res.json();

  const view = document.createElement("div");
  view.className = "surface-view";

  const mime = surface.artifact_mime || (surface.artifact && surface.artifact.mime) || "";
  const mimeLabel = mime ? labelForMime(mime) : "";

  const nav = document.createElement("div");
  nav.className = "surface-nav";
  nav.innerHTML = `
    <button class="back-btn" onclick="location.hash='/'" aria-label="Back">←</button>
    <div class="surface-nav-titlewrap">
      <div class="surface-nav-title">${escapeHtml(surface.title)}</div>
      <div class="surface-nav-meta">
        ${mimeLabel ? `<span>${escapeHtml(mimeLabel)}</span>` : ""}
        ${mimeLabel ? `<span class="surface-nav-meta-dot"></span>` : ""}
        <span>${escapeHtml(timeAgo(surface.updated_at))}</span>
        <span class="surface-nav-meta-dot"></span>
        <span class="surface-nav-live">live</span>
      </div>
    </div>
  `;
  view.appendChild(nav);

  const iframe = document.createElement("iframe");
  iframe.className = "surface-frame";
  iframe.src = surface.view_url || (surface.artifact ? `/artifacts/${surface.artifact.id}/view` : `/surfaces/${surface.id}/html`);
  view.appendChild(iframe);

  app.innerHTML = "";
  app.appendChild(view);

  // SSE for live updates
  surfaceSSE = new EventSource("/surfaces/" + id + "/stream");
  surfaceSSE.addEventListener("surface_updated", (e) => {
    const data = JSON.parse(e.data);
    if (data.html || data.reload || data.version_id) {
      iframe.src = iframe.src.split("?")[0] + "?v=" + Date.now();
      // Visual cue: brief blur-fade on the iframe when the agent
      // re-renders. Couples SSE to motion.
      iframe.classList.remove("refreshing");
      void iframe.offsetWidth;
      iframe.classList.add("refreshing");
    }
    if (data.title) {
      const titleEl = view.querySelector(".surface-nav-title");
      if (titleEl) titleEl.textContent = data.title;
    }
    if (data.updated_at) {
      const metaEl = view.querySelector(".surface-nav-meta");
      if (metaEl) {
        const tsSpan = metaEl.querySelectorAll("span")[mimeLabel ? 2 : 0];
        if (tsSpan) tsSpan.textContent = timeAgo(data.updated_at);
      }
    }
  });
  surfaceSSE.addEventListener("agent_reply", (e) => {
    const data = JSON.parse(e.data);
    showToast(data.text);
  });
  surfaceSSE.addEventListener("surface_exec", (e) => {
    const data = JSON.parse(e.data);
    if (iframe.contentWindow && data.js) {
      try {
        iframe.contentWindow.eval(data.js);
      } catch (err) {
        console.error("[surface_exec]", err);
      }
    }
  });
}

// ── Global SSE ──

function connectGlobalSSE() {
  if (globalSSE) globalSSE.close();
  globalSSE = new EventSource("/stream");

  // Connection state → "STATION" indicator in the grid header.
  const setOnline = (on) => {
    const meta = document.getElementById("grid-meta");
    if (meta) meta.classList.toggle("online", on);
  };
  globalSSE.addEventListener("open", () => setOnline(true));
  globalSSE.onopen = () => setOnline(true);
  globalSSE.onerror = () => setOnline(false);
  // EventSource is open as soon as it's instantiated and the
  // browser has the connection — set online optimistically.
  setTimeout(() => {
    if (globalSSE && globalSSE.readyState === 1) setOnline(true);
  }, 200);

  globalSSE.addEventListener("surface_created", (e) => {
    const data = JSON.parse(e.data);
    pulseSpace({ comet: true });
    fetch("/surfaces/" + data.id).then(r => r.json()).then(full => {
      surfaces.unshift(full);
      const grid = document.getElementById("surface-grid");
      if (grid) {
        const card = createCard(full, 0);
        grid.prepend(card);
        const empty = document.querySelector(".empty-state");
        if (empty) {
          if (emptySuggestionT) { clearInterval(emptySuggestionT); emptySuggestionT = null; }
          empty.remove();
        }
        // First card → enable the rail.
        const gv = document.querySelector(".grid-view");
        if (gv) gv.classList.add("has-cards");
        // Update the count meta in the header.
        updateGridMeta();
      } else {
        render();
      }
    });
  });

  globalSSE.addEventListener("surface_updated", (e) => {
    const data = JSON.parse(e.data);
    pulseSpace();
    const idx = surfaces.findIndex((s) => s.id === data.id);
    if (idx !== -1) {
      surfaces[idx] = { ...surfaces[idx], ...data };
      const card = document.querySelector(`.surface-card[data-id="${data.id}"]`);
      if (card) {
        const titleEl = card.querySelector(".card-title");
        if (titleEl) titleEl.textContent = data.title || surfaces[idx].title;
        const timeEl = card.querySelector(".card-time");
        if (timeEl) timeEl.textContent = timeAgo(data.updated_at);
        // Add (or refresh) the live pip
        let live = card.querySelector(".card-live");
        if (!live) {
          live = document.createElement("div");
          live.className = "card-live";
          live.textContent = "live";
          const preview = card.querySelector(".card-preview");
          if (preview) preview.appendChild(live);
        }
        // Remove the pip after 60s so it stays meaningful.
        setTimeout(() => {
          const stillThere = card.querySelector(".card-live");
          if (stillThere) stillThere.remove();
        }, 60000);
      }
    }
  });

  globalSSE.addEventListener("surface_deleted", (e) => {
    const data = JSON.parse(e.data);
    pulseSpace();
    surfaces = surfaces.filter((s) => s.id !== data.id);
    const card = document.querySelector(`.surface-card[data-id="${data.id}"]`);
    if (card) {
      card.classList.add("removing");
      card.addEventListener("animationend", () => {
        card.remove();
        if (surfaces.length === 0) {
          render();
        } else {
          updateGridMeta();
        }
      });
    }
  });

  // ── Display commands from agent ──

  globalSSE.addEventListener("display_navigate", (e) => {
    const data = JSON.parse(e.data);
    if (data.surface_id) {
      navigate("/surface/" + data.surface_id);
    } else {
      navigate("/");
    }
  });

  globalSSE.addEventListener("display_notify", (e) => {
    const data = JSON.parse(e.data);
    showToast(data.text, data.duration || 5000, data.style || "info");
    pulseSpace();
  });

  globalSSE.addEventListener("display_theme", (e) => {
    const prev = displayConfig.renderer;
    const data = JSON.parse(e.data);
    applyTheme(data);
    pulseSpace();
    // Re-render if renderer was added/removed/changed
    if ((prev || "") !== (data.renderer || "")) render();
  });
}

// Update the surface-count badge in the grid header without
// re-rendering the whole grid (used after SSE create/delete).
function updateGridMeta() {
  const header = document.querySelector(".grid-header");
  if (!header) return;
  let metaEl = header.querySelector(".grid-meta");
  const n = surfaces.length;
  const label = n === 0 ? "" : `${String(n).padStart(2, "0")} ${n === 1 ? "surface" : "surfaces"}`;
  if (n === 0) {
    if (metaEl) metaEl.remove();
    return;
  }
  if (!metaEl) {
    metaEl = document.createElement("div");
    metaEl.className = "grid-meta";
    const exploreBtn = header.querySelector(".explore-btn");
    if (exploreBtn) header.insertBefore(metaEl, exploreBtn);
    else header.appendChild(metaEl);
  }
  metaEl.textContent = label;
}

// ── Explore View (Marketplace) ──

async function renderExplore() {
  if (surfaceSSE) { surfaceSSE.close(); surfaceSSE = null; }
  if (globalSSE) { globalSSE.close(); globalSSE = null; }
  currentSurfaceId = null;
  suspendTheme();

  const container = document.createElement("div");
  container.appendChild(createStarfield());
  container.appendChild(createNebulae());
  container.appendChild(createGrain());

  const view = document.createElement("div");
  view.className = "explore-view";

  // Header
  const header = document.createElement("div");
  header.className = "explore-header";
  header.innerHTML = `
    <button class="back-btn" onclick="navigate('/')" aria-label="Back">←</button>
    <div class="grid-title-block" style="flex:1">
      <div class="grid-title">Explore</div>
      <div class="grid-subtitle">themes, renderers, surfaces</div>
    </div>
  `;
  view.appendChild(header);

  // Category pills
  const cats = document.createElement("div");
  cats.className = "explore-cats";
  const categories = [
    { label: "All", filter: "" },
    { label: "Surfaces", filter: "type=surface" },
    { label: "Themes", filter: "type=theme" },
    { label: "Renderers", filter: "type=renderer" },
    { label: "Overlays", filter: "type=overlay" },
  ];
  categories.forEach((c, i) => {
    const pill = document.createElement("button");
    pill.className = "explore-pill" + (i === 0 ? " active" : "");
    pill.textContent = c.label;
    pill.onclick = () => {
      cats.querySelectorAll(".explore-pill").forEach(p => p.classList.remove("active"));
      pill.classList.add("active");
      loadMarketplace(c.filter, view.querySelector(".explore-grid"));
    };
    cats.appendChild(pill);
  });
  view.appendChild(cats);

  // Grid
  const grid = document.createElement("div");
  grid.className = "explore-grid";
  view.appendChild(grid);

  container.appendChild(view);
  app.innerHTML = "";
  app.appendChild(container);

  applyTheme(displayConfig);
  await loadMarketplace("", grid);
}

async function loadMarketplace(filter, grid) {
  grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--text-ghost);padding:40px;font-size:13px;letter-spacing:2px">Loading...</div>';
  const res = await fetch("/marketplace" + (filter ? "?" + filter : ""));
  const items = await res.json();
  grid.innerHTML = "";

  if (items.length === 0) {
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--text-ghost);padding:40px">Nothing here yet</div>';
    return;
  }

  items.forEach((item, i) => {
    const card = document.createElement("div");
    card.className = "explore-card";
    card.style.animationDelay = (i * 0.06) + "s";
    bindCardTilt(card);

    // Preview
    const preview = document.createElement("div");
    preview.className = "card-preview";
    if (item.type === "surface") {
      const iframe = document.createElement("iframe");
      iframe.sandbox = "allow-scripts";
      iframe.src = "/marketplace/" + item.id + "/preview";
      iframe.tabIndex = -1;
      iframe.loading = "lazy";
      preview.appendChild(iframe);
      const overlay = document.createElement("div");
      overlay.className = "card-preview-overlay";
      preview.appendChild(overlay);
    } else {
      const iconEl = document.createElement("div");
      iconEl.className = "card-preview-icon";
      iconEl.textContent = item.icon || "\u25C9";
      preview.appendChild(iconEl);
    }
    card.appendChild(preview);

    // Body
    const body = document.createElement("div");
    body.className = "card-body";

    const typeBadge = {surface:"",theme:"Theme",renderer:"Renderer",overlay:"Overlay"}[item.type] || "";

    body.innerHTML = `
      ${item.icon ? '<span class="card-icon">' + item.icon + '</span>' : ''}
      <div class="card-title">${escapeHtml(item.title)}</div>
      <div class="card-description">${escapeHtml(item.description)}</div>
      ${typeBadge ? '<div class="explore-badge">' + typeBadge + '</div>' : ''}
    `;

    const installBtn = document.createElement("button");
    installBtn.className = "install-btn";
    installBtn.textContent = item.type === "theme" ? "Apply" : item.type === "renderer" ? "Apply" : item.type === "overlay" ? "Apply" : "Install";
    installBtn.onclick = async (e) => {
      e.stopPropagation();
      installBtn.disabled = true;
      installBtn.textContent = "...";
      const res = await fetch("/marketplace/" + item.id + "/install", { method: "POST" });
      const data = await res.json();
      if (data.action === "exists") {
        installBtn.textContent = "Installed";
        installBtn.classList.add("installed");
      } else if (data.action === "installed") {
        installBtn.textContent = "Installed ✓";
        installBtn.classList.add("installed");
      } else if (data.action === "applied") {
        installBtn.textContent = "Applied ✓";
        installBtn.classList.add("installed");
        // Refresh config for themes/renderers
        const cfg = await fetch("/display/config").then(r => r.json());
        applyTheme(cfg);
        if (data.type === "renderer") {
          setTimeout(() => navigate("/"), 500);
        }
      }
    };
    body.appendChild(installBtn);
    card.appendChild(body);
    grid.appendChild(card);
  });
}

// ── Main Render ──

async function render() {
  const route = getRoute();
  if (route.view === "surface") {
    await renderSurface(route.id);
  } else if (route.view === "explore" && features.marketplace) {
    await renderExplore();
  } else if (route.view === "explore") {
    navigate("/");
    return;
  } else {
    const res = await fetch("/surfaces");
    surfaces = await res.json();
    const full = await Promise.all(
      surfaces.map((s) => fetch("/surfaces/" + s.id).then((r) => r.json()))
    );
    surfaces = full;
    renderGrid();
  }
  reportPresence();
}

// ── Init ──

Promise.all([
  fetch("/display/config").then((r) => r.json()).catch(() => ({})),
  fetch("/display/features").then((r) => r.json()).catch(() => ({ marketplace: false })),
])
  .then(([config, feats]) => {
    features = { marketplace: false, ...feats };
    applyTheme(config);
    return render();
  })
  .catch(() => render());

window.addEventListener("resize", () => reportPresence());
