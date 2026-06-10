import fs from "fs";
import os from "os";
import path from "path";

const SURFACE_URL = process.env.SURFACE_URL || "http://127.0.0.1:3000";

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${SURFACE_URL}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`${method} ${path} failed ${res.status}: ${await res.text()}`);
  }
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return res.json();
  return res.text();
}

async function raw(method: string, path: string, body?: unknown): Promise<{ status: number; body: string }> {
  const res = await fetch(`${SURFACE_URL}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.text() };
}

async function optionalDelete(path: string): Promise<void> {
  try {
    await api("DELETE", path);
  } catch {}
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

let tmpRoot2Cache: string | null = null;
function tmpRoot2(): string {
  if (!tmpRoot2Cache) tmpRoot2Cache = fs.mkdtempSync(path.join(os.tmpdir(), "surface-doc-test-"));
  return tmpRoot2Cache;
}

async function main() {
  try {
    await api("GET", "/artifacts");
  } catch {
    console.error("Surface server not running. Start it with: npm run dev");
    process.exit(1);
  }

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

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "surface-link-test-"));
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
    fs.symlinkSync(secretPath, path.join(dirPath, "leak"));
    const leak = await raw("GET", `/artifacts/${dir.artifact.id}/files/leak`);
    assert(
      leak.status === 403 || leak.status === 404,
      `Symlink escape must be blocked (got ${leak.status}, body: ${leak.body.slice(0, 120)})`,
    );
    assert(!leak.body.includes("SHOULD-NOT-LEAK"), "Symlink escape leaked the target's bytes");
  } finally {
    for (const id of linkedFileIds) await optionalDelete(`/artifacts/${id}`);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  // ── Template engine (project-local template) ──

  const tplRoot = fs.mkdtempSync(path.join(os.tmpdir(), "surface-tpl-test-"));
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

  await optionalDelete(`/artifacts/${htmlId}`);
  await optionalDelete(`/artifacts/${mdId}`);

  console.log("Artifact HTTP tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
