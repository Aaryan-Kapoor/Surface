// Action notifications.
//
// A notification used to be a dead end: text appeared, text left, and anything
// you wanted to ask the user had to become a whole surface. Buttons close that
// gap — but only if pressing one is genuinely the same event as clicking inside
// a surface. If it were a second, parallel path, then `surface wait` would miss
// it, two agents could both handle it, and the delivery ladder's exclusivity
// contract (docs/interaction/delivery-ladder.md) would quietly have a hole in
// it.
//
// So the load-bearing assertion here is not "the button renders". It is that a
// button press lands in the same inbox, gets claimed by the same waiter, and is
// indistinguishable from a click once it arrives.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import {
  cleanupDir, isolatedPorts, killServer, makeClient, REPO_ROOT, sleep, spawnServer, tmpDir, waitForReady,
} from "./helpers.js";

const cli = path.join(REPO_ROOT, "dist", "surface.mjs");
const dataDir = tmpDir("surface-notify-data-");

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(name);
    console.error(`  FAIL  ${name}${detail === undefined ? "" : `\n        ${JSON.stringify(detail)}`}`);
  }
}

function runCli(args: string[], base: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const proc = spawn("node", [cli, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, SURFACE_URL: base },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    proc.stdout.on("data", (c) => (out += c));
    proc.stderr.on("data", (c) => (err += c));
    proc.on("close", (code) => resolve({ code: code ?? -1, out, err }));
  });
}

let server: ChildProcess | null = null;
const { port, contentPort } = await isolatedPorts();
const base = `http://127.0.0.1:${port}`;
const call = makeClient(base);

try {
  server = spawnServer(port, dataDir, {}, contentPort);
  await waitForReady(base);

  const created = await call("POST", "/artifacts", {
    body: { title: "Notify host", mime: "text/html", content: "<h1>host</h1>" },
  });
  const id: string = created.body.artifact.id;

  // ── the shape of the broadcast ──

  // Everything the display needs to draw an answerable notification has to be
  // in the one event; the client has no second fetch to fall back on.
  const events: any[] = [];
  const sse = new AbortController();
  const streaming = (async () => {
    const res = await fetch(`${base}/stream`, { signal: sse.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (const chunk of buffer.split("\n\n").slice(0, -1)) {
        const line = chunk.split("\n").find((l) => l.startsWith("data:"));
        if (line) { try { events.push(JSON.parse(line.slice(5).trim())); } catch { /* heartbeat */ } }
      }
      buffer = buffer.slice(buffer.lastIndexOf("\n\n") + 2);
    }
  })().catch(() => {});
  await sleep(400);

  const withButtons = await call("POST", "/display/notify", {
    body: {
      text: "Deploy 14 commits to production?",
      surface_id: id,
      actions: [{ label: "Ship it", action: "deploy" }, { label: "Not now", action: "defer" }],
    },
  });
  check("a notification accepts buttons", withButtons.status === 200, withButtons.body);
  await sleep(500);

  const payload = events.find((e) => e && e.text === "Deploy 14 commits to production?");
  check("the buttons reach the display", !!payload && payload.actions?.length === 2, payload);
  check("each button carries its label and its action name",
    payload?.actions?.[0]?.label === "Ship it" && payload?.actions?.[0]?.action === "deploy", payload?.actions);
  check("the notification says which surface owns the answer", payload?.surface_id === id, payload?.surface_id);
  // A question that expires while you are reading it is worse than no question.
  check("a notification with buttons does not expire on its own", payload?.sticky === true, payload?.sticky);

  const plain = await call("POST", "/display/notify", { body: { text: "Build finished" } });
  check("a plain notification still works", plain.status === 200, plain.body);
  await sleep(400);
  const plainEvent = events.find((e) => e && e.text === "Build finished");
  check("a plain notification still expires on its own", plainEvent?.sticky === false, plainEvent?.sticky);

  sse.abort();
  await streaming;

  // ── what the server refuses ──

  const orphan = await call("POST", "/display/notify", {
    body: { text: "Deploy?", actions: [{ label: "Ship", action: "deploy" }] },
  });
  check("buttons without a surface are refused", orphan.status === 400, orphan.body);

  const missingSurface = await call("POST", "/display/notify", {
    body: { text: "Deploy?", surface_id: "00000000-0000-0000-0000-000000000000", actions: [{ label: "Ship", action: "deploy" }] },
  });
  check("buttons on a surface that does not exist are refused", missingSurface.status === 404, missingSurface.body);

  const nameless = await call("POST", "/display/notify", {
    body: { text: "Deploy?", surface_id: id, actions: [{ label: "Ship" }] },
  });
  check("a button with no action name is refused", nameless.status === 400, nameless.body);

  const tooMany = await call("POST", "/display/notify", {
    body: {
      text: "Pick", surface_id: id,
      actions: ["a", "b", "c", "d"].map((k) => ({ label: k, action: k })),
    },
  });
  check("a notification cannot become a menu", tooMany.status === 400, tooMany.body);

  // ── the CLI ──

  const noId = await runCli(["notify", "Deploy?", "--button", "Ship it=deploy"], base);
  check("the CLI refuses --button without --id", noId.code !== 0 && /--id/.test(noId.err + noId.out), noId);

  const viaCli = await runCli(
    ["notify", "Deploy?", "--id", id, "--button", "Ship it=deploy", "--button", "Not now=defer"],
    base,
  );
  check("the CLI sends both buttons", viaCli.code === 0 && /"actions": 2/.test(viaCli.out), viaCli);

  // A label may contain "=", so the split has to be on the last one.
  const awkward = await runCli(["notify", "Check", "--id", id, "--button", "x = y=confirm"], base);
  check("a label containing = still parses", awkward.code === 0, awkward);

  // ── the log outlives the frame ──

  const listed = await call("GET", "/notifications");
  // By text, not "the first open one" — several were sent above, and which is
  // newest is not the property under test.
  const open = listed.body.notifications.find((n: any) => n.text === "Deploy 14 commits to production?");
  check("an unanswered question is still there after the frame is gone", !!open, listed.body.notifications?.length);
  check("the badge counts what is still waiting on you", listed.body.unread > 0, listed.body.unread);

  // Reading is not answering: a question you have looked at is still a question.
  await call("POST", "/notifications/seen");
  const afterSeen = await call("GET", "/notifications");
  check("seeing a question does not answer it", afterSeen.body.unread > 0, afterSeen.body.unread);

  // ── the part that matters: a press is a click ──

  const rejected = await call("POST", `/notifications/${open.id}/answer`, { body: { action: "not-a-button" } });
  check("only this notification's own buttons can be pressed", rejected.status === 400, rejected.body);

  const pressed = await call("POST", `/notifications/${open.id}/answer`, { body: { action: "deploy" } });
  check("pressing a button records an action", pressed.status === 200, pressed.status);
  check("the action carries where it came from",
    pressed.body?.action?.action === "deploy" && /"from":"notification"/.test(pressed.body?.action?.data ?? ""),
    pressed.body?.action);

  const twice = await call("POST", `/notifications/${open.id}/answer`, { body: { action: "defer" } });
  check("a question cannot be answered twice", twice.status === 409, twice.status);

  // Other questions sent earlier in this run are legitimately still open, so
  // the property is that answering removed exactly this one from the count.
  const afterAnswer = await call("GET", "/notifications");
  check("answering clears it from the badge",
    afterAnswer.body.unread === afterSeen.body.unread - 1,
    { before: afterSeen.body.unread, after: afterAnswer.body.unread });

  // Clearing the tray must not be how you lose something still owed an answer.
  await call("POST", "/display/notify", {
    body: { text: "Still open?", surface_id: id, actions: [{ label: "Yes", action: "yes" }] },
  });
  await call("POST", "/notifications/dismiss-all");
  const afterClear = await call("GET", "/notifications");
  check("clear leaves an unanswered question alone",
    afterClear.body.notifications.some((n: any) => n.text === "Still open?"),
    afterClear.body.notifications.map((n: any) => n.text));
  check("clear does remove what is finished with",
    !afterClear.body.notifications.some((n: any) => n.text === "Build finished"),
    afterClear.body.notifications.map((n: any) => n.text));

  // ── the same decision, answered somewhere else ──
  //
  // The tour asks "ready for the next one?" in the tray while the same Next
  // sits on the page. Pressing the page one used to leave the tray holding a
  // question already answered, counted forever by the badge.
  const twinned = await call("POST", "/display/notify", {
    body: { text: "Ready for the next one?", surface_id: id, actions: [{ label: "Next", action: "next" }] },
  });
  const otherQuestion = await call("POST", "/display/notify", {
    body: { text: "Ship it?", surface_id: id, actions: [{ label: "Ship", action: "ship" }] },
  });
  await call("POST", `/artifacts/${id}/actions`, { body: { action: "next", data: { from: "gauge" } } });
  const afterPageSide = await call("GET", "/notifications");
  const rowOf = (nid: string) => afterPageSide.body.notifications.find((n: any) => n.id === nid);
  check("pressing Next on the page answers the same question in the tray",
    !!rowOf(twinned.body.id)?.answered_at && rowOf(twinned.body.id)?.answer === "next",
    rowOf(twinned.body.id));
  // The narrowness is the whole safety of it: a surface fires many actions, and
  // only the one a question actually offered may close that question.
  check("an unrelated action leaves other questions open",
    !rowOf(otherQuestion.body.id)?.answered_at,
    rowOf(otherQuestion.body.id));

  const waiter = spawn("node", [cli, "wait", "--id", id, "--action", "deploy", "--timeout", "10"], {
    cwd: REPO_ROOT,
    env: { ...process.env, SURFACE_URL: base },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let waited = "";
  waiter.stdout.on("data", (c) => (waited += c));
  const code: number = await new Promise((resolve) => waiter.on("close", (c) => resolve(c ?? -1)));

  check("`surface wait` claims a notification press like any other click", code === 0, { code, waited });
  // `surface wait` pretty-prints its one result, so the whole of stdout is the
  // object — taking the last line would take a closing brace.
  let parsed: any = null;
  try { parsed = JSON.parse(waited.trim()); } catch { /* asserted below */ }
  const payloadOf = (row: any) => {
    const raw = row?.data;
    if (raw && typeof raw === "object") return raw;
    try { return JSON.parse(raw ?? "{}"); } catch { return {}; }
  };
  check("the press arrives with its action name and payload",
    parsed?.action === "deploy" && payloadOf(parsed)?.from === "notification", parsed);
  // ── the whiteboard keeps what the human drew ──
  //
  // Strokes lived only in the browser that made them, so reopening the board
  // showed the agent's marks on an otherwise blank canvas — the one drawing
  // worth keeping was the one thrown away.
  const board = await call("POST", "/artifacts", {
    body: { title: "Board", mime: "text/html", content: "<h1>b</h1>", template: "whiteboard" },
  });
  const boardId: string = board.body.artifact.id;
  const strokes = [{ points: [[0.1, 0.1], [0.4, 0.4]], width: 4, erase: false }];
  await call("POST", `/artifacts/${boardId}/actions`, {
    body: { action: "snapshot", data: { png: "data:image/png;base64,AAAA", strokes } },
  });
  const boardState = await call("GET", `/artifacts/${boardId}/state`);
  check("a sent drawing survives the browser that drew it",
    JSON.stringify(boardState.body?.state?.user_strokes) === JSON.stringify(strokes),
    boardState.body?.state);
  // The PNG is two orders of magnitude larger and reconstructible from the
  // vectors; keeping it would put a screenshot in every state read.
  check("the picture is not kept alongside them",
    !JSON.stringify(boardState.body?.state || {}).includes("base64"),
    Object.keys(boardState.body?.state || {}));

  // Clear has to erase what persisting saved, or it only looks like it worked
  // and the drawing returns on the next reload.
  await call("PATCH", `/artifacts/${boardId}/state`, {
    body: { patch: { agent_strokes: [{ points: [[0, 0], [1, 1]], width: 2 }], note: "have a look" } },
  });
  await call("POST", `/artifacts/${boardId}/actions`, { body: { action: "cleared", data: {} } });
  const cleared = await call("GET", `/artifacts/${boardId}/state`);
  check("clearing the board clears what was saved",
    JSON.stringify(cleared.body?.state?.user_strokes ?? []) === "[]", cleared.body?.state?.user_strokes);
  check("clearing takes the agent's marks with it",
    JSON.stringify(cleared.body?.state?.agent_strokes ?? []) === "[]", cleared.body?.state?.agent_strokes);
  check("clearing takes the caption with it",
    !cleared.body?.state?.note, cleared.body?.state?.note);

  // ── a question put to one screen is not every screen's ──
  //
  // `--on kitchen` scopes the toast. If the stored row is not scoped the same
  // way, the targeting is decoration: the study screen reloads, finds the
  // question in its tray, and can press the button that answers it.
  //
  // This needs a second boot. Everything above runs over trusted loopback,
  // where every request is the system plane no matter what cookie it carries,
  // so a paired cookie could never be told apart from the agent.
  const sysMint = await call("POST", "/api/auth/sessions", { body: { role: "system", label: "notify-admin" } });
  const SYS = sysMint.body.token as string;
  const mint = await call("POST", "/api/auth/pairing-token", { body: { label: "kitchen" } });
  const boot = await call("POST", "/api/auth/bootstrap", { body: { credential: mint.body.credential } });
  const kitchen = (boot.headers.get("set-cookie") || "").match(/surface_session=[^;]+/)?.[0] || "";
  const mint2 = await call("POST", "/api/auth/pairing-token", { body: { label: "study" } });
  const boot2 = await call("POST", "/api/auth/bootstrap", { body: { credential: mint2.body.credential } });
  const study = (boot2.headers.get("set-cookie") || "").match(/surface_session=[^;]+/)?.[0] || "";
  check("two devices paired for the scoping tests", !!kitchen && !!study, { kitchen: !!kitchen, study: !!study });

  await killServer(server, port);
  server = spawnServer(port, dataDir, { SURFACE_TRUST_LOOPBACK: "0" }, contentPort);
  await waitForReady(base);

  const targeted = await call("POST", "/display/notify", {
    token: SYS,
    body: {
      text: "Kitchen only: start the roast?",
      device: "kitchen",
      surface_id: id,
      actions: [{ label: "Start", action: "roast" }],
    },
  });
  const targetedId: string = targeted.body.id;

  const kitchenTray = await call("GET", "/notifications", { cookie: kitchen });
  check("the targeted screen sees its own question",
    kitchenTray.body?.notifications?.some((n: any) => n.id === targetedId), kitchenTray.body);
  const studyTray = await call("GET", "/notifications", { cookie: study });
  check("another screen never sees it",
    !studyTray.body?.notifications?.some((n: any) => n.id === targetedId), studyTray.body);
  // Both screens share the untargeted backlog from earlier in this file, so the
  // number to assert is the difference: the targeted question is on exactly one
  // of the two badges.
  check("and it is not counted on that screen's badge",
    kitchenTray.body?.unread === studyTray.body?.unread + 1,
    { kitchen: kitchenTray.body?.unread, study: studyTray.body?.unread });

  // Not 403: confirming the id exists is itself a leak.
  const steal = await call("POST", `/notifications/${targetedId}/answer`, {
    cookie: study, body: { action: "roast" },
  });
  check("another screen cannot answer it", steal.status === 404, steal.status);
  const snoop = await call("POST", `/notifications/${targetedId}/dismiss`, { cookie: study });
  check("another screen cannot dismiss it", snoop.status === 404, snoop.status);

  const mine = await call("POST", `/notifications/${targetedId}/answer`, {
    cookie: kitchen, body: { action: "roast" },
  });
  check("the screen it was put to can answer it", mine.status === 200, mine.body);

  // The agent side is bookkeeping, not eavesdropping: a read from the system
  // plane still sees the whole log.
  const systemTray = await call("GET", "/notifications", { token: SYS });
  check("the agent still sees every notification",
    systemTray.body?.notifications?.some((n: any) => n.id === targetedId), systemTray.body?.notifications?.length);

  // An untargeted notification is still everyone's.
  const broadcast = await call("POST", "/display/notify", { token: SYS, body: { text: "Dinner is ready" } });
  const bothSee = await Promise.all([
    call("GET", "/notifications", { cookie: kitchen }),
    call("GET", "/notifications", { cookie: study }),
  ]);
  check("a notification with no device still reaches every screen",
    bothSee.every((r) => r.body?.notifications?.some((n: any) => n.id === broadcast.body.id)),
    bothSee.map((r) => r.body?.notifications?.length));

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
  console.log("notification tests passed");
}
