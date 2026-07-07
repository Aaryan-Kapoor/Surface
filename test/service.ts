import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  launchdLabel,
  launchdPlist,
  serverArgs,
  systemdUnit,
  windowsInstallScript,
  type ServiceConfig,
} from "../bin/service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, "..", "dist", "surface.mjs");

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    throw err;
  }
}

console.log("\n=== Service Command Tests ===\n");

// Paths with a space, a double quote, an ampersand, and a single quote —
// one hostile config exercises every backend's escaping at once.
const hostile: ServiceConfig = {
  name: "surface-test",
  node: '/opt/node bin/node "20"',
  entry: "/data/pkg & co/dist/server.mjs",
  dataDir: "/home/o'brien/.surface",
  logFile: "/home/o'brien/.surface/logs/surface-test.log",
  port: 3457,
  contentPort: 3557,
};

test("serverArgs: flags only when non-default", () => {
  const base: ServiceConfig = { ...hostile, port: 3000, contentPort: undefined };
  assert.deepEqual(serverArgs(base), [
    base.entry, "--log-file", base.logFile, "--data-dir", base.dataDir,
  ]);
  const args = serverArgs(hostile);
  assert.ok(args.includes("--port") && args.includes("3457"));
  assert.ok(args.includes("--content-port") && args.includes("3557"));
});

test("systemd unit: quoted ExecStart, restart policy, working dir", () => {
  const unit = systemdUnit(hostile);
  assert.ok(unit.includes(`ExecStart="/opt/node bin/node \\"20\\""`));
  assert.ok(unit.includes(`"/data/pkg & co/dist/server.mjs"`));
  assert.ok(unit.includes("Restart=on-failure"));
  assert.ok(unit.includes(`WorkingDirectory=/home/o'brien/.surface`));
  assert.ok(unit.includes("WantedBy=default.target"));
});

test("launchd plist: label, xml-escaped args, keepalive-on-failure", () => {
  const plist = launchdPlist(hostile);
  assert.equal(launchdLabel("surface-test"), "com.surface-display.surface-test");
  assert.ok(plist.includes("<string>com.surface-display.surface-test</string>"));
  assert.ok(plist.includes("<string>/data/pkg &amp; co/dist/server.mjs</string>"));
  assert.ok(plist.includes("<key>SuccessfulExit</key>"));
  assert.ok(plist.includes("<key>RunAtLoad</key>"));
  assert.ok(!plist.includes("pkg & co")); // raw ampersand must never survive
});

test("windows script: conhost wrapper, escaped quotes, safe task name", () => {
  const script = windowsInstallScript(hostile);
  assert.ok(script.includes("New-ScheduledTaskAction -Execute 'conhost.exe'"));
  assert.ok(script.includes('--headless \\"/opt/node bin/node'));
  assert.ok(script.includes("Register-ScheduledTask -TaskName 'surface-test'"));
  assert.ok(script.includes("-WorkingDirectory '/home/o''brien/.surface'"));
  assert.ok(script.includes("-AtLogOn"));
});

// ---------- live loop (Linux + working user systemd only) ----------

function userSystemdAvailable(): boolean {
  if (process.platform !== "linux") return false;
  const r = spawnSync("systemctl", ["--user", "show-environment"], { encoding: "utf8" });
  return r.status === 0;
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

function cli(args: string[]): { code: number; output: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { code: r.status ?? -1, output: (r.stdout || "") + (r.stderr || "") };
}

const NAME = "surface-npmtest";
const PORT = 3457;
const CONTENT_PORT = 3557;

if (!userSystemdAvailable()) {
  console.log("  SKIP  live systemd loop (no user systemd session)");
} else if (!(await portFree(PORT)) || !(await portFree(CONTENT_PORT))) {
  console.log(`  SKIP  live systemd loop (ports ${PORT}/${CONTENT_PORT} busy)`);
} else {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "surface-service-test-"));
  const common = ["--name", NAME, "--port", String(PORT), "--content-port", String(CONTENT_PORT), "--data-dir", dataDir];
  try {
    test("live: service install is health-gated and reports identity", () => {
      const r = cli(["service", "install", ...common, "--timeout", "30"]);
      assert.equal(r.code, 0, r.output);
      assert.ok(r.output.includes("installed and healthy"), r.output);
      assert.ok(r.output.includes(`:${PORT}`), r.output);
    });
    test("live: health exits 0 and reports version + content plane", () => {
      const r = cli(["service", "health", ...common, "--json"]);
      assert.equal(r.code, 0, r.output);
      const health = JSON.parse(r.output);
      assert.equal(health.ok, true);
      assert.equal(health.content_port, CONTENT_PORT);
      assert.equal(health.content_plane_ok, true);
      assert.match(health.version, /^\d+\.\d+\.\d+/);
    });
    test("live: status reports registered + running", () => {
      const r = cli(["service", "status", ...common]);
      assert.equal(r.code, 0, r.output);
      assert.ok(r.output.includes("registered : yes"), r.output);
    });
    test("live: logs captured the startup banner", () => {
      const r = cli(["service", "logs", ...common]);
      assert.equal(r.code, 0, r.output);
      assert.ok(r.output.includes("Surface server running"), r.output);
      assert.ok(r.output.includes("content origin"), r.output);
    });
    test("live: restart waits for health again", () => {
      const r = cli(["service", "restart", ...common, "--timeout", "30"]);
      assert.equal(r.code, 0, r.output);
      assert.ok(r.output.includes("restarted"), r.output);
    });
    test("live: install onto a foreign server refuses instead of clobbering", () => {
      // Same port, different service name, unregistered: must refuse.
      const r = cli(["service", "install", "--name", `${NAME}-other`, "--port", String(PORT), "--data-dir", dataDir]);
      assert.equal(r.code, 1, r.output);
      assert.ok(r.output.includes("already answering"), r.output);
    });
    test("live: uninstall stops the server and health then fails", () => {
      const r = cli(["service", "uninstall", ...common]);
      assert.equal(r.code, 0, r.output);
      const health = cli(["service", "health", ...common]);
      assert.equal(health.code, 1, health.output);
      const status = cli(["service", "status", ...common]);
      assert.equal(status.code, 1, status.output);
      assert.ok(status.output.includes("registered : no"), status.output);
    });
  } finally {
    // Belt and braces: never leave the unit or the tmp dir behind.
    cli(["service", "uninstall", ...common]);
    try {
      execFileSync("systemctl", ["--user", "reset-failed", `${NAME}.service`], { stdio: "ignore" });
    } catch {
      // unit never failed — nothing to reset
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

console.log("\nservice tests complete");
