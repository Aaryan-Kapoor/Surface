const SURFACE_URL = process.env.SURFACE_URL || "http://localhost:3000";

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
    await api("GET", "/surfaces");
  } catch {
    console.error("Surface server not running. Start it with: npm run dev");
    process.exit(1);
  }

  const suffix = Date.now().toString(36);
  const htmlId = `artifact-test-html-${suffix}`;
  const mdId = `artifact-test-md-${suffix}`;
  const surfaceId = `artifact-test-surface-${suffix}`;

  const html = await api("POST", "/artifacts", {
    id: htmlId,
    title: "Artifact Test HTML",
    mime: "text/html",
    content: "<!doctype html><html><body>hello</body></html>",
    metadata: { icon: "HTML", description: "artifact HTTP test" },
  });
  assert(html.artifact.id === htmlId, "HTML artifact ID mismatch");
  assert(html.version.version === 1, "HTML artifact should start at version 1");

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

  const surface = await api("POST", "/surfaces", {
    id: surfaceId,
    title: "Artifact Test Legacy Surface",
    html: "<!doctype html><html><body>legacy</body></html>",
    metadata: { icon: "HTML" },
  });
  assert(surface.id === surfaceId, "Legacy surface create failed");

  const mirrored = await api("GET", `/artifacts/${surfaceId}`);
  assert(mirrored.artifact.kind === "html", "Legacy surface did not mirror into an HTML artifact");

  const cards = await api("GET", "/surfaces");
  assert(cards.some((card: any) => card.id === htmlId && card.preview_url), "HTML artifact missing from surface cards");
  assert(cards.some((card: any) => card.id === mdId && card.artifact_mime === "text/markdown"), "Markdown artifact missing from surface cards");

  const view = await api("GET", `/artifacts/${mdId}/view`);
  assert(view.includes("Artifact Test Markdown"), "Artifact view shell missing title");

  const action = await api("POST", `/surfaces/${mdId}/actions`, {
    action: "artifact_test_action",
    data: { ok: true },
  });
  assert(action.action === "artifact_test_action", "Artifact action failed");

  await optionalDelete(`/artifacts/${htmlId}`);
  await optionalDelete(`/artifacts/${mdId}`);
  await optionalDelete(`/surfaces/${surfaceId}`);

  console.log("Artifact HTTP tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
