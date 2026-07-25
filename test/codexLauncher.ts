import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { codexLauncherStatus, installCodexLauncher, removeCodexLauncher, routeCodexArgs } from "../bin/codexLauncher.js";
import { runCodexProxy } from "../bin/codexProxy.js";
import { writeCodexBridgeConfig } from "../shared/codexBridgeConfig.js";
import { cleanupDir, freePort, tmpDir } from "./helpers.js";

const endpoint = "ws://127.0.0.1:45678";

assert.deepEqual(
  routeCodexArgs(["resume", "calculator-surface"], endpoint),
  ["--remote", endpoint, "resume", "calculator-surface"],
  "interactive resume is attached to Surface's app-server",
);
assert.deepEqual(
  routeCodexArgs(["--version"], endpoint),
  ["--version"],
  "version checks pass through untouched",
);
assert.deepEqual(
  routeCodexArgs(["exec", "say hello"], endpoint),
  ["exec", "say hello"],
  "non-interactive commands pass through untouched",
);
assert.deepEqual(
  routeCodexArgs(["-C", "doctor", "fix the build"], endpoint),
  ["--remote", endpoint, "-C", "doctor", "fix the build"],
  "an option value that resembles a subcommand is not misclassified",
);
assert.deepEqual(
  routeCodexArgs(["--remote", "ws://127.0.0.1:9999", "resume", "x"], endpoint),
  ["--remote", "ws://127.0.0.1:9999", "resume", "x"],
  "an explicit endpoint always wins",
);
assert.deepEqual(
  routeCodexArgs(["--no-surface", "resume", "x"], endpoint),
  ["resume", "x"],
  "the escape hatch bypasses Surface and is not forwarded to Codex",
);

const temp = tmpDir("surface-codex-launcher-");
try {
  const npmBin = path.join(temp, "npm");
  const packageBin = path.join(npmBin, "node_modules", "@openai", "codex", "bin");
  const dataDir = path.join(temp, "surface-data");
  const proxySource = path.join(temp, "codex-proxy.mjs");
  fs.mkdirSync(packageBin, { recursive: true });
  const output = path.join(temp, "target-args.json");
  fs.writeFileSync(path.join(packageBin, "codex.js"), `#!/usr/bin/env node\nrequire("fs").writeFileSync(process.env.FAKE_CODEX_OUTPUT, JSON.stringify(process.argv.slice(2)));\n`);
  fs.writeFileSync(proxySource, "#!/usr/bin/env node\n");

  const originals = new Map<string, string>([
    ["codex", '#!/bin/sh\nexec node "$basedir/node_modules/@openai/codex/bin/codex.js" "$@"\n'],
    ["codex.cmd", '@ECHO off\r\nnode "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n'],
    ["codex.ps1", '& node "$basedir/node_modules/@openai/codex/bin/codex.js" $args\n'],
  ]);
  for (const [name, body] of originals) fs.writeFileSync(path.join(npmBin, name), body);

  const installed = installCodexLauncher({
    dataDir,
    launcherPath: path.join(npmBin, "codex.cmd"),
    proxySource,
    nodeBinary: process.execPath,
  });
  assert.equal(installed.changed, true);
  assert.equal(installed.launchers.length, 3, "the npm launcher triplet is covered");
  assert.equal(codexLauncherStatus(dataDir).healthy, true);
  for (const name of originals.keys()) {
    const wrapper = fs.readFileSync(path.join(npmBin, name), "utf8");
    assert.match(wrapper, /Surface Codex launcher/);
    assert.doesNotMatch(wrapper, /\$env:SURFACE_CODEX_LAUNCHER_CONFIG|SET "SURFACE_CODEX_LAUNCHER_CONFIG=/, "launcher does not pollute the user's shell environment");
  }

  fs.writeFileSync(proxySource, "#!/usr/bin/env node\n// refreshed proxy\n");
  const manifestPath = path.join(dataDir, "codex-launcher.json");
  const priorManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const priorWrapperPath = priorManifest.launchers[0].path;
  const priorWrapper = fs.readFileSync(priorWrapperPath, "utf8") + "# previous Surface wrapper revision\n";
  fs.writeFileSync(priorWrapperPath, priorWrapper);
  priorManifest.launchers[0].wrapper_sha256 = crypto.createHash("sha256").update(priorWrapper).digest("hex");
  fs.writeFileSync(manifestPath, JSON.stringify(priorManifest, null, 2) + "\n");
  assert.equal(codexLauncherStatus(dataDir).healthy, true, "a known prior Surface wrapper is still owned and repairable");
  const second = installCodexLauncher({
    dataDir,
    launcherPath: path.join(npmBin, "codex.cmd"),
    proxySource,
    nodeBinary: process.execPath,
  });
  assert.equal(second.changed, false, "setup is idempotent");
  assert.match(fs.readFileSync(path.join(dataDir, "codex-launcher", "proxy.mjs"), "utf8"), /refreshed proxy/, "setup refreshes the proxy implementation after a Surface upgrade");
  assert.doesNotMatch(fs.readFileSync(priorWrapperPath, "utf8"), /previous Surface wrapper revision/, "setup refreshes an older Surface-owned wrapper");

  const port = await freePort();
  const liveEndpoint = `ws://127.0.0.1:${port}`;
  writeCodexBridgeConfig(dataDir, {
    version: 1,
    transport: "websocket",
    endpoint: liveEndpoint,
    codex_bin: "unused-in-this-test",
    managed: true,
    updated_at: new Date().toISOString(),
  });
  const listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(port, "127.0.0.1", resolve));
  process.env.FAKE_CODEX_OUTPUT = output;
  try {
    const result = await runCodexProxy(["resume", "calculator-surface"], {
      manifestPath: path.join(dataDir, "codex-launcher.json"),
      startHost: async () => false,
    });
    assert.equal(result, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), ["--remote", liveEndpoint, "resume", "calculator-surface"]);
  } finally {
    delete process.env.FAKE_CODEX_OUTPUT;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }

  process.env.FAKE_CODEX_OUTPUT = output;
  try {
    const passThrough = await runCodexProxy(["--version"], {
      manifestPath: path.join(dataDir, "codex-launcher.json"),
      startHost: async () => false,
    });
    assert.equal(passThrough, 0, "pass-through commands do not require a live Surface host");
    assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), ["--version"]);
  } finally {
    delete process.env.FAKE_CODEX_OUTPUT;
  }

  const bundledProxy = path.resolve("dist", "codex-proxy.mjs");
  if (fs.existsSync(bundledProxy)) {
    execFileSync(process.execPath, [bundledProxy, "--version"], {
      env: {
        ...process.env,
        SURFACE_CODEX_LAUNCHER_CONFIG: path.join(dataDir, "codex-launcher.json"),
        FAKE_CODEX_OUTPUT: output,
      },
      stdio: "pipe",
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), ["--version"], "the compiled standalone proxy is executable");
  }

  const removed = removeCodexLauncher(dataDir);
  assert.equal(removed.changed, true);
  for (const [name, body] of originals) {
    assert.equal(fs.readFileSync(path.join(npmBin, name), "utf8"), body, `${name} restored byte-for-byte`);
  }
} finally {
  cleanupDir(temp);
}

const symlinkTemp = tmpDir("surface-codex-symlink-");
try {
  const binDir = path.join(symlinkTemp, "bin");
  const dataDir = path.join(symlinkTemp, "data");
  const nativeTarget = path.join(symlinkTemp, "real-codex");
  const launcher = path.join(binDir, "codex");
  const proxySource = path.join(symlinkTemp, "proxy.mjs");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(nativeTarget, "native codex bytes");
  fs.writeFileSync(proxySource, "proxy bytes");
  let symlinkAvailable = true;
  try { fs.symlinkSync(nativeTarget, launcher, "file"); } catch { symlinkAvailable = false; }
  if (symlinkAvailable) {
    installCodexLauncher({ dataDir, launcherPath: launcher, proxySource, nodeBinary: process.execPath });
    assert.equal(fs.readFileSync(nativeTarget, "utf8"), "native codex bytes", "install never writes through a package-manager symlink");
    assert.equal(fs.lstatSync(launcher).isSymbolicLink(), false, "the command slot becomes a wrapper file");
    removeCodexLauncher(dataDir);
    assert.equal(fs.lstatSync(launcher).isSymbolicLink(), true, "removal restores the original symlink");
    assert.equal(fs.realpathSync(launcher), fs.realpathSync(nativeTarget));
  }
} finally {
  cleanupDir(symlinkTemp);
}

console.log("Codex launcher tests passed");
