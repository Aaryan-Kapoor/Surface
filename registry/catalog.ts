export interface MarketplaceItem {
  id: string;
  type: "surface" | "theme" | "renderer" | "overlay";
  title: string;
  description: string;
  icon: string;
  author: string;
  tags: string[];
  category: string;
  // Which surface kind this item installs. Defaults to 'html' so existing
  // entries keep working without changes.
  kind?: "html" | "widgets";
  html?: string;
  spec?: Record<string, any>;
  theme?: Record<string, any>;
  renderer?: string;
  overlay?: string;
}

export const catalog: MarketplaceItem[] = [

  // ═══════════════════════════════════════
  // SURFACES
  // ═══════════════════════════════════════

  {
    id: "mp-pomodoro",
    type: "surface",
    title: "Pomodoro Timer",
    description: "25/5 focus timer with animated ring and session counter",
    icon: "🍅",
    author: "Surface Team",
    tags: ["productivity", "timer", "focus"],
    category: "productivity",
    html: `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a0a;color:#fff;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:24px}
.ring{width:240px;height:240px;position:relative}
svg{transform:rotate(-90deg);width:100%;height:100%}
circle{fill:none;stroke-width:6}
.bg{stroke:#1a1a2e}
.progress{stroke:#ff6b6b;stroke-linecap:round;transition:stroke-dashoffset 1s linear,stroke 0.3s}
.time{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:48px;font-weight:200;letter-spacing:2px}
.label{font-size:13px;color:#666;letter-spacing:4px;text-transform:uppercase}
.controls{display:flex;gap:12px}
button{background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);color:#fff;padding:10px 24px;border-radius:10px;font-size:14px;cursor:pointer;transition:all 0.2s}
button:hover{background:rgba(255,255,255,0.12)}
button.active{background:#ff6b6b;border-color:#ff6b6b}
.sessions{font-size:12px;color:#444;letter-spacing:2px}
</style></head><body>
<div class="label" id="label">FOCUS</div>
<div class="ring"><svg viewBox="0 0 100 100"><circle class="bg" cx="50" cy="50" r="45"/><circle class="progress" id="prog" cx="50" cy="50" r="45" stroke-dasharray="283" stroke-dashoffset="0"/></svg><div class="time" id="time">25:00</div></div>
<div class="controls"><button id="btn" onclick="toggle()">Start</button><button onclick="reset()">Reset</button></div>
<div class="sessions" id="sess">0 sessions</div>
<script>
let dur=25*60,left=dur,run=false,iv,mode='work',sessions=0;
const C=283,prog=document.getElementById('prog'),time=document.getElementById('time'),btn=document.getElementById('btn'),label=document.getElementById('label'),sess=document.getElementById('sess');
function fmt(s){return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0')}
function tick(){if(--left<=0){if(mode==='work'){sessions++;sess.textContent=sessions+' sessions';mode='break';dur=5*60;label.textContent='BREAK';prog.style.stroke='#51cf66'}else{mode='work';dur=25*60;label.textContent='FOCUS';prog.style.stroke='#ff6b6b'}left=dur}time.textContent=fmt(left);prog.setAttribute('stroke-dashoffset',C*(1-left/dur))}
function toggle(){run=!run;btn.textContent=run?'Pause':'Start';btn.classList.toggle('active',run);if(run)iv=setInterval(tick,1000);else clearInterval(iv)}
function reset(){run=false;clearInterval(iv);mode='work';dur=25*60;left=dur;time.textContent=fmt(left);prog.setAttribute('stroke-dashoffset','0');prog.style.stroke='#ff6b6b';btn.textContent='Start';btn.classList.remove('active');label.textContent='FOCUS'}
</script></body></html>`,
  },

  {
    id: "mp-clock",
    type: "surface",
    title: "Analog Clock",
    description: "Elegant analog clock with smooth second hand",
    icon: "🕐",
    author: "Surface Team",
    tags: ["utility", "clock", "time"],
    category: "utility",
    html: `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{margin:0;box-sizing:border-box}
body{background:#0a0a0a;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:20px;font-family:system-ui,sans-serif}
.clock{width:260px;height:260px;border-radius:50%;border:2px solid rgba(255,255,255,0.08);position:relative;background:rgba(255,255,255,0.02)}
.dot{position:absolute;width:8px;height:8px;background:#fff;border-radius:50%;top:50%;left:50%;transform:translate(-50%,-50%);z-index:10}
.hand{position:absolute;bottom:50%;left:50%;transform-origin:bottom center;border-radius:2px}
.hour{width:4px;height:60px;background:#fff;margin-left:-2px}
.minute{width:3px;height:85px;background:rgba(255,255,255,0.7);margin-left:-1.5px}
.second{width:1px;height:95px;background:#ff6b6b;margin-left:-0.5px}
.mark{position:absolute;width:2px;height:10px;background:rgba(255,255,255,0.15);top:8px;left:50%;margin-left:-1px;transform-origin:center 122px}
.mark.major{height:16px;background:rgba(255,255,255,0.4);width:2px}
.digital{color:rgba(255,255,255,0.3);font-size:14px;letter-spacing:4px;font-weight:300}
</style></head><body>
<div class="clock" id="clock"><div class="dot"></div><div class="hand hour" id="h"></div><div class="hand minute" id="m"></div><div class="hand second" id="s"></div></div>
<div class="digital" id="dig"></div>
<script>
const clock=document.getElementById('clock');
for(let i=0;i<60;i++){const m=document.createElement('div');m.className='mark'+(i%5===0?' major':'');m.style.transform='rotate('+i*6+'deg)';clock.appendChild(m)}
function update(){const now=new Date(),h=now.getHours()%12,m=now.getMinutes(),s=now.getSeconds(),ms=now.getMilliseconds();
document.getElementById('h').style.transform='rotate('+(h*30+m*0.5)+'deg)';
document.getElementById('m').style.transform='rotate('+(m*6+s*0.1)+'deg)';
document.getElementById('s').style.transform='rotate('+((s+ms/1000)*6)+'deg)';
document.getElementById('dig').textContent=now.toLocaleTimeString('en-US',{hour12:true});requestAnimationFrame(update)}
update();
</script></body></html>`,
  },

  {
    id: "mp-calculator",
    type: "surface",
    title: "Calculator",
    description: "Clean calculator with keyboard support",
    icon: "🧮",
    author: "Surface Team",
    tags: ["utility", "math", "calculator"],
    category: "utility",
    html: `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{margin:0;box-sizing:border-box}
body{background:#0a0a0a;display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui,sans-serif}
.calc{width:280px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:20px;overflow:hidden;padding:20px}
.display{text-align:right;padding:16px 8px;margin-bottom:12px}
.expr{font-size:14px;color:rgba(255,255,255,0.3);height:20px}
.value{font-size:40px;color:#fff;font-weight:200}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.btn{background:rgba(255,255,255,0.06);border:none;color:#fff;font-size:20px;padding:18px;border-radius:12px;cursor:pointer;transition:all 0.15s;font-family:inherit}
.btn:hover{background:rgba(255,255,255,0.12)}
.btn:active{transform:scale(0.95)}
.btn.op{background:rgba(255,107,107,0.15);color:#ff6b6b}
.btn.op:hover{background:rgba(255,107,107,0.25)}
.btn.eq{background:#ff6b6b;color:#fff}
.btn.eq:hover{background:#ff5252}
.btn.fn{color:rgba(255,255,255,0.4)}
</style></head><body>
<div class="calc"><div class="display"><div class="expr" id="expr"></div><div class="value" id="val">0</div></div>
<div class="grid">
<button class="btn fn" onclick="clear_()">AC</button><button class="btn fn" onclick="neg()">±</button><button class="btn fn" onclick="pct()">%</button><button class="btn op" onclick="op('/')">÷</button>
<button class="btn" onclick="num('7')">7</button><button class="btn" onclick="num('8')">8</button><button class="btn" onclick="num('9')">9</button><button class="btn op" onclick="op('*')">×</button>
<button class="btn" onclick="num('4')">4</button><button class="btn" onclick="num('5')">5</button><button class="btn" onclick="num('6')">6</button><button class="btn op" onclick="op('-')">−</button>
<button class="btn" onclick="num('1')">1</button><button class="btn" onclick="num('2')">2</button><button class="btn" onclick="num('3')">3</button><button class="btn op" onclick="op('+')">+</button>
<button class="btn" style="grid-column:span 2" onclick="num('0')">0</button><button class="btn" onclick="dot()">.</button><button class="btn eq" onclick="eq()">=</button>
</div></div>
<script>
let cur='0',prev='',oper='',fresh=true;const v=document.getElementById('val'),e=document.getElementById('expr');
function show(){v.textContent=cur.length>10?parseFloat(cur).toPrecision(8):cur}
function num(n){if(fresh){cur='';fresh=false}cur=cur==='0'?n:cur+n;show()}
function dot(){if(fresh){cur='0';fresh=false}if(!cur.includes('.'))cur+='.';show()}
function op(o){if(prev&&!fresh){eq()}prev=cur;oper=o;fresh=true;e.textContent=prev+' '+{'/':'÷','*':'×','-':'−','+':'+'}[o]}
function eq(){if(!oper||!prev)return;const r=eval(prev+oper+cur);cur=String(Math.round(r*1e10)/1e10);prev='';oper='';fresh=true;e.textContent='';show()}
function clear_(){cur='0';prev='';oper='';fresh=true;e.textContent='';show()}
function neg(){cur=String(-parseFloat(cur));show()}
function pct(){cur=String(parseFloat(cur)/100);show()}
document.addEventListener('keydown',e=>{if(e.key>='0'&&e.key<='9')num(e.key);else if(e.key==='.')dot();else if('+-*/'.includes(e.key))op(e.key);else if(e.key==='Enter'||e.key==='=')eq();else if(e.key==='Escape')clear_()});
</script></body></html>`,
  },

  {
    id: "mp-breathe",
    type: "surface",
    title: "Breathing Guide",
    description: "Guided 4-7-8 breathing exercise with calming animation",
    icon: "🫧",
    author: "Surface Team",
    tags: ["wellness", "breathing", "meditation"],
    category: "wellness",
    html: `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{margin:0;box-sizing:border-box}
body{background:#0a0a0a;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:32px;font-family:system-ui,sans-serif;overflow:hidden}
.circle{width:200px;height:200px;border-radius:50%;background:radial-gradient(circle,rgba(81,207,102,0.2),rgba(81,207,102,0.05));border:2px solid rgba(81,207,102,0.2);transition:all 0.5s ease;display:flex;align-items:center;justify-content:center}
.circle.expand{width:280px;height:280px;background:radial-gradient(circle,rgba(81,207,102,0.3),rgba(81,207,102,0.08));border-color:rgba(81,207,102,0.4)}
.circle.hold{border-color:rgba(81,207,102,0.6);box-shadow:0 0 40px rgba(81,207,102,0.1)}
.count{font-size:48px;font-weight:200;color:rgba(81,207,102,0.8)}
.phase{font-size:14px;color:rgba(255,255,255,0.3);letter-spacing:6px;text-transform:uppercase}
.info{font-size:11px;color:rgba(255,255,255,0.15);letter-spacing:2px}
button{background:rgba(81,207,102,0.1);border:1px solid rgba(81,207,102,0.2);color:rgba(81,207,102,0.8);padding:10px 28px;border-radius:10px;font-size:14px;cursor:pointer;font-family:inherit;letter-spacing:1px}
button:hover{background:rgba(81,207,102,0.2)}
</style></head><body>
<div class="phase" id="phase">4-7-8 BREATHING</div>
<div class="circle" id="circle"><span class="count" id="count"></span></div>
<button id="btn" onclick="startStop()">Begin</button>
<div class="info">Inhale 4s · Hold 7s · Exhale 8s</div>
<script>
const steps=[{label:'INHALE',dur:4,cls:'expand'},{label:'HOLD',dur:7,cls:'expand hold'},{label:'EXHALE',dur:8,cls:''}];
let running=false,iv,step=0,tick=0;
const circle=document.getElementById('circle'),phase=document.getElementById('phase'),count=document.getElementById('count'),btn=document.getElementById('btn');
function run(){const s=steps[step];tick--;count.textContent=tick;if(tick<=0){step=(step+1)%3;tick=steps[step].dur;circle.className='circle '+steps[step].cls;phase.textContent=steps[step].label;count.textContent=tick}}
function startStop(){if(running){running=false;clearInterval(iv);btn.textContent='Begin';phase.textContent='4-7-8 BREATHING';count.textContent='';circle.className='circle'}else{running=true;btn.textContent='Stop';step=0;tick=steps[0].dur;circle.className='circle '+steps[0].cls;phase.textContent=steps[0].label;count.textContent=tick;iv=setInterval(run,1000)}}
</script></body></html>`,
  },

  {
    id: "mp-piano",
    type: "surface",
    title: "Mini Piano",
    description: "Playable one-octave piano with Web Audio",
    icon: "🎹",
    author: "Surface Team",
    tags: ["music", "instrument", "fun"],
    category: "entertainment",
    html: `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{margin:0;box-sizing:border-box}
body{background:#0a0a0a;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:24px;font-family:system-ui,sans-serif}
h2{color:rgba(255,255,255,0.15);font-weight:300;font-size:13px;letter-spacing:6px;text-transform:uppercase}
.piano{display:flex;position:relative;height:200px}
.white{width:48px;height:200px;background:linear-gradient(180deg,#e8e8e8,#fff);border:1px solid rgba(0,0,0,0.1);border-radius:0 0 6px 6px;cursor:pointer;position:relative;z-index:1;transition:background 0.1s}
.white:active,.white.pressed{background:linear-gradient(180deg,#d0d0d0,#e8e8e8)}
.black{width:30px;height:120px;background:linear-gradient(180deg,#222,#333);border-radius:0 0 4px 4px;cursor:pointer;position:absolute;z-index:2;margin-left:-15px;transition:background 0.1s}
.black:active,.black.pressed{background:linear-gradient(180deg,#444,#555)}
.hint{font-size:10px;color:rgba(255,255,255,0.2);letter-spacing:1px}
</style></head><body>
<h2>Mini Piano</h2>
<div class="piano" id="piano"></div>
<div class="hint">Click or press A S D F G H J K</div>
<script>
const ctx=new(window.AudioContext||window.webkitAudioContext)();
const notes=[261.63,277.18,293.66,311.13,329.63,349.23,369.99,392.00,415.30,440.00,466.16,493.88,523.25];
const whites=[0,2,4,5,7,9,11,12],blacks=[1,3,null,6,8,10];
const keys='asdfghjk';
const piano=document.getElementById('piano');
function play(freq,el){ctx.resume();const o=ctx.createOscillator(),g=ctx.createGain();o.type='sine';o.frequency.value=freq;g.gain.value=0.3;o.connect(g);g.connect(ctx.destination);o.start();g.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+1.5);o.stop(ctx.currentTime+1.5);if(el){el.classList.add('pressed');setTimeout(()=>el.classList.remove('pressed'),150)}}
whites.forEach((n,i)=>{const k=document.createElement('div');k.className='white';k.onmousedown=()=>play(notes[n],k);piano.appendChild(k)});
const blackPos=[1,2,null,4,5,6];
blackPos.forEach((pos,i)=>{if(pos===null)return;const k=document.createElement('div');k.className='black';k.style.left=(pos*48)+'px';k.onmousedown=()=>play(notes[blacks[i]],k);piano.appendChild(k)});
document.addEventListener('keydown',e=>{const i=keys.indexOf(e.key);if(i>=0&&i<whites.length){play(notes[whites[i]],piano.querySelectorAll('.white')[i])}});
</script></body></html>`,
  },

  {
    id: "mp-palette",
    type: "surface",
    title: "Color Palette",
    description: "Generate beautiful random color palettes with one click",
    icon: "🎨",
    author: "Surface Team",
    tags: ["design", "color", "creative"],
    category: "creative",
    html: `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{margin:0;box-sizing:border-box}
body{background:#0a0a0a;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:24px;font-family:system-ui,sans-serif}
h2{color:rgba(255,255,255,0.15);font-weight:300;font-size:13px;letter-spacing:6px;text-transform:uppercase}
.palette{display:flex;gap:8px;padding:8px;background:rgba(255,255,255,0.03);border-radius:16px;border:1px solid rgba(255,255,255,0.06)}
.swatch{width:80px;height:140px;border-radius:10px;cursor:pointer;display:flex;align-items:flex-end;justify-content:center;padding-bottom:10px;transition:transform 0.2s}
.swatch:hover{transform:scale(1.05)}
.hex{font-size:11px;color:rgba(0,0,0,0.5);font-weight:600;background:rgba(255,255,255,0.7);padding:2px 6px;border-radius:4px}
button{background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);color:#fff;padding:10px 24px;border-radius:10px;font-size:14px;cursor:pointer;font-family:inherit;letter-spacing:1px}
button:hover{background:rgba(255,255,255,0.12)}
.toast{position:fixed;bottom:20px;background:rgba(255,255,255,0.1);color:#fff;padding:8px 16px;border-radius:8px;font-size:12px;opacity:0;transition:opacity 0.3s}
.hint{font-size:11px;color:rgba(255,255,255,0.15);letter-spacing:1px}
</style></head><body>
<h2>Color Palette</h2>
<div class="palette" id="pal"></div>
<button onclick="gen()">Generate ⟳</button>
<div class="hint">Click a swatch to copy hex</div>
<div class="toast" id="toast">Copied!</div>
<script>
function hsl(h,s,l){return'hsl('+h+','+s+'%,'+l+'%)'};
function hslToHex(h,s,l){s/=100;l/=100;const a=s*Math.min(l,1-l);const f=n=>{const k=(n+h/30)%12;const c=l-a*Math.max(Math.min(k-3,9-k,1),-1);return Math.round(255*c).toString(16).padStart(2,'0')};return'#'+f(0)+f(8)+f(4)}
function gen(){const pal=document.getElementById('pal');pal.innerHTML='';const base=Math.random()*360;
for(let i=0;i<5;i++){const h=(base+i*30+Math.random()*20-10)%360;const s=50+Math.random()*30;const l=40+Math.random()*30;
const hex=hslToHex(h,s,l);const d=document.createElement('div');d.className='swatch';d.style.background=hex;
d.innerHTML='<span class="hex">'+hex.toUpperCase()+'</span>';
d.onclick=()=>{navigator.clipboard.writeText(hex);const t=document.getElementById('toast');t.style.opacity='1';setTimeout(()=>t.style.opacity='0',1500)};
pal.appendChild(d)}}
gen();document.addEventListener('keydown',e=>{if(e.code==='Space'){e.preventDefault();gen()}});
</script></body></html>`,
  },

  {
    id: "mp-habits",
    type: "surface",
    title: "Habit Tracker",
    description: "Track daily habits with a 7-day grid",
    icon: "✅",
    author: "Surface Team",
    tags: ["productivity", "habits", "tracking"],
    category: "productivity",
    html: `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{margin:0;box-sizing:border-box}
body{background:#0a0a0a;color:#fff;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh}
.tracker{width:340px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:20px;padding:24px}
h2{font-size:13px;font-weight:300;letter-spacing:6px;text-transform:uppercase;color:rgba(255,255,255,0.15);text-align:center;margin-bottom:20px}
.days{display:grid;grid-template-columns:100px repeat(7,1fr);gap:4px;margin-bottom:4px}
.day-label{font-size:10px;color:rgba(255,255,255,0.25);text-align:center;padding:4px}
.habit-name{font-size:13px;color:rgba(255,255,255,0.5);padding:8px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cell{width:100%;aspect-ratio:1;border-radius:6px;background:rgba(255,255,255,0.04);cursor:pointer;border:1px solid rgba(255,255,255,0.06);transition:all 0.15s;display:flex;align-items:center;justify-content:center}
.cell:hover{background:rgba(255,255,255,0.08)}
.cell.done{background:rgba(81,207,102,0.2);border-color:rgba(81,207,102,0.3)}
.cell.done::after{content:'✓';color:rgba(81,207,102,0.8);font-size:12px}
.streak{text-align:center;margin-top:16px;font-size:11px;color:rgba(255,255,255,0.2);letter-spacing:2px}
</style></head><body>
<div class="tracker">
<h2>Habit Tracker</h2>
<div class="days" id="grid"></div>
<div class="streak" id="streak"></div>
</div>
<script>
const habits=['Exercise','Read 30min','Meditate','Drink Water','No Phone'];
const dayNames=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const KEY='surface-habits';
let data=JSON.parse(localStorage.getItem(KEY)||'{}');
const grid=document.getElementById('grid');
grid.innerHTML='<div></div>'+dayNames.map(d=>'<div class="day-label">'+d+'</div>').join('');
habits.forEach(h=>{grid.innerHTML+='<div class="habit-name">'+h+'</div>';
dayNames.forEach((_,di)=>{const k=h+'-'+di;const done=data[k];
grid.innerHTML+='<div class="cell'+(done?' done':'')+'" data-key="'+k+'"></div>'})});
grid.addEventListener('click',e=>{const c=e.target;if(!c.classList.contains('cell'))return;const k=c.dataset.key;
data[k]=!data[k];c.classList.toggle('done');localStorage.setItem(KEY,JSON.stringify(data));updateStreak()});
function updateStreak(){let total=Object.values(data).filter(Boolean).length;
document.getElementById('streak').textContent=total+' / '+(habits.length*7)+' this week'}
updateStreak();
</script></body></html>`,
  },

  {
    id: "mp-notes",
    type: "surface",
    title: "Quick Notes",
    description: "Minimal note-taking with local save",
    icon: "📝",
    author: "Surface Team",
    tags: ["productivity", "notes", "text"],
    category: "productivity",
    html: `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{margin:0;box-sizing:border-box}
body{background:#0a0a0a;color:#fff;font-family:system-ui,sans-serif;height:100vh;display:flex;flex-direction:column}
.bar{padding:12px 20px;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;justify-content:space-between}
.title{font-size:13px;color:rgba(255,255,255,0.15);letter-spacing:6px;text-transform:uppercase;font-weight:300}
.saved{font-size:11px;color:rgba(81,207,102,0.5);opacity:0;transition:opacity 0.3s}
textarea{flex:1;background:transparent;border:none;color:rgba(255,255,255,0.8);font-family:'SF Mono',Consolas,monospace;font-size:14px;line-height:1.8;padding:20px;resize:none;outline:none}
textarea::placeholder{color:rgba(255,255,255,0.1)}
.count{padding:8px 20px;font-size:11px;color:rgba(255,255,255,0.1);text-align:right;border-top:1px solid rgba(255,255,255,0.04)}
</style></head><body>
<div class="bar"><span class="title">Notes</span><span class="saved" id="saved">Saved</span></div>
<textarea id="editor" placeholder="Start typing..."></textarea>
<div class="count" id="count">0 words</div>
<script>
const editor=document.getElementById('editor'),saved=document.getElementById('saved'),count=document.getElementById('count');
editor.value=localStorage.getItem('surface-notes')||'';
updateCount();
let timeout;
editor.addEventListener('input',()=>{clearTimeout(timeout);timeout=setTimeout(()=>{localStorage.setItem('surface-notes',editor.value);saved.style.opacity='1';setTimeout(()=>saved.style.opacity='0',1500)},500);updateCount()});
function updateCount(){const w=editor.value.trim()?editor.value.trim().split(/\\s+/).length:0;count.textContent=w+' word'+(w!==1?'s':'')}
</script></body></html>`,
  },

  {
    id: "mp-weather",
    type: "surface",
    title: "Weather Station",
    description: "Beautiful weather display with animated conditions",
    icon: "🌤",
    author: "Surface Team",
    tags: ["dashboard", "weather", "info"],
    category: "dashboard",
    html: `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{margin:0;box-sizing:border-box}
body{background:linear-gradient(135deg,#0a1628,#0d0d2b);color:#fff;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh}
.card{text-align:center;padding:40px}
.temp{font-size:80px;font-weight:100;line-height:1}
.icon{font-size:64px;margin:16px 0}
.desc{font-size:16px;color:rgba(255,255,255,0.5);margin-bottom:24px;letter-spacing:2px}
.details{display:flex;gap:32px;justify-content:center}
.detail{text-align:center}
.detail-val{font-size:20px;font-weight:300}
.detail-label{font-size:11px;color:rgba(255,255,255,0.25);letter-spacing:2px;text-transform:uppercase;margin-top:4px}
.loc{font-size:12px;color:rgba(255,255,255,0.15);margin-top:24px;letter-spacing:4px;text-transform:uppercase}
.particles{position:fixed;inset:0;pointer-events:none;overflow:hidden}
.p{position:absolute;width:2px;height:2px;background:rgba(255,255,255,0.1);border-radius:50%;animation:fall linear infinite}
@keyframes fall{to{transform:translateY(100vh)}}
</style></head><body>
<div class="particles" id="particles"></div>
<div class="card">
<div class="icon">☀️</div>
<div class="temp">72°</div>
<div class="desc">Clear Sky</div>
<div class="details">
<div class="detail"><div class="detail-val">62%</div><div class="detail-label">Humidity</div></div>
<div class="detail"><div class="detail-val">8 mph</div><div class="detail-label">Wind</div></div>
<div class="detail"><div class="detail-val">10mi</div><div class="detail-label">Visibility</div></div>
</div>
<div class="loc">San Francisco, CA</div>
</div>
<script>
const p=document.getElementById('particles');for(let i=0;i<30;i++){const d=document.createElement('div');d.className='p';d.style.left=Math.random()*100+'%';d.style.top=Math.random()*100+'%';d.style.animationDuration=(3+Math.random()*5)+'s';d.style.animationDelay=Math.random()*3+'s';d.style.opacity=Math.random()*0.3;p.appendChild(d)}
</script></body></html>`,
  },

  {
    id: "mp-stopwatch",
    type: "surface",
    title: "Stopwatch",
    description: "Precise stopwatch with lap times",
    icon: "⏱",
    author: "Surface Team",
    tags: ["utility", "timer", "stopwatch"],
    category: "utility",
    html: `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{margin:0;box-sizing:border-box}
body{background:#0a0a0a;color:#fff;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:24px}
.time{font-size:56px;font-weight:100;letter-spacing:2px;font-variant-numeric:tabular-nums}
.ms{font-size:32px;color:rgba(255,255,255,0.3)}
.controls{display:flex;gap:12px}
button{width:64px;height:64px;border-radius:50%;border:2px solid rgba(255,255,255,0.1);background:transparent;color:#fff;font-size:13px;cursor:pointer;font-family:inherit;transition:all 0.2s}
button:hover{background:rgba(255,255,255,0.06)}
.start{border-color:rgba(81,207,102,0.4);color:#51cf66}
.start:hover{background:rgba(81,207,102,0.1)}
.stop{border-color:rgba(255,107,107,0.4);color:#ff6b6b}
.stop:hover{background:rgba(255,107,107,0.1)}
.laps{width:260px;max-height:160px;overflow-y:auto;scrollbar-width:none}
.laps::-webkit-scrollbar{display:none}
.lap{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.04);font-size:13px}
.lap-n{color:rgba(255,255,255,0.25)}
.lap-t{color:rgba(255,255,255,0.5);font-variant-numeric:tabular-nums}
</style></head><body>
<div class="time" id="display">00:00<span class="ms">.00</span></div>
<div class="controls"><button class="start" id="btn" onclick="toggle()">Start</button><button onclick="lapOrReset()">Lap</button></div>
<div class="laps" id="laps"></div>
<script>
let t=0,running=false,iv,laps=[];const d=document.getElementById('display'),b=document.getElementById('btn'),l=document.getElementById('laps');
function fmt(ms){const m=Math.floor(ms/60000),s=Math.floor(ms%60000/1000),c=Math.floor(ms%1000/10);return String(m).padStart(2,'0')+':'+String(s).padStart(2,'0')+'<span class="ms">.'+String(c).padStart(2,'0')+'</span>'}
function tick(){t+=10;d.innerHTML=fmt(t)}
function toggle(){running=!running;if(running){iv=setInterval(tick,10);b.textContent='Stop';b.className='stop'}else{clearInterval(iv);b.textContent='Start';b.className='start'}}
function lapOrReset(){if(running){laps.unshift(t);l.innerHTML=laps.map((v,i)=>'<div class="lap"><span class="lap-n">Lap '+(laps.length-i)+'</span><span class="lap-t">'+fmt(v).replace(/<[^>]+>/g,'')+'</span></div>').join('')}else{t=0;laps=[];d.innerHTML=fmt(0);l.innerHTML=''}}
</script></body></html>`,
  },

  // ═══════════════════════════════════════
  // THEMES
  // ═══════════════════════════════════════

  {
    id: "mp-theme-cyberpunk",
    type: "theme",
    title: "Cyberpunk Neon",
    description: "Neon pink and cyan on deep purple. The future is now.",
    icon: "🌆",
    author: "Surface Team",
    tags: ["theme", "dark", "neon", "cyberpunk"],
    category: "themes",
    theme: {
      title: "Surface",
      background: "linear-gradient(135deg, #0a0012 0%, #1a0028 50%, #0a0020 100%)",
      starfield: true,
      nebula: true,
      nebulaColors: ["rgba(255,0,128,0.12)", "rgba(0,200,255,0.08)"],
      colors: {
        void: "#0a0012",
        glass: "rgba(255,0,128,0.04)",
        glassBorder: "rgba(255,0,128,0.15)",
        glassGlow: "rgba(255,0,128,0.06)",
        textPrimary: "rgba(255,255,255,0.95)",
        textSecondary: "rgba(0,220,255,0.6)",
        textGhost: "rgba(255,0,128,0.3)",
        accent: "#ff0080",
      },
      cardRadius: "12px",
      css: `.surface-card:hover{box-shadow:0 0 30px rgba(255,0,128,0.2),0 0 60px rgba(0,200,255,0.1)!important;border-color:rgba(255,0,128,0.4)!important} .grid-title{background:linear-gradient(90deg,#ff0080,#00d4ff);-webkit-background-clip:text;-webkit-text-fill-color:transparent;letter-spacing:8px!important} .star{background:#ff0080!important}`,
    },
  },

  {
    id: "mp-theme-minimal",
    type: "theme",
    title: "Minimal Light",
    description: "Clean, bright, and airy. Inspired by modern design systems.",
    icon: "☁️",
    author: "Surface Team",
    tags: ["theme", "light", "minimal", "clean"],
    category: "themes",
    theme: {
      title: "Surface",
      background: "#f5f5f7",
      starfield: false,
      nebula: false,
      colors: {
        void: "#f5f5f7",
        glass: "rgba(255,255,255,0.8)",
        glassBorder: "rgba(0,0,0,0.06)",
        glassGlow: "rgba(0,0,0,0)",
        textPrimary: "#1d1d1f",
        textSecondary: "#86868b",
        textGhost: "#d2d2d7",
        accent: "#0071e3",
      },
      cardRadius: "16px",
      font: "-apple-system, 'SF Pro Display', system-ui, sans-serif",
      css: `.surface-card{box-shadow:0 1px 3px rgba(0,0,0,0.08)!important} .surface-card:hover{box-shadow:0 4px 12px rgba(0,0,0,0.12)!important;transform:translateY(-2px) scale(1.01)!important} .surface-card::before{display:none!important} .card-preview{background:#f0f0f2!important} .card-preview-overlay{background:linear-gradient(180deg,transparent 40%,rgba(245,245,247,0.9) 100%)!important} .surface-nav{background:rgba(245,245,247,0.9)!important;border-bottom-color:rgba(0,0,0,0.08)!important} .back-btn{background:rgba(0,0,0,0.04)!important;border:none!important;color:#0071e3!important} .toast{background:rgba(255,255,255,0.95)!important;color:#1d1d1f!important;border-color:rgba(0,0,0,0.08)!important}`,
    },
  },

  {
    id: "mp-theme-forest",
    type: "theme",
    title: "Deep Forest",
    description: "Earthy greens and warm tones. Calm and grounded.",
    icon: "🌲",
    author: "Surface Team",
    tags: ["theme", "dark", "nature", "green"],
    category: "themes",
    theme: {
      title: "Surface",
      background: "linear-gradient(160deg, #0a1a0a 0%, #0d1f0a 50%, #0a150a 100%)",
      starfield: true,
      nebula: true,
      nebulaColors: ["rgba(34,120,50,0.12)", "rgba(80,140,40,0.08)"],
      colors: {
        void: "#0a1a0a",
        glass: "rgba(34,120,50,0.05)",
        glassBorder: "rgba(34,120,50,0.15)",
        glassGlow: "rgba(34,120,50,0.06)",
        textPrimary: "rgba(220,240,220,0.9)",
        textSecondary: "rgba(120,180,100,0.6)",
        textGhost: "rgba(34,120,50,0.25)",
        accent: "#4CAF50",
      },
      css: `.star{background:rgba(120,200,100,0.8)!important} .grid-title{color:rgba(80,160,60,0.3)!important}`,
    },
  },

  // ═══════════════════════════════════════
  // RENDERERS
  // ═══════════════════════════════════════

  {
    id: "mp-renderer-terminal",
    type: "renderer",
    title: "Retro Terminal",
    description: "Green-on-black terminal. Surfaces listed as files. Click to run.",
    icon: "💻",
    author: "Surface Team",
    tags: ["renderer", "retro", "terminal", "hacker"],
    category: "renderers",
    renderer: `<!DOCTYPE html><html><head><style>
*{margin:0;box-sizing:border-box}
body{background:#0a0a0a;color:#33ff33;font-family:'Courier New',monospace;padding:20px;height:100vh;overflow-y:auto}
.scanline{position:fixed;inset:0;pointer-events:none;background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,0.15) 2px,rgba(0,0,0,0.15) 4px);z-index:100}
.glow{text-shadow:0 0 5px rgba(51,255,51,0.5)}
.prompt{color:#33ff33;margin-bottom:2px;line-height:1.8;font-size:14px}
.dim{color:#1a8a1a}
.file{cursor:pointer;display:inline;text-decoration:none;color:#33ff33}
.file:hover{background:#33ff33;color:#0a0a0a}
.header{margin-bottom:16px;white-space:pre;font-size:12px;color:#1a8a1a;line-height:1.4}
.cursor{animation:blink 1s step-end infinite}
@keyframes blink{50%{opacity:0}}
</style></head><body>
<div class="scanline"></div>
<div class="header glow">╔══════════════════════════════════════╗
║         SURFACE TERMINAL v1.0        ║
║     Type a filename to launch...     ║
╚══════════════════════════════════════╝</div>
<div class="prompt dim">$ ls -la surfaces/</div>
<div class="prompt dim">total <span id="total">0</span></div>
<div id="listing"></div>
<div class="prompt" style="margin-top:12px"><span class="dim">$ </span><span class="cursor glow">█</span></div>
<script>
const surfaces=window.__surfaces||[];
document.getElementById('total').textContent=surfaces.length;
const listing=document.getElementById('listing');
surfaces.forEach(s=>{
const meta=window.parseMeta(s);
const d=document.createElement('div');d.className='prompt';
const date=new Date(s.updated_at+'Z');
const ds=date.toLocaleDateString('en-US',{month:'short',day:'2-digit'}).toLowerCase();
const ts=date.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false});
const icon=meta.icon||'-';
d.innerHTML='<span class="dim">-rwxr-xr-x  1 agent  surface  '+ds+' '+ts+'</span>  <a class="file glow" href="#">'+icon+' '+s.title+'</a>';
d.querySelector('.file').onclick=(e)=>{e.preventDefault();window.navigate(s.id)};
listing.appendChild(d)});
window.onSurfaceChange({created(){location.reload()},deleted(){location.reload()},updated(){}});
</script></body></html>`,
  },

  // ═══════════════════════════════════════
  // OVERLAYS
  // ═══════════════════════════════════════

  {
    id: "mp-overlay-clock",
    type: "overlay",
    title: "Floating Clock",
    description: "Minimal clock floating in the corner of your display",
    icon: "⏰",
    author: "Surface Team",
    tags: ["overlay", "clock", "minimal"],
    category: "overlays",
    overlay: `<!DOCTYPE html><html><head><style>
*{margin:0;box-sizing:border-box}
body{background:transparent;pointer-events:none;display:flex;justify-content:flex-end;padding:16px}
.clock{pointer-events:auto;font-family:system-ui,sans-serif;font-size:14px;color:rgba(255,255,255,0.4);background:rgba(0,0,0,0.3);backdrop-filter:blur(10px);padding:6px 14px;border-radius:8px;border:1px solid rgba(255,255,255,0.06);font-variant-numeric:tabular-nums;cursor:default;height:fit-content}
</style></head><body>
<div class="clock" id="c"></div>
<script>
function u(){document.getElementById('c').textContent=new Date().toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',hour12:true})}
u();setInterval(u,1000);
</script></body></html>`,
  },

  // ═══════════════════════════════════════
  // WIDGETS (declarative — cheap to author + update)
  // ═══════════════════════════════════════

  {
    id: "mp-widget-pomodoro",
    type: "surface",
    kind: "widgets",
    title: "Pomodoro (widgets)",
    description: "Declarative 25/5 focus timer. State survives agent-pushed updates.",
    icon: "🍅",
    author: "Surface Team",
    tags: ["productivity", "timer", "widgets"],
    category: "productivity",
    spec: {
      root: {
        type: "Stack",
        direction: "vertical",
        align: "center",
        gap: 24,
        padding: 24,
        children: [
          { type: "Text", value: "$.label", size: "sm", muted: true, tracking: "4px" },
          {
            type: "ProgressRing",
            value: "$.remaining",
            max: "$.total",
            label: "$.display",
            color: "$.color",
            size: 240,
          },
          {
            type: "Stack",
            direction: "horizontal",
            gap: 12,
            children: [
              {
                type: "Button",
                label: "$.startLabel",
                variant: "accent",
                color: "$.color",
                onClick: [
                  { op: "toggle", path: "running" },
                  { op: "set", path: "startLabel", value: "Pause" },
                ],
              },
              {
                type: "Button",
                label: "Reset",
                variant: "ghost",
                onClick: [
                  { op: "set", path: "remaining", value: 1500 },
                  { op: "set", path: "total", value: 1500 },
                  { op: "set", path: "running", value: false },
                  { op: "set", path: "display", value: "25:00" },
                  { op: "set", path: "startLabel", value: "Start" },
                  { op: "set", path: "color", value: "#ff6b6b" },
                  { op: "set", path: "label", value: "FOCUS" },
                ],
              },
            ],
          },
          { type: "Text", value: "$.sessionText", size: "xs", muted: true, tracking: "2px" },
        ],
      },
      state: {
        remaining: 1500,
        total: 1500,
        display: "25:00",
        running: false,
        label: "FOCUS",
        color: "#ff6b6b",
        startLabel: "Start",
        sessions: 0,
        sessionText: "0 sessions",
      },
      timers: [
        {
          every: 1000,
          while: "running",
          do: [
            { op: "dec", path: "remaining", min: 0 },
          ],
        },
      ],
    },
  },

  {
    id: "mp-widget-counter",
    type: "surface",
    kind: "widgets",
    title: "Tally Counter",
    description: "Minimal counter. Two buttons, one number. Demonstrates widgets basics.",
    icon: "🔢",
    author: "Surface Team",
    tags: ["utility", "widgets", "demo"],
    category: "utility",
    spec: {
      root: {
        type: "Stack",
        direction: "vertical",
        align: "center",
        gap: 24,
        padding: 32,
        children: [
          { type: "Text", value: "$.count", size: "3xl", weight: "thin" },
          {
            type: "Stack",
            direction: "horizontal",
            gap: 12,
            children: [
              { type: "Button", label: "−", variant: "ghost", onClick: [{ op: "dec", path: "count" }] },
              { type: "Button", label: "+", variant: "accent", onClick: [{ op: "inc", path: "count" }] },
              { type: "Button", label: "Reset", variant: "ghost", onClick: [{ op: "set", path: "count", value: 0 }] },
            ],
          },
        ],
      },
      state: { count: 0 },
    },
  },

  {
    id: "mp-widget-todo",
    type: "surface",
    kind: "widgets",
    title: "Quick Todo",
    description: "Add, check, delete. List widget + Input binding.",
    icon: "📋",
    author: "Surface Team",
    tags: ["productivity", "list", "widgets"],
    category: "productivity",
    spec: {
      root: {
        type: "Stack",
        direction: "vertical",
        gap: 16,
        padding: 24,
        children: [
          { type: "Text", value: "Quick Todo", size: "lg", weight: "medium" },
          {
            type: "Stack",
            direction: "horizontal",
            gap: 8,
            children: [
              {
                type: "Input",
                placeholder: "What to do…",
                bind: "draft",
                value: "$.draft",
                onSubmit: [
                  { op: "push", path: "items", value: "$.draft" },
                  { op: "set", path: "draft", value: "" },
                ],
              },
              {
                type: "Button",
                label: "Add",
                variant: "accent",
                onClick: [
                  { op: "push", path: "items", value: "$.draft" },
                  { op: "set", path: "draft", value: "" },
                ],
              },
            ],
          },
          {
            type: "List",
            items: "$.items",
            gap: 6,
            item: {
              type: "Card",
              padding: 12,
              radius: 10,
              children: [{ type: "Text", value: "$item" }],
            },
          },
          { type: "Text", value: "$.items.length", size: "xs", muted: true },
        ],
      },
      state: { items: [], draft: "" },
    },
  },
];
