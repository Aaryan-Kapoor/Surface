import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { cleanupDir, REPO_ROOT, tmpDir } from "./helpers.js";

const cli = path.join(REPO_ROOT, "dist", "surface.mjs");
const pkgSkill = fs.readFileSync(path.join(REPO_ROOT, "SKILL.md"), "utf8");
const pkgVersion = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).version as string;

const home = tmpDir("surface-upgrade-home-");
const dataDir = path.join(home, ".surface");
const baseEnv = {
  HOME: home,
  USERPROFILE: home,
  SURFACE_DATA_DIR: dataDir,
};

function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("node", [cli, ...args], { cwd: REPO_ROOT, env: { ...process.env, ...baseEnv, ...env } }, (error, stdout, stderr) => {
      resolve({ code: typeof (error as any)?.code === "number" ? (error as any).code : 0, stdout, stderr });
    });
  });
}

function stubRegistry(version: string): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/surface-display/latest") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ name: "surface-display", version }));
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => server.close() });
    });
  });
}

const canonical = path.join(dataDir, "skills", "surface", "SKILL.md");
const agentsLink = path.join(home, ".agents", "skills", "surface");
const claudeLink = path.join(home, ".claude", "skills", "surface");

try {
  // ── skill install: canonical copy + default links ──
  const install = await run(["skill", "install", "--json"]);
  assert.equal(install.code, 0, install.stderr);
  const report = JSON.parse(install.stdout);
  assert.equal(report.canonical, canonical);
  assert.equal(fs.readFileSync(canonical, "utf8"), pkgSkill, "canonical copy matches the package SKILL.md");
  for (const link of [agentsLink, claudeLink]) {
    assert.ok(fs.lstatSync(link).isSymbolicLink(), `${link} is a symlink`);
    assert.equal(fs.readFileSync(path.join(link, "SKILL.md"), "utf8"), pkgSkill, `${link} resolves to the skill`);
  }

  // install-state.json records the canonical path and the links
  const state = JSON.parse(fs.readFileSync(path.join(dataDir, "install-state.json"), "utf8"));
  assert.equal(state.skill_saved_to, canonical);
  assert.equal(state.skill_links.length, 2);
  assert.equal(state.tutorial, "pending", "fresh state file keeps the documented defaults");

  // ── idempotent: second run keeps links, changes nothing ──
  const again = await run(["skill", "install", "--json"]);
  const report2 = JSON.parse(again.stdout);
  assert.equal(report2.updated, false);
  assert.ok(report2.links.every((l: any) => l.mode === "kept"), "second run keeps existing links");

  // ── --to adds a harness dir; recorded for future refreshes ──
  const clineDir = path.join(home, ".cline", "skills");
  const withTo = await run(["skill", "install", "--to", clineDir, "--json"]);
  assert.equal(withTo.code, 0, withTo.stderr);
  assert.equal(fs.readFileSync(path.join(clineDir, "surface", "SKILL.md"), "utf8"), pkgSkill);
  const state2 = JSON.parse(fs.readFileSync(path.join(dataDir, "install-state.json"), "utf8"));
  assert.equal(state2.skill_links.length, 3);

  // ── a foreign skill dir is never clobbered ──
  const foreign = path.join(home, ".foreign", "skills");
  fs.mkdirSync(path.join(foreign, "surface"), { recursive: true });
  fs.writeFileSync(path.join(foreign, "surface", "SKILL.md"), "someone else's skill");
  fs.writeFileSync(path.join(foreign, "surface", "notes.txt"), "keep me");
  const refused = await run(["skill", "install", "--to", foreign, "--json"]);
  const refusedReport = JSON.parse(refused.stdout);
  const skipped = refusedReport.links.find((l: any) => l.path === path.join(foreign, "surface"));
  assert.equal(skipped.mode, "skipped");
  assert.equal(fs.readFileSync(path.join(foreign, "surface", "notes.txt"), "utf8"), "keep me");

  // ── but a stale plain copy (only SKILL.md inside) is upgraded to a link ──
  const legacy = path.join(home, ".legacy", "skills");
  fs.mkdirSync(path.join(legacy, "surface"), { recursive: true });
  fs.writeFileSync(path.join(legacy, "surface", "SKILL.md"), "old copy");
  const upgraded = await run(["skill", "install", "--to", legacy, "--json"]);
  const upgradedReport = JSON.parse(upgraded.stdout);
  const relinked = upgradedReport.links.find((l: any) => l.path === path.join(legacy, "surface"));
  assert.equal(relinked.mode, "linked");
  assert.equal(fs.readFileSync(path.join(legacy, "surface", "SKILL.md"), "utf8"), pkgSkill);

  // ── --copy forces managed copies instead of links (all targets in the run) ──
  const copyDir = path.join(home, ".copyharness", "skills");
  const copied = await run(["skill", "install", "--to", copyDir, "--copy", "--json"]);
  assert.equal(copied.code, 0, copied.stderr);
  const copiedTarget = path.join(copyDir, "surface");
  assert.ok(!fs.lstatSync(copiedTarget).isSymbolicLink(), "copy mode creates a real directory");
  assert.equal(fs.readFileSync(path.join(copiedTarget, "SKILL.md"), "utf8"), pkgSkill);
  assert.ok(!fs.lstatSync(agentsLink).isSymbolicLink(), "--copy converges default targets to copies too");
  const state3 = JSON.parse(fs.readFileSync(path.join(dataDir, "install-state.json"), "utf8"));
  assert.ok(state3.skill_links.some((l: any) => l.path === copiedTarget && l.mode === "copy"), "copy recorded as copy");

  // ── and a plain run converges defaults back to links (copies hold their recorded mode) ──
  const relink = await run(["skill", "install", "--json"]);
  assert.equal(relink.code, 0, relink.stderr);
  assert.ok(fs.lstatSync(agentsLink).isSymbolicLink(), "plain install converges defaults back to links");
  assert.ok(!fs.lstatSync(copiedTarget).isSymbolicLink(), "recorded copy target stays a copy");

  // ── a wrong symlink is repaired ──
  fs.unlinkSync(agentsLink);
  fs.symlinkSync(path.join(home, ".foreign"), agentsLink, "dir");
  const repaired = await run(["skill", "install", "--json"]);
  const repairedLink = JSON.parse(repaired.stdout).links.find((l: any) => l.path === agentsLink);
  assert.equal(repairedLink.mode, "linked", "misdirected symlink is repointed");
  assert.equal(fs.readFileSync(path.join(agentsLink, "SKILL.md"), "utf8"), pkgSkill);

  // ── upgrade --check against a stub registry ──
  const same = await stubRegistry(pkgVersion);
  try {
    const check = await run(["upgrade", "--check", "--json"], { SURFACE_NPM_REGISTRY: same.url });
    assert.equal(check.code, 0, check.stderr);
    const c = JSON.parse(check.stdout);
    assert.equal(c.update_available, false);
    assert.equal(c.context, "dev", "repo clone is detected as a dev install");
    assert.equal(c.skill.fresh, true);
  } finally {
    same.close();
  }

  // ── upgrade with a newer release: dev context skips npm but still converges ──
  fs.writeFileSync(canonical, "stale skill text"); // sabotage the canonical copy
  fs.writeFileSync(path.join(copiedTarget, "SKILL.md"), "stale copy"); // and a recorded copy
  const newer = await stubRegistry("99.0.0");
  try {
    const check2 = await run(["upgrade", "--check", "--json"], { SURFACE_NPM_REGISTRY: newer.url });
    const c2 = JSON.parse(check2.stdout);
    assert.equal(c2.update_available, true);
    assert.equal(c2.skill.fresh, false, "--check flags the sabotaged canonical copy");
    assert.equal(fs.readFileSync(canonical, "utf8"), "stale skill text", "--check changes nothing");

    // --name keeps the test away from any real "surface" service on this machine
    const up = await run(["upgrade", "--json", "--name", `surface-upg-test-${process.pid}`], { SURFACE_NPM_REGISTRY: newer.url });
    assert.equal(up.code, 0, up.stderr);
    const u = JSON.parse(up.stdout);
    assert.equal(u.package, "skipped (dev install)");
    assert.equal(u.skill.updated, true, "stale canonical copy was refreshed");
    assert.equal(fs.readFileSync(canonical, "utf8"), pkgSkill);
    assert.equal(fs.readFileSync(path.join(copiedTarget, "SKILL.md"), "utf8"), pkgSkill, "recorded copies are refreshed by upgrade");
    assert.equal(u.service.installed, false, "no service registered in the sandbox");
  } finally {
    newer.close();
  }

  // ── registry unreachable → clear failure ──
  const dead = await run(["upgrade", "--check"], { SURFACE_NPM_REGISTRY: "http://127.0.0.1:9" });
  assert.equal(dead.code, 1);
  assert.match(dead.stderr, /could not reach the npm registry/);

  // ── surface service update/upgrade redirects to the real command ──
  const redirect = await run(["service", "upgrade"]);
  assert.equal(redirect.code, 2);
  assert.match(redirect.stderr, /did you mean: surface upgrade/);

  console.log("Upgrade/skill tests passed");
} finally {
  cleanupDir(home);
}
