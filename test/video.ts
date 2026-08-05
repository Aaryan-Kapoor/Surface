// The video surface's two-way clock.
//
// A video surface is the one place where "where is the user" is a real
// question, and the answer has to travel a specific way: a surface CANNOT write
// its own state (PATCH /artifacts/:id/state is system-plane only), so the
// playhead rides on the actions the page already sends and the server folds it
// in. That fold is what these tests pin — along with the other direction, where
// the agent answers with a one-key `reply` patch and the server appends the
// turn, so two answers can never clobber each other's array.
import assert from "node:assert/strict";
import { cleanupDir, isolatedPorts, killServer, makeClient, sleep, spawnServer, tmpDir, waitForReady } from "./helpers.js";

const dataDir = tmpDir("surface-video-data-");
let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) { passed++; console.log(`  PASS  ${name}`); return; }
  failures.push(name);
  console.log(`  FAIL  ${name}`);
  if (detail !== undefined) console.log(`        ${JSON.stringify(detail)}`);
}

const { port, contentPort } = await isolatedPorts();
const base = `http://127.0.0.1:${port}`;
const call = makeClient(base);
const server = spawnServer(port, dataDir, {}, contentPort);

try {
  await waitForReady(base);

  const made = await call("POST", "/artifacts", {
    body: {
      title: "For you",
      template: "video",
      params: { url: "https://youtu.be/DWcqbPm_Rn4?t=195" },
    },
  });
  const id: string = made.body.artifact.id;
  check("a video surface is created from the template", made.status === 201 && !!id, made.status);

  const stateOf = async () => (await call("GET", `/artifacts/${id}/state`)).body.state ?? {};
  const ask = (data: Record<string, unknown>) =>
    call("POST", `/artifacts/${id}/actions`, { body: { action: "ask", data } });

  // ── surface → agent ──

  const asked = await ask({ text: "what is he explaining here?", t: 195.4, duration: 912, playing: true, video_id: "DWcqbPm_Rn4" });
  check("a question is an ordinary action, so it wakes the agent like any click",
    asked.status === 201 && asked.body?.action === "ask", asked.status);

  let st = await stateOf();
  check("the playhead the question was asked at is folded into state",
    st.playhead?.t === 195.4 && st.playhead?.duration === 912 && st.playhead?.playing === true,
    st.playhead);
  check("the fold stamps when it was read, so a stale playhead is visible as stale",
    typeof st.playhead?.at === "string" && !Number.isNaN(Date.parse(st.playhead.at)), st.playhead?.at);
  check("the question is appended to the thread with its timestamp",
    st.thread?.length === 1 && st.thread[0].role === "user" && st.thread[0].t === 195.4,
    st.thread);
  check("each turn carries an id and a wall-clock time of its own",
    typeof st.thread[0].id === "string" && typeof st.thread[0].at === "string", st.thread[0]);

  // A seek reports where they went without saying anything.
  await call("POST", `/artifacts/${id}/actions`, { body: { action: "seek", data: { t: 236, to: 236, from: "marker" } } });
  st = await stateOf();
  check("a seek moves the playhead and adds no turn", st.playhead?.t === 236 && st.thread.length === 1,
    { playhead: st.playhead, turns: st.thread.length });

  // An opaque embed cannot be read, and must not be guessed at.
  await ask({ text: "and here?", t: null });
  st = await stateOf();
  check("a question from an unreadable player does not invent a timestamp",
    st.thread.length === 2 && st.thread[1].t === null, st.thread[1]);
  check("nor does it overwrite the last playhead that was real", st.playhead?.t === 236, st.playhead);

  // ── agent → surface ──

  await call("PATCH", `/artifacts/${id}/state`, {
    body: { reply: "He is setting up the argument he pays off around 3:56." },
  });
  st = await stateOf();
  check("a reply patch becomes an agent turn in the same thread",
    st.thread.length === 3 && st.thread[2].role === "agent", st.thread.map((x: any) => x.role));
  // `reply` is a verb, not a value: leaving it in state would render the last
  // answer twice — once in the thread and once as a stray key.
  check("the reply key is consumed, not left behind in state", !("reply" in st), Object.keys(st));

  await call("PATCH", `/artifacts/${id}/state`, {
    body: { reply: { text: "That bit starts here.", t: 236 }, markers: [{ t: 236, label: "the payoff" }] },
  });
  st = await stateOf();
  check("a reply can anchor itself to a moment in the video",
    st.thread.length === 4 && st.thread[3].t === 236, st.thread[3]);
  check("other keys in the same patch are written normally",
    Array.isArray(st.markers) && st.markers[0]?.label === "the payoff", st.markers);

  await call("PATCH", `/artifacts/${id}/state`, { body: { reply: "   " } });
  st = await stateOf();
  check("an empty reply is not a turn", st.thread.length === 4, st.thread.length);

  // ── the boundary ──

  const plain = await call("POST", "/artifacts", {
    body: { title: "Board", mime: "text/html", content: "<h1>b</h1>", template: "gauge" },
  });
  const plainId: string = plain.body.artifact.id;
  await call("POST", `/artifacts/${plainId}/actions`, { body: { action: "ask", data: { text: "hi", t: 12 } } });
  await call("PATCH", `/artifacts/${plainId}/state`, { body: { reply: "hello" } });
  const plainState = (await call("GET", `/artifacts/${plainId}/state`)).body.state ?? {};
  check("neither hook touches a template that is not a video",
    !("thread" in plainState) && !("playhead" in plainState) && plainState.reply === "hello",
    plainState);

} finally {
  await killServer(server, port).catch(() => {});
  await sleep(100);
  cleanupDir(dataDir);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  FAILED: ${f}`);
  process.exitCode = 1;
} else {
  console.log("video tests passed");
}
