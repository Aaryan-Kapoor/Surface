import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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

function readState(): any {
  return JSON.parse(fs.readFileSync(path.join(dataDir, "install-state.json"), "utf8"));
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// Simulate a stale copy WE wrote (an older release's text): write the content
// and stamp its hash as skill_sha256, exactly like a previous version did.
function plantStaleCanonical(content: string): void {
  fs.writeFileSync(canonical, content);
  const p = path.join(dataDir, "install-state.json");
  const s = JSON.parse(fs.readFileSync(p, "utf8"));
  s.skill_sha256 = sha256(content);
  fs.writeFileSync(p, JSON.stringify(s, null, 2) + "\n");
}

function isLink(p: string): boolean {
  return fs.lstatSync(p).isSymbolicLink();
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
    assert.ok(isLink(link), `${link} is a symlink`);
    assert.equal(fs.readFileSync(path.join(link, "SKILL.md"), "utf8"), pkgSkill, `${link} resolves to the skill`);
  }

  // install-state.json records the canonical path and the links
  const state = readState();
  assert.equal(state.skill_saved_to, canonical);
  assert.equal(state.skill_links.length, 2);
  assert.equal(state.skill_sha256, sha256(pkgSkill), "the hash of what we wrote is stamped");
  assert.equal(state.tutorial, "pending", "fresh state file keeps the documented defaults");

  // ── idempotent: second run keeps links, changes nothing ──
  const again = await run(["skill", "install", "--json"]);
  const report2 = JSON.parse(again.stdout);
  assert.equal(report2.updated, false);
  assert.ok(report2.links.every((l: any) => l.mode === "kept"), "second run keeps existing links");

  // ── --to adds a harness dir; recorded for future refreshes ──
  const clineDir = path.join(home, ".cline", "skills");
  const clineTarget = path.join(clineDir, "surface");
  const withTo = await run(["skill", "install", "--to", clineDir, "--json"]);
  assert.equal(withTo.code, 0, withTo.stderr);
  assert.equal(fs.readFileSync(path.join(clineTarget, "SKILL.md"), "utf8"), pkgSkill);
  assert.equal(readState().skill_links.length, 3);

  // ── a foreign skill dir (extra files) is never clobbered ──
  const foreign = path.join(home, ".foreign", "skills");
  fs.mkdirSync(path.join(foreign, "surface"), { recursive: true });
  fs.writeFileSync(path.join(foreign, "surface", "SKILL.md"), "someone else's skill");
  fs.writeFileSync(path.join(foreign, "surface", "notes.txt"), "keep me");
  const refused = await run(["skill", "install", "--to", foreign, "--json"]);
  const refusedReport = JSON.parse(refused.stdout);
  const skipped = refusedReport.links.find((l: any) => l.path === path.join(foreign, "surface"));
  assert.equal(skipped.mode, "skipped");
  assert.equal(fs.readFileSync(path.join(foreign, "surface", "notes.txt"), "utf8"), "keep me");

  // ── a lone SKILL.md that is NOT a Surface skill is skipped too ──
  const stranger = path.join(home, ".stranger", "skills");
  fs.mkdirSync(path.join(stranger, "surface"), { recursive: true });
  fs.writeFileSync(path.join(stranger, "surface", "SKILL.md"), "---\nname: not-ours\n---\ncustom skill");
  const strangerRun = await run(["skill", "install", "--to", stranger, "--json"]);
  const strangerLink = JSON.parse(strangerRun.stdout).links.find((l: any) => l.path === path.join(stranger, "surface"));
  assert.equal(strangerLink.mode, "skipped", "lone non-Surface SKILL.md is not adopted");
  assert.equal(fs.readFileSync(path.join(stranger, "surface", "SKILL.md"), "utf8"), "---\nname: not-ours\n---\ncustom skill");

  // ── but a stale Surface copy (lone SKILL.md, name: surface) upgrades to a link ──
  const legacy = path.join(home, ".legacy", "skills");
  fs.mkdirSync(path.join(legacy, "surface"), { recursive: true });
  fs.writeFileSync(path.join(legacy, "surface", "SKILL.md"), "---\nname: surface\ndescription: old\n---\nold copy");
  const upgraded = await run(["skill", "install", "--to", legacy, "--json"]);
  const relinked = JSON.parse(upgraded.stdout).links.find((l: any) => l.path === path.join(legacy, "surface"));
  assert.equal(relinked.mode, "linked");
  assert.equal(fs.readFileSync(path.join(legacy, "surface", "SKILL.md"), "utf8"), pkgSkill);

  // ── a wrong symlink is repaired ──
  fs.unlinkSync(agentsLink);
  // junction on win32: dir symlinks can need elevation there (matches production linking)
  fs.symlinkSync(path.join(home, ".foreign"), agentsLink, process.platform === "win32" ? "junction" : "dir");
  const repaired = await run(["skill", "install", "--json"]);
  const repairedLink = JSON.parse(repaired.stdout).links.find((l: any) => l.path === agentsLink);
  assert.equal(repairedLink.mode, "linked", "misdirected symlink is repointed");
  assert.equal(fs.readFileSync(path.join(agentsLink, "SKILL.md"), "utf8"), pkgSkill);

  // ── --copy scope: --to targets only; other recorded targets keep their modes ──
  const copyDir = path.join(home, ".copyharness", "skills");
  const copiedTarget = path.join(copyDir, "surface");
  const copied = await run(["skill", "install", "--to", copyDir, "--copy", "--json"]);
  assert.equal(copied.code, 0, copied.stderr);
  assert.ok(!isLink(copiedTarget), "--copy creates a real directory for the --to target");
  assert.equal(fs.readFileSync(path.join(copiedTarget, "SKILL.md"), "utf8"), pkgSkill);
  assert.ok(isLink(agentsLink), "defaults are out of scope when --to is given — still links");
  assert.ok(isLink(clineTarget), "other recorded targets keep their modes");
  assert.ok(readState().skill_links.some((l: any) => l.path === copiedTarget && l.mode === "copy"), "copy recorded as copy");

  // ── --copy without --to: defaults become copies; recorded extras stay put (mixed modes) ──
  const copyDefaults = await run(["skill", "install", "--copy", "--json"]);
  assert.equal(copyDefaults.code, 0, copyDefaults.stderr);
  assert.ok(!isLink(agentsLink), "--copy converts the default targets");
  assert.ok(!isLink(claudeLink), "--copy converts the default targets");
  assert.ok(isLink(clineTarget), "recorded link outside the scope stays a link");
  assert.ok(!isLink(copiedTarget), "recorded copy stays a copy");

  // ── modes are sticky: a plain run reshapes nothing ──
  const plain = await run(["skill", "install", "--json"]);
  assert.equal(plain.code, 0, plain.stderr);
  assert.ok(!isLink(agentsLink), "plain run keeps the recorded copy mode");
  assert.ok(isLink(clineTarget), "plain run keeps the recorded link mode");

  // ── --link converts the scope back; out-of-scope copies survive ──
  const relink = await run(["skill", "install", "--link", "--json"]);
  assert.equal(relink.code, 0, relink.stderr);
  assert.ok(isLink(agentsLink), "--link converts the defaults back to links");
  assert.ok(isLink(claudeLink), "--link converts the defaults back to links");
  assert.ok(!isLink(copiedTarget), "recorded copy outside the scope stays a copy");

  // ── --copy and --link together is an error ──
  const both = await run(["skill", "install", "--copy", "--link"]);
  assert.equal(both.code, 2);

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
  const upgName = `surface-upg-test-${process.pid}`;
  plantStaleCanonical("stale skill text"); // an older release's canonical copy
  fs.writeFileSync(path.join(copiedTarget, "SKILL.md"), "stale copy"); // and a stale recorded copy
  const newer = await stubRegistry("99.0.0");
  try {
    const check2 = await run(["upgrade", "--check", "--json"], { SURFACE_NPM_REGISTRY: newer.url });
    const c2 = JSON.parse(check2.stdout);
    assert.equal(c2.update_available, true);
    assert.equal(c2.skill.fresh, false, "--check flags the sabotaged canonical copy");
    assert.equal(fs.readFileSync(canonical, "utf8"), "stale skill text", "--check changes nothing");

    // --name keeps the test away from any real "surface" service on this machine
    const up = await run(["upgrade", "--json", "--name", upgName], { SURFACE_NPM_REGISTRY: newer.url });
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

  // ── one unwritable target doesn't abort the converger ──
  const canChmod = process.platform !== "win32" && !(typeof process.getuid === "function" && process.getuid() === 0);
  if (canChmod) {
    const lockedFile = path.join(copiedTarget, "SKILL.md");
    fs.chmodSync(lockedFile, 0o444);
    plantStaleCanonical("stale again");
    const reg = await stubRegistry(pkgVersion);
    try {
      const partial = await run(["upgrade", "--json", "--name", upgName], { SURFACE_NPM_REGISTRY: reg.url });
      assert.equal(partial.code, 1, "a failed target makes upgrade exit 1");
      const p = JSON.parse(partial.stdout);
      const failed = p.skill.links.find((l: any) => l.path === copiedTarget);
      assert.equal(failed.mode, "failed", "the unwritable target is reported, not thrown");
      assert.equal(fs.readFileSync(canonical, "utf8"), pkgSkill, "canonical still converged");
      assert.ok(p.service, "the service step still ran");
      assert.ok(readState().skill_links.some((l: any) => l.path === copiedTarget && l.mode === "copy"),
        "a failed target stays recorded for the next retry");

      fs.chmodSync(lockedFile, 0o644);
      const retry = await run(["upgrade", "--json", "--name", upgName], { SURFACE_NPM_REGISTRY: reg.url });
      assert.equal(retry.code, 0, retry.stderr);
      assert.equal(fs.readFileSync(lockedFile, "utf8"), pkgSkill, "the retried target converges");
    } finally {
      reg.close();
      try {
        fs.chmodSync(lockedFile, 0o644);
      } catch {
        // already restored
      }
    }
  } else {
    console.log("  SKIP  unwritable-target isolation (chmod ineffective here)");
  }

  // ── a garbage registry version never reaches npm ──
  const evil = await stubRegistry('99.0.0"; calc.exe; "');
  try {
    const inj = await run(["upgrade", "--check"], { SURFACE_NPM_REGISTRY: evil.url });
    assert.equal(inj.code, 1);
    assert.match(inj.stderr, /invalid version/);
  } finally {
    evil.close();
  }

  // ── registry unreachable → clear failure ──
  const dead = await run(["upgrade", "--check"], { SURFACE_NPM_REGISTRY: "http://127.0.0.1:9" });
  assert.equal(dead.code, 1);
  assert.match(dead.stderr, /could not reach the npm registry/);

  // ── surface service update/upgrade redirects to the real command ──
  const redirect = await run(["service", "upgrade"]);
  assert.equal(redirect.code, 2);
  assert.match(redirect.stderr, /did you mean: surface upgrade/);

  // ── a user-edited canonical is kept, mirrored to targets, and only --force replaces it ──
  const editedSkill = pkgSkill + "\n<!-- my local tweak -->\n";
  fs.writeFileSync(canonical, editedSkill); // hash no longer matches skill_sha256
  const keep = await run(["skill", "install", "--json"]);
  assert.equal(keep.code, 0, keep.stderr);
  const keptReport = JSON.parse(keep.stdout);
  assert.equal(keptReport.edited, true, "an edited canonical is reported");
  assert.equal(fs.readFileSync(canonical, "utf8"), editedSkill, "the edit is kept");
  assert.equal(fs.readFileSync(path.join(copiedTarget, "SKILL.md"), "utf8"), editedSkill,
    "managed copies mirror the canonical, edits included");
  assert.equal(readState().skill_sha256, sha256(pkgSkill),
    "the recorded hash still names OUR content — the edit is never adopted as ours");

  const editedCheck = await stubRegistry(pkgVersion);
  try {
    const ec = await run(["upgrade", "--check", "--json"], { SURFACE_NPM_REGISTRY: editedCheck.url });
    const e = JSON.parse(ec.stdout);
    assert.equal(e.skill.fresh, false);
    assert.equal(e.skill.edited, true, "--check tells edited apart from stale");

    // upgrade keeps the edit too — it converges versions, not opinions
    const upKeep = await run(["upgrade", "--json", "--name", upgName], { SURFACE_NPM_REGISTRY: editedCheck.url });
    assert.equal(upKeep.code, 0, upKeep.stderr);
    assert.equal(JSON.parse(upKeep.stdout).skill.edited, true);
    assert.equal(fs.readFileSync(canonical, "utf8"), editedSkill, "upgrade never clobbers an edit");
  } finally {
    editedCheck.close();
  }

  // service health reports the edited state (dead port: only the skill fields matter)
  const health = await run(["service", "health", "--json", "--port", "9"]);
  assert.equal(JSON.parse(health.stdout).skill_copy_state, "edited");

  const forced = await run(["skill", "install", "--force", "--json"]);
  assert.equal(forced.code, 0, forced.stderr);
  const forcedReport = JSON.parse(forced.stdout);
  assert.equal(forcedReport.edited, false);
  assert.equal(forcedReport.updated, true, "--force replaces the edit with the packaged skill");
  assert.equal(fs.readFileSync(canonical, "utf8"), pkgSkill);
  assert.equal(fs.readFileSync(path.join(copiedTarget, "SKILL.md"), "utf8"), pkgSkill, "copies re-mirror the package");

  // ── a registered but cleanly stopped service is left stopped ──
  const systemd = process.platform === "linux" && spawnSync("systemctl", ["--user", "show-environment"], { encoding: "utf8" }).status === 0;
  if (systemd) {
    const stopName = `surface-upg-stop-${process.pid}`;
    const unitDir = path.join(home, ".config", "systemd", "user");
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(path.join(unitDir, `${stopName}.service`), "[Unit]\nDescription=surface upgrade test stub\n[Service]\nExecStart=/bin/true\n");
    const reg = await stubRegistry(pkgVersion);
    try {
      const stopped = await run(["upgrade", "--json", "--name", stopName], { SURFACE_NPM_REGISTRY: reg.url });
      assert.equal(stopped.code, 0, stopped.stderr);
      const s = JSON.parse(stopped.stdout);
      assert.equal(s.service.installed, true, "unit file counts as registered");
      assert.equal(s.service.restarted, false, "a stopped service is never started by upgrade");
      assert.equal(s.service.state, "inactive");
    } finally {
      reg.close();
    }
  } else {
    console.log("  SKIP  stopped-service guard (no user systemd session)");
  }

  // ── the skill anchors in the service's saved data dir, matching service health ──
  const altData = path.join(home, "alt-surface-data");
  const servicesDir = path.join(home, ".surface", "services");
  fs.mkdirSync(servicesDir, { recursive: true });
  fs.writeFileSync(path.join(servicesDir, "surface.json"), JSON.stringify({ dataDir: altData }) + "\n");
  try {
    const anchored = await run(["skill", "install", "--json"]);
    assert.equal(anchored.code, 0, anchored.stderr);
    const a = JSON.parse(anchored.stdout);
    assert.equal(a.canonical, path.join(altData, "skills", "surface", "SKILL.md"),
      "saved service data dir beats SURFACE_DATA_DIR, like resolveConfig");
    assert.equal(fs.readFileSync(a.canonical, "utf8"), pkgSkill);
  } finally {
    fs.rmSync(path.join(servicesDir, "surface.json"), { force: true });
  }

  console.log("Upgrade/skill tests passed");
} finally {
  cleanupDir(home);
}
