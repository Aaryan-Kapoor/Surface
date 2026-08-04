import fs from "fs";
import http from "http";
import path from "path";
import { cleanupDir, isolatedPorts, killServer, makeClient, sleep, spawnServer, tmpDir, waitForReady } from "./helpers.js";
import { thumbGenerationFor } from "../server/thumbs.js";
import type { ChildProcess } from "node:child_process";

let SURFACE_URL = "";
let server: ChildProcess | null = null;
let serverPort = 0;
const dataDir = tmpDir("surface-artifacts-data-");
const req = () => makeClient(SURFACE_URL);

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await req()(method, path, { body });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`${method} ${path} failed ${res.status}: ${typeof res.body === "string" ? res.body : JSON.stringify(res.body)}`);
  }
  return res.body;
}

async function raw(method: string, path: string, body?: unknown): Promise<{ status: number; body: string }> {
  const res = await req()(method, path, { body });
  return { status: res.status, body: typeof res.body === "string" ? res.body : JSON.stringify(res.body) };
}

async function optionalDelete(path: string): Promise<void> {
  try {
    await api("DELETE", path);
  } catch {}
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// A minimal global-SSE reader. There is no helper for this yet and the
// passthrough-readiness assertion below needs the real event, not a proxy for
// it: the whole point is that the dashboard is told, over the wire, that the
// picture it is not showing has become available.
function openGlobalStream(): { events: Array<{ event: string; data: any }>; close: () => void } {
  const events: Array<{ event: string; data: any }> = [];
  const request = http.request(
    { host: "127.0.0.1", port: serverPort, path: "/stream", headers: { Accept: "text/event-stream" } },
    (res) => {
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        let split: number;
        while ((split = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const name = /^event: (.+)$/m.exec(frame)?.[1];
          const payload = /^data: (.*)$/m.exec(frame)?.[1];
          if (!name) continue;
          let data: any = payload;
          try { data = payload ? JSON.parse(payload) : undefined; } catch {}
          events.push({ event: name, data });
        }
      });
      res.on("error", () => {});
    },
  );
  request.on("error", () => {});
  request.end();
  return { events, close: () => request.destroy() };
}

let tmpRoot2Cache: string | null = null;
function tmpRoot2(): string {
  if (!tmpRoot2Cache) tmpRoot2Cache = tmpDir("surface-doc-test-");
  return tmpRoot2Cache;
}

async function main() {
  const ports = await isolatedPorts();
  serverPort = ports.port;
  SURFACE_URL = `http://127.0.0.1:${serverPort}`;
  // A binary that cannot start: thumbnail behaviour here is about the cache
  // keys and the card flags, and a real capture landing mid-assertion would
  // rewrite the files these tests place by hand.
  server = spawnServer(serverPort, dataDir, {
    SURFACE_CHROME: path.join(dataDir, "no-such-chrome"),
  }, ports.contentPort);
  await waitForReady(SURFACE_URL, "/artifacts");

  const suffix = Date.now().toString(36);
  const htmlId = `artifact-test-html-${suffix}`;
  const mdId = `artifact-test-md-${suffix}`;

  // ── Workspace artifacts ──

  const html = await api("POST", "/artifacts", {
    id: htmlId,
    title: "Artifact Test HTML",
    mime: "text/html",
    content: "<!doctype html><html><body>hello</body></html>",
    project_root: "/tmp/fake-project",
    metadata: { icon: "HTML", description: "artifact HTTP test", agent: "test-agent" },
  });
  assert(html.artifact.id === htmlId, "HTML artifact ID mismatch");
  assert(html.version.version === 1, "HTML artifact should start at version 1");
  assert(html.artifact.project_root === "/tmp/fake-project", "project_root not stamped on create");
  const htmlFile = await req()("GET", `/artifacts/${htmlId}/files/index.html`);
  assert(
    htmlFile.headers.get("cache-control") === "no-cache",
    `HTML surface responses must revalidate (got ${htmlFile.headers.get("cache-control")})`,
  );

  const md = await api("POST", "/artifacts", {
    id: mdId,
    title: "Artifact Test Markdown",
    mime: "text/markdown",
    path: "notes.md",
    content: "# First\n\nBody",
    metadata: { icon: "MD" },
  });
  assert(md.files[0].path === "notes.md", "Markdown artifact path mismatch");

  const updated = await api("PUT", `/artifacts/${mdId}`, {
    mime: "text/markdown",
    path: "notes.md",
    content: "# Second\n\nUpdated",
    reason: "test-update",
  });
  assert(updated.version.version === 2, "Markdown artifact did not create version 2");

  const versions = await api("GET", `/artifacts/${mdId}/versions`);
  assert(Array.isArray(versions) && versions.length === 2, "Version list should include two versions");

  const rolledBack = await api("POST", `/artifacts/${mdId}/rollback`, { version: 1 });
  assert(rolledBack.version.version === 1, "Rollback did not select version 1");

  const fileText = await api("GET", `/artifacts/${mdId}/files/notes.md`);
  assert(fileText.includes("First"), "Artifact file route did not reflect rolled back version");

  const binaryId = `artifact-test-binary-${suffix}`;
  const binary = await api("POST", "/artifacts", {
    id: binaryId,
    title: "Binary",
    mime: "application/octet-stream",
    path: "bytes.bin",
    content_base64: Buffer.from([0, 127, 128, 255]).toString("base64"),
  });
  assert(binary.files[0].size_bytes === 4, "base64 binary artifact size mismatch");
  const rejectedBinary = await raw("POST", "/artifacts", {
    title: "Bad Binary",
    mime: "application/octet-stream",
    path: "bad.bin",
    content: "\u00ff",
  });
  assert(rejectedBinary.status === 400, "binary JSON string should be rejected");

  const cards = await api("GET", "/artifacts");
  assert(cards.some((card: any) => card.id === htmlId && card.preview_url), "HTML artifact missing from surface cards");
  assert(cards.some((card: any) => card.id === mdId && card.artifact_mime === "text/markdown"), "Markdown artifact missing from surface cards");
  const htmlCard = cards.find((card: any) => card.id === htmlId);
  assert(htmlCard.project_root === "/tmp/fake-project", "Card missing project_root");
  assert(htmlCard.agent === "test-agent", "Card missing agent extracted from metadata");
  assert(typeof htmlCard.pending_actions === "number", "Card missing pending_actions count");

  const filtered = await api("GET", `/artifacts?project=${encodeURIComponent("/tmp/fake-project")}`);
  assert(filtered.some((card: any) => card.id === htmlId), "project filter dropped the artifact");
  assert(!filtered.some((card: any) => card.id === mdId), "project filter leaked other projects");

  const view = await api("GET", `/artifacts/${mdId}/view`);
  assert(view.includes("Artifact Test Markdown"), "Artifact view shell missing title");

  const action = await api("POST", `/artifacts/${mdId}/actions`, {
    action: "artifact_test_action",
    data: { ok: true },
  });
  assert(action.action === "artifact_test_action", "Artifact action failed");

  // ── Surface state ──

  const state0 = await api("GET", `/artifacts/${htmlId}/state`);
  assert(state0.state_version === 0 && Object.keys(state0.state).length === 0, "Fresh artifact should have empty state");

  const state1 = await api("PATCH", `/artifacts/${htmlId}/state`, { progress: 0.42, tests: { passed: 10 } });
  assert(state1.state_version === 1, "First patch should bump version to 1");
  assert(state1.state.progress === 0.42, "Patch did not set progress");

  const state2 = await api("PATCH", `/artifacts/${htmlId}/state`, { tests: { failed: 2 }, stage: "deploy" });
  assert(state2.state.tests.passed === 10 && state2.state.tests.failed === 2, "Deep merge lost sibling keys");
  assert(state2.state_version === 2, "Second patch should bump version to 2");

  const state3 = await api("PATCH", `/artifacts/${htmlId}/state`, { stage: null });
  assert(!("stage" in state3.state), "null should delete the key");

  // surface.js runtime is injected into served HTML
  const servedHtml = await api("GET", `/artifacts/${htmlId}/files/index.html`);
  assert(servedHtml.includes(`/surface.js?id=${htmlId}`), "surface.js runtime not injected into served HTML");

  const pendingForSurface = await api("GET", `/artifacts/${mdId}/actions`);
  assert(pendingForSurface.some((a: any) => a.id === action.id), "Pending action not listed");
  const acked = await api("POST", `/actions/${action.id}/ack`);
  assert(acked.acknowledged === true, "Action ack failed");

  // Legacy surface routes are gone.
  const legacyList = await raw("GET", "/surfaces");
  assert(legacyList.status === 404, `GET /surfaces should 404 (got ${legacyList.status})`);

  // ── Linked artifacts ──

  const tmpRoot = tmpDir("surface-link-test-");
  const linkedFileIds: string[] = [];
  try {
    // Single-file link
    const singlePath = path.join(tmpRoot, "single.html");
    fs.writeFileSync(singlePath, "<h1 id='single'>linked-single</h1>");
    const single = await api("POST", "/artifacts/link", { path: singlePath, title: "Linked Single" });
    linkedFileIds.push(single.artifact.id);
    assert(single.artifact.source_type === "linked", "Single-file link did not set source_type=linked");
    assert(single.files[0].storage_kind === "external", "Single-file link did not set storage_kind=external");
    assert(single.files[0].storage_path === fs.realpathSync(singlePath), "storage_path should be the realpath");

    const singleBytes = await api("GET", `/artifacts/${single.artifact.id}/files/single.html`);
    assert(singleBytes.includes("linked-single"), "Single-file link did not serve bytes");
    const linkedHtml = await req()("GET", `/artifacts/${single.artifact.id}/files/single.html`);
    assert(
      linkedHtml.headers.get("cache-control") === "no-cache",
      `Linked HTML must revalidate (got ${linkedHtml.headers.get("cache-control")})`,
    );
    const singleViewRedirect = await req()("GET", `/artifacts/${single.artifact.id}/view?v=touch-test`);
    assert(singleViewRedirect.status === 302, `HTML view should redirect to file route (got ${singleViewRedirect.status})`);
    assert(
      singleViewRedirect.headers.get("location") === `/artifacts/${single.artifact.id}/files/single.html?v=touch-test`,
      "HTML view redirect dropped cache-busting query params",
    );

    // Directory link with entry + sibling
    const dirPath = path.join(tmpRoot, "projdir");
    fs.mkdirSync(dirPath);
    fs.writeFileSync(path.join(dirPath, "index.html"), "<h1>linked-index</h1>");
    fs.writeFileSync(path.join(dirPath, "sibling.txt"), "sibling-bytes");
    const dir = await api("POST", "/artifacts/link", {
      path: dirPath,
      entry: "index.html",
      title: "Linked Dir",
    });
    linkedFileIds.push(dir.artifact.id);
    const indexBytes = await api("GET", `/artifacts/${dir.artifact.id}/files/index.html`);
    assert(indexBytes.includes("linked-index"), "Linked dir entry not served");
    const siblingBytes = await api("GET", `/artifacts/${dir.artifact.id}/files/sibling.txt`);
    assert(siblingBytes.includes("sibling-bytes"), "Linked dir sibling not served via fallback");

    // Link nonexistent path → 400
    const missing = await raw("POST", "/artifacts/link", {
      path: path.join(tmpRoot, "does-not-exist.html"),
      title: "Missing",
    });
    assert(missing.status === 400, `Linking missing path should 400 (got ${missing.status})`);

    // Update content on linked → 409
    const updateOnLinked = await raw("PUT", `/artifacts/${single.artifact.id}`, {
      mime: "text/html",
      content: "<h1>nope</h1>",
    });
    assert(updateOnLinked.status === 409, `Update on linked should 409 (got ${updateOnLinked.status})`);

    // Rollback on linked → 409
    const rollbackOnLinked = await raw("POST", `/artifacts/${single.artifact.id}/rollback`, { version: 1 });
    assert(rollbackOnLinked.status === 409, `Rollback on linked should 409 (got ${rollbackOnLinked.status})`);

    // Touch on linked → 200
    const touched = await api("POST", `/artifacts/${single.artifact.id}/touch`);
    assert(touched.touched === true, "Touch should return { touched: true }");

    // Path traversal via URL-encoded segment → 400
    const traversal = await raw(
      "GET",
      `/artifacts/${dir.artifact.id}/files/..%2F..%2Fetc%2Fpasswd`,
    );
    assert(traversal.status === 400, `Path traversal should 400 (got ${traversal.status})`);

    // Symlink escape — symlink inside the linked dir pointing outside it
    const secretPath = path.join(tmpRoot, "secret.txt");
    fs.writeFileSync(secretPath, "SHOULD-NOT-LEAK");
    let symlinkCreated = true;
    try {
      fs.symlinkSync(secretPath, path.join(dirPath, "leak"));
    } catch (err: any) {
      if (process.platform !== "win32" || err?.code !== "EPERM") throw err;
      symlinkCreated = false;
    }
    if (symlinkCreated) {
      const leak = await raw("GET", `/artifacts/${dir.artifact.id}/files/leak`);
      assert(
        leak.status === 403 || leak.status === 404,
        `Symlink escape must be blocked (got ${leak.status}, body: ${leak.body.slice(0, 120)})`,
      );
      assert(!leak.body.includes("SHOULD-NOT-LEAK"), "Symlink escape leaked the target's bytes");
    }
  } finally {
    for (const id of linkedFileIds) await optionalDelete(`/artifacts/${id}`);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  // ── Template engine (project-local template) ──

  const tplRoot = tmpDir("surface-tpl-test-");
  const tplId = `tpl-test-${suffix}`;
  try {
    const tplDir = path.join(tplRoot, ".surface", "templates", "test-card");
    fs.mkdirSync(tplDir, { recursive: true });
    fs.writeFileSync(path.join(tplDir, "template.json"), JSON.stringify({
      name: "test-card",
      description: "engine test card",
      params: {
        name: { type: "string", required: true },
        notes: { type: "markdown", default: "" },
      },
      state: { stage: { type: "string", default: "init" } },
      actions: ["poke"],
    }));
    fs.writeFileSync(path.join(tplDir, "index.html"),
      "<html><head></head><body><h1>{{name}}</h1><div id=\"notes\">{{{notes}}}</div></body></html>");

    const listed = await api("GET", `/api/templates?project=${encodeURIComponent(tplRoot)}`);
    assert(listed.some((t: any) => t.name === "test-card" && t.source === "project"), "Project template not listed");

    const inst = await api("POST", "/artifacts", {
      id: tplId,
      title: "Engine Test",
      template: "test-card",
      params: { name: "<X&Y>", notes: "# Hello" },
      project_root: tplRoot,
    });
    assert(inst.artifact.template === "test-card", "Instantiated artifact missing template name");

    const tplHtml = await api("GET", `/artifacts/${tplId}/files/index.html`);
    assert(tplHtml.includes("&lt;X&amp;Y&gt;"), "{{param}} was not HTML-escaped");
    assert(tplHtml.includes("<h1 id=\"hello\">Hello</h1>"), "markdown param was not rendered server-side");
    assert(tplHtml.includes("window.__TEMPLATE_PARAMS"), "params script not injected");

    const tplState = await api("GET", `/artifacts/${tplId}/state`);
    assert(tplState.state.stage === "init", "template state default not applied");

    // Re-running with the same id re-renders with new params.
    const rerun = await api("POST", "/artifacts", {
      id: tplId,
      title: "Engine Test v2",
      template: "test-card",
      params: { name: "Second" },
      project_root: tplRoot,
    });
    assert(rerun.version.version === 2, "template re-run should create version 2");
    const tplHtml2 = await api("GET", `/artifacts/${tplId}/files/index.html`);
    assert(tplHtml2.includes("<h1>Second</h1>"), "re-render did not apply new params");

    const unknownTpl = await raw("POST", "/artifacts", { title: "x", template: "no-such-template" });
    assert(unknownTpl.status === 400, `Unknown template should 400 (got ${unknownTpl.status})`);
  } finally {
    await optionalDelete(`/artifacts/${tplId}`);
    fs.rmSync(tplRoot, { recursive: true, force: true });
  }

  // ── Built-in templates ──

  const askId = `ask-test-${suffix}`;
  const ask = await api("POST", "/artifacts", {
    id: askId,
    title: "Ship it?",
    template: "ask",
    params: { question: "Ship v2.1 to prod?", options: "ship,hold", context_md: "### Changes\n- one\n- two" },
  });
  assert(ask.artifact.template === "ask", "ask instantiation failed");
  const askState0 = await api("GET", `/artifacts/${askId}/state`);
  assert(askState0.state.status === "open", "ask should start open");
  const askHtml = await api("GET", `/artifacts/${askId}/files/index.html`);
  assert(askHtml.includes("Ship v2.1 to prod?"), "ask question missing from render");
  assert(askHtml.includes("Changes"), "ask context_md missing from render");

  // Answering flips the card server-side.
  await api("POST", `/artifacts/${askId}/actions`, { action: "answer", data: { choice: "ship", text: null } });
  const askState1 = await api("GET", `/artifacts/${askId}/state`);
  assert(askState1.state.status === "answered", "ask did not flip to answered");
  assert(askState1.state.answer.choice === "ship", "ask answer not recorded");
  assert(typeof askState1.state.answer.answered_at === "string", "answer missing answered_at");
  await optionalDelete(`/artifacts/${askId}`);

  // The global board materializes on first write, with stamped sections.
  await optionalDelete(`/artifacts/board`);
  const boardPatch = await api("PATCH", "/artifacts/board/state", {
    "test-agent": { status: "running the suite", project: "surface" },
  });
  assert(boardPatch.state["test-agent"].status === "running the suite", "board section not written");
  assert(typeof boardPatch.state["test-agent"].updated_at === "string", "board section missing server stamp");
  const boardArtifact = await api("GET", "/artifacts/board");
  assert(boardArtifact.artifact.template === "board", "board artifact not created from template");
  await optionalDelete(`/artifacts/board`);

  // video + doc instantiate
  const videoId = `video-test-${suffix}`;
  const video = await api("POST", "/artifacts", {
    id: videoId,
    title: "Video",
    template: "video",
    params: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", start: 90 },
  });
  assert(video.artifact.template === "video", "video instantiation failed");
  await optionalDelete(`/artifacts/${videoId}`);

  const docFile = path.join(tmpRoot2(), "guide.md");
  fs.writeFileSync(docFile, "# Guide\n\nHello **doc**.");
  const doc = await api("POST", "/artifacts/link", {
    path: docFile,
    title: "Guide",
    template: "doc",
    params: { toc: true },
  });
  const docView = await api("GET", `/artifacts/${doc.artifact.id}/view`);
  assert(docView.includes("__TEMPLATE_PARAMS"), "doc view did not render its template");
  assert(docView.includes("content_url"), "doc template missing content_url param");
  assert(docView.includes("/surface.js"), "doc on-the-fly render missing surface.js injection");
  await optionalDelete(`/artifacts/${doc.artifact.id}`);

  // ── Stream chunks ──

  const streamId = `stream-test-${suffix}`;
  const streamArtifact = await api("POST", "/artifacts", {
    id: streamId,
    title: "Stream Test",
    mime: "text/html",
    content: "<p>log</p>",
  });
  assert(streamArtifact.artifact.id === streamId, "stream artifact create failed");
  const ap1 = await api("POST", `/artifacts/${streamId}/append`, { content: "line one" });
  assert(ap1.appended === 1 && ap1.last_seq === 1, "first append wrong seq");
  const ap2 = await api("POST", `/artifacts/${streamId}/append`, {
    chunks: [{ kind: "text", content: "line two" }, { kind: "md", content: "### done" }],
  });
  assert(ap2.appended === 2 && ap2.last_seq === 3, "batch append wrong seq");
  const chunkDoc = await api("GET", `/artifacts/${streamId}/chunks`);
  assert(chunkDoc.chunks.length === 3, "chunk buffer should hold 3");
  assert(chunkDoc.chunks[2].kind === "md" && chunkDoc.chunks[2].content === "### done", "md chunk mangled");
  await optionalDelete(`/artifacts/${streamId}`);

  // ── Thumbnails: what the dashboard grid reads ──

  const thumbId = `artifact-test-thumb-${suffix}`;
  await api("POST", "/artifacts", {
    id: thumbId,
    title: "Thumbnail Test Surface",
    mime: "text/html",
    content: "<!doctype html><html><body><h1>thumb</h1></body></html>",
  });

  // With no cached capture the route answers with the generated cover, and the
  // card list says so — that flag is what stops the grid fetching a placeholder
  // it would replace seconds later.
  const thumbRes = await req()("GET", `/artifacts/${thumbId}/thumb`);
  assert(thumbRes.status === 200, `thumb route should answer 200, got ${thumbRes.status}`);
  const thumbType = thumbRes.headers.get("content-type") || "";
  assert(thumbType.includes("image/svg+xml"), `uncaptured thumb should be SVG, got ${thumbType}`);
  const svg = typeof thumbRes.body === "string" ? thumbRes.body : String(thumbRes.body);
  assert(svg.includes("Thumbnail Test"), "cover must carry the surface title");
  assert(!/>HTML<\/text>\s*$/.test(svg), "cover must not be a bare file-extension chip");

  // A placeholder is transient — it must never be cached like a real capture.
  const phCache = thumbRes.headers.get("cache-control") || "";
  assert(!phCache.includes("immutable"), `placeholder must not be immutable, got ${phCache}`);

  const thumbCards = await api("GET", "/artifacts");
  const thumbCard = thumbCards.find((c: any) => c.id === thumbId);
  assert(thumbCard, "thumb test surface missing from card list");
  assert(thumbCard.has_thumb === false, "has_thumb must be false before a capture exists");

  // Image artifacts always have a real preview: the route passes the bytes
  // through even with no capture on disk.
  const imgId = `artifact-test-thumb-img-${suffix}`;
  await api("POST", "/artifacts", {
    id: imgId,
    title: "Thumbnail Test Image",
    mime: "image/svg+xml",
    files: [{ path: "image.svg", mime: "image/svg+xml", content: "<svg xmlns='http://www.w3.org/2000/svg' width='8' height='8'></svg>" }],
  });
  const imgCard = (await api("GET", "/artifacts")).find((c: any) => c.id === imgId);
  assert(imgCard && imgCard.has_thumb === true, "image artifacts must report has_thumb");
  const imgThumb = await req()("GET", `/artifacts/${imgId}/thumb`);
  const imgType = imgThumb.headers.get("content-type") || "";
  assert(imgType.includes("image/svg+xml"), `image thumb should pass the bytes through, got ${imgType}`);
  assert(String(imgThumb.body).includes("<svg"), "image thumb must be the artifact's own file");

  // …and an image whose bytes have gone (a workspace half-restored, a linked
  // file deleted under us) must fall through to the cover. `res.sendFile`
  // reports a missing file asynchronously, so the route's try/catch never saw
  // it and Express's error handler answered 500 for a request that had a
  // perfectly good fallback waiting two lines below.
  const goneId = `artifact-test-thumb-gone-${suffix}`;
  await api("POST", "/artifacts", {
    id: goneId,
    title: "Vanished Image",
    mime: "image/png",
    files: [{ path: "image.png", mime: "image/png", content_base64: "iVBORw0KGgo=" }],
  });
  const goneOk = await req()("GET", `/artifacts/${goneId}/thumb`);
  assert(goneOk.status === 200, `passthrough should work before the file goes, got ${goneOk.status}`);
  assert(
    (goneOk.headers.get("content-type") || "").includes("image/png"),
    "the image's own bytes are what a present passthrough serves",
  );

  const goneFiles = path.join(dataDir, "artifacts", goneId, "versions", "1", "files");
  // Both lines below pass on a path that was never right: rmSync with
  // `force` succeeds on a file that does not exist, and the absence check then
  // agrees. Assert the file is there first, so a change to the storage layout
  // reports itself here instead of leaving the test asserting nothing.
  assert(
    fs.existsSync(path.join(goneFiles, "image.png")),
    `the fixture expects the stored file at ${goneFiles}; the storage layout moved`,
  );
  fs.rmSync(path.join(goneFiles, "image.png"), { force: true });
  assert(!fs.existsSync(path.join(goneFiles, "image.png")), "the fixture must really remove the file");

  const goneThumb = await req()("GET", `/artifacts/${goneId}/thumb`);
  assert(goneThumb.status === 200, `a missing passthrough file must fall through, not 500 (got ${goneThumb.status})`);
  assert(
    (goneThumb.headers.get("content-type") || "").includes("image/svg+xml"),
    `expected the cover, got ${goneThumb.headers.get("content-type")}`,
  );
  assert(String(goneThumb.body).includes("Vanished Image"), "the cover must carry the surface title");
  await optionalDelete(`/artifacts/${goneId}`);

  // ── an update that makes the passthrough available has to say so ──
  //
  // A card showing its own cover has `has_thumb: false` and deliberately never
  // calls the thumb route again, and `surface_updated` patches text, not the
  // preview. `enqueueThumb` returned early for a passthrough image without
  // queueing a capture OR emitting a readiness event, so a surface that BECAME
  // an image kept its cover until a full reload even though /thumb could serve
  // the picture.
  const becomesId = `artifact-test-becomes-image-${suffix}`;
  await api("POST", "/artifacts", {
    id: becomesId,
    title: "Becomes An Image",
    mime: "text/html",
    files: [{ path: "index.html", mime: "text/html", content: "<!doctype html><h1>not yet</h1>" }],
  });
  const beforeCard = (await api("GET", "/artifacts")).find((c: any) => c.id === becomesId);
  assert(beforeCard && beforeCard.has_thumb === false, "the card starts on its own cover");

  const stream = openGlobalStream();
  try {
    await sleep(150); // let the stream attach before the update that must be announced
    await api("PUT", `/artifacts/${becomesId}`, {
      mime: "image/png",
      files: [{ path: "image.png", mime: "image/png", content_base64: "iVBORw0KGgo=" }],
    });
    let ready: { event: string; data: any } | undefined;
    for (let i = 0; i < 40 && !ready; i++) {
      ready = stream.events.find((e) => e.event === "thumb_ready" && e.data?.id === becomesId);
      if (!ready) await sleep(50);
    }
    assert(ready, "becoming a passthrough image must announce thumb_ready, or the card keeps its cover");
  } finally {
    stream.close();
  }
  const afterCard = (await api("GET", "/artifacts")).find((c: any) => c.id === becomesId);
  assert(afterCard && afterCard.has_thumb === true, "…and the route really can serve it now");
  await optionalDelete(`/artifacts/${becomesId}`);

  // ── The immutable cache key must mean exactly one picture ──
  //
  // `?v=<updated_at>` buys a one-year `immutable` response, and every revision
  // used to be served from the same `<id>.png`. Right after an update the old
  // PNG was still the only file on disk, so a request carrying the NEW key was
  // answered with the OLD image — and cached under that key for a year. These
  // assertions are about the bytes, not the header: the URL has to name the
  // picture it returns.

  const thumbsPath = path.join(dataDir, "thumbs");
  fs.mkdirSync(thumbsPath, { recursive: true });
  const cacheId = `artifact-test-thumbcache-${suffix}`;
  const bytesA = Buffer.from("PNG-BYTES-REVISION-A");
  const bytesB = Buffer.from("PNG-BYTES-REVISION-B");
  const bytesC = Buffer.from("PNG-BYTES-REVISION-C");

  async function fetchThumb(version: string): Promise<{ cacheControl: string; body: Buffer }> {
    const res = await fetch(
      `${SURFACE_URL}/artifacts/${cacheId}/thumb?v=${encodeURIComponent(version)}`,
      { signal: AbortSignal.timeout(10000) },
    );
    return { cacheControl: res.headers.get("cache-control") || "", body: Buffer.from(await res.arrayBuffer()) };
  }
  async function currentArtifact(): Promise<any> {
    return (await api("GET", `/artifacts/${cacheId}`)).artifact;
  }
  function placeCapture(artifact: any, bytes: Buffer): string {
    const generation = thumbGenerationFor(artifact);
    assert(generation, "an artifact must have a thumbnail generation");
    fs.writeFileSync(path.join(thumbsPath, `${cacheId}.${generation}.png`), bytes);
    return generation!;
  }

  await api("POST", "/artifacts", {
    id: cacheId,
    title: "Cache Key Surface",
    mime: "text/html",
    content: "<!doctype html><html><body><h1>revision A</h1></body></html>",
  });
  const revA = await currentArtifact();
  const genA = placeCapture(revA, bytesA);

  // `updated_at` has one-second resolution, so its key is only safe to pin once
  // that second has closed and no further update can reuse the string.
  await sleep(2300);
  const servedA = await fetchThumb(revA.updated_at);
  assert(servedA.cacheControl.includes("immutable"), `a captured revision should cache hard, got ${servedA.cacheControl}`);
  assert(servedA.body.equals(bytesA), "the immutable response must be the revision its key names");

  // Publish a new revision. The only capture on disk is still revision A's.
  await api("PUT", `/artifacts/${cacheId}`, {
    content: "<!doctype html><html><body><h1>revision B</h1></body></html>",
  });
  const revB = await currentArtifact();
  assert(thumbGenerationFor(revB) !== genA, "a new version must be a new generation");
  await sleep(2300);
  const staleForB = await fetchThumb(revB.updated_at);
  assert(
    !staleForB.cacheControl.includes("immutable"),
    `an older capture must never be pinned under the new revision's key, got ${staleForB.cacheControl}`,
  );
  assert(staleForB.body.equals(bytesA), "…it is still shown, just on a revalidating window");

  // Now the capture for revision B lands: the same URL becomes immutable AND
  // starts resolving to revision B's bytes.
  placeCapture(revB, bytesB);
  const servedB = await fetchThumb(revB.updated_at);
  assert(servedB.cacheControl.includes("immutable"), `the captured revision should cache hard, got ${servedB.cacheControl}`);
  assert(servedB.body.equals(bytesB), "the key must now mean revision B, not the picture cached before it");

  // Rapid updates: `updated_at` is second-resolution, so two updates inside one
  // second share a key. Until that second closes, pinning it would let revision
  // C's key be claimed by a revision D nobody has photographed yet.
  await api("PUT", `/artifacts/${cacheId}`, {
    content: "<!doctype html><html><body><h1>revision C</h1></body></html>",
  });
  const revC = await currentArtifact();
  placeCapture(revC, bytesC);
  const freshC = await fetchThumb(revC.updated_at);
  assert(freshC.body.equals(bytesC), "the current capture is served immediately");
  assert(
    !freshC.cacheControl.includes("immutable"),
    `a version key whose second is still open must not be pinned, got ${freshC.cacheControl}`,
  );
  await sleep(2300);
  const settledC = await fetchThumb(revC.updated_at);
  assert(settledC.cacheControl.includes("immutable"), "once the second has closed the key is safe to pin");
  assert(settledC.body.equals(bytesC), "and it still means revision C");

  // The dashboard treats a card event as a whole card: surface_created unshifts
  // it into the list and builds a card from it, and surface_updated does the
  // same for a row it has never seen. A payload carrying only `{ id }` — which
  // is what a row deleted between the write and the broadcast used to produce —
  // becomes a titleless ghost that sits on every connected display until
  // someone reloads.
  {
    const cardStream = openGlobalStream();
    await sleep(150);
    const ghostId = `artifact-test-ghost-${suffix}`;
    await api("POST", "/artifacts", {
      id: ghostId,
      title: "Ghost check",
      files: [{ path: "index.html", content: "<h1>Ghost check</h1>", mime: "text/html" }],
    });
    await api("PUT", `/artifacts/${ghostId}`, { title: "Ghost check, renamed" });
    await sleep(400);
    cardStream.close();

    const cardEvents = cardStream.events.filter(
      (e) => e.event === "surface_created" || e.event === "surface_updated",
    );
    assert(cardEvents.length >= 2, `expected create and update events, saw ${cardEvents.length}`);
    for (const e of cardEvents) {
      assert(
        typeof e.data?.title === "string" && e.data.title.length > 0,
        `${e.event} carried no title — a stub payload renders as an empty card: ${JSON.stringify(e.data)}`,
      );
      assert(
        "has_thumb" in e.data && "preview" in e.data,
        `${e.event} must carry the same fields the card list does: ${JSON.stringify(Object.keys(e.data || {}))}`,
      );
    }
    await optionalDelete(`/artifacts/${ghostId}`);
  }

  // Deleting a surface must take every generation with it, not just one.
  await optionalDelete(`/artifacts/${cacheId}`);
  const leftBehind = fs.readdirSync(thumbsPath).filter((n) => n.startsWith(`${cacheId}.`));
  assert(leftBehind.length === 0, `deleting a surface must remove every cached capture, found ${leftBehind.join(", ")}`);

  await optionalDelete(`/artifacts/${thumbId}`);
  await optionalDelete(`/artifacts/${imgId}`);

  await optionalDelete(`/artifacts/${htmlId}`);
  await optionalDelete(`/artifacts/${mdId}`);
  await optionalDelete(`/artifacts/${binaryId}`);

  await gracefulShutdownWithWarmChrome();

  console.log("Artifact HTTP tests passed");
}

// SIGTERM with a live headless Chrome must still be an ordinary, successful
// shutdown. The thumbnailer used to install its own SIGINT/SIGTERM handlers the
// moment Chrome launched; both listeners fired and the thumbs one called
// process.exit(143) before the async HTTP close callback and closeDb() had run.
// This is a separate, short-lived server because it needs a REAL browser, which
// the rest of the suite deliberately denies itself.
async function gracefulShutdownWithWarmChrome(): Promise<void> {
  const { findChromeBin } = await import("../server/thumbs.js");
  if (!findChromeBin()) {
    console.log("  SKIP  graceful shutdown with a warm chrome (no chrome binary)");
    return;
  }
  const ports = await isolatedPorts();
  const shutdownDataDir = tmpDir("surface-artifacts-shutdown-data-");
  const base = `http://127.0.0.1:${ports.port}`;
  const child = spawnServer(ports.port, shutdownDataDir, {}, ports.contentPort);
  try {
    await waitForReady(base, "/artifacts");
    const shutdownReq = makeClient(base);
    await shutdownReq("POST", "/artifacts", {
      body: {
        id: "shutdown-warm-chrome",
        title: "Shutdown Surface",
        mime: "text/html",
        content: "<!doctype html><html><body><h1>warm</h1></body></html>",
      },
    });
    // Wait for the capture, which is what proves Chrome is actually running.
    const thumbsPath = path.join(shutdownDataDir, "thumbs");
    const captureDeadline = Date.now() + 60000;
    let captured = false;
    while (Date.now() < captureDeadline) {
      try {
        if (fs.readdirSync(thumbsPath).some((n) => n.endsWith(".png"))) { captured = true; break; }
      } catch {}
      await sleep(200);
    }
    assert(captured, "a capture must land before this can test shutting down with a warm chrome");

    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    process.kill(child.pid!, "SIGTERM");
    const code = await Promise.race([exited, sleep(15000).then(() => -1 as number | null)]);
    assert(code === 0, `SIGTERM with a warm chrome must be a clean exit, got ${code}`);

    await sleep(300);
    const scratch = fs.readdirSync(shutdownDataDir).filter((n) => n.startsWith(".chrome-"));
    assert(scratch.length === 0, `chrome's profile dir must be removed on shutdown, found ${scratch.join(", ")}`);
  } finally {
    await killServer(child, ports.port).catch(() => {});
    cleanupDir(shutdownDataDir);
  }
}

main().then(async () => {
  await cleanup();
  process.exit(0);
}).catch(async (err) => {
  console.error(err);
  await cleanup();
  process.exit(1);
});

async function cleanup() {
  await killServer(server, serverPort).catch(() => {});
  cleanupDir(dataDir);
  if (tmpRoot2Cache) cleanupDir(tmpRoot2Cache);
}
