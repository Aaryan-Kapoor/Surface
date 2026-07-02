import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { cleanupDir, isolatedPorts, killServer, makeClient, REPO_ROOT, spawnServer, tmpDir, waitForReady } from "./helpers.js";

const cli = path.join(REPO_ROOT, "dist", "surface.mjs");

function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("node", [cli, ...args], { cwd: REPO_ROOT, env: { ...process.env, ...env } }, (error, stdout, stderr) => {
      resolve({ code: typeof (error as any)?.code === "number" ? (error as any).code : 0, stdout, stderr });
    });
  });
}

const unknown = await run(["ask", "Ship?", "--optoins", "yes,no"]);
assert.equal(unknown.code, 2);
assert.match(unknown.stderr, /unknown flag --optoins/);

const badTimeout = await run(["wait", "--timeout", "abc"]);
assert.equal(badTimeout.code, 2);
assert.match(badTimeout.stderr, /--timeout expects a number/);

const help = await run(["wait", "--help"]);
assert.equal(help.code, 0);
assert.match(help.stdout, /--follow/);
assert.match(help.stdout, /--heartbeat/);

const dataDir = tmpDir("surface-cli-data-");
const scratch = tmpDir("surface-cli-files-");
const ports = await isolatedPorts();
const base = `http://127.0.0.1:${ports.port}`;
const server = spawnServer(ports.port, dataDir, {}, ports.contentPort);
try {
  await waitForReady(base, "/artifacts");
  const env = { SURFACE_URL: base };
  const bytesPath = path.join(scratch, "bytes.bin");
  fs.writeFileSync(bytesPath, Buffer.from([0, 127, 128, 255]));

  const created = await run([
    "create",
    "Binary",
    "--id",
    "cli-binary",
    "--mime",
    "application/octet-stream",
    "--file",
    bytesPath,
  ], env);
  assert.equal(created.code, 0, created.stderr);

  const req = makeClient(base);
  const first = await req("GET", "/artifacts/cli-binary");
  assert.equal(first.body.files[0].path, "bytes.bin");
  assert.equal(first.body.files[0].size_bytes, 4);

  fs.writeFileSync(bytesPath, Buffer.from([1, 2, 3, 4, 5]));
  const updated = await run([
    "update",
    "cli-binary",
    "--mime",
    "application/octet-stream",
    "--file",
    bytesPath,
  ], env);
  assert.equal(updated.code, 0, updated.stderr);
  const rec = await req("GET", "/artifacts/cli-binary");
  assert.equal(rec.body.version.version, 2);
  assert.equal(rec.body.files[0].size_bytes, 5);
} finally {
  await killServer(server, ports.port).catch(() => {});
  cleanupDir(dataDir);
  cleanupDir(scratch);
}

console.log("CLI tests passed");
