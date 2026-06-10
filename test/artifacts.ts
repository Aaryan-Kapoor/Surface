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

  await optionalDelete(`/artifacts/${htmlId}`);
  await optionalDelete(`/artifacts/${mdId}`);

  console.log("Artifact HTTP tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
