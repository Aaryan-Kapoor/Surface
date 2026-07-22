import { execFile } from "node:child_process";
import { assertNoLeakedTestServers } from "./helpers.js";

const suites = [
  "test:startup-access",
  "test:runtime",
  "test:cli",
  "test:app-routing",
  "test:thumbs",
  "test:auth",
  "test:content-origin",
  "test:service",
  "test:upgrade",
  "test:bindings",
  "test:codex-bridge",
  "test:codex-desktop-attendance",
  "test:codex-desktop-safety",
  "test:artifacts",
  "test:e2e",
];

function runScript(script: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    // npm's .cmd shim cannot be passed directly to execFile on Windows. When
    // this runner was itself launched by npm, invoke its JS entrypoint through
    // the current Node executable; this also keeps Unix behavior unchanged.
    const npmEntry = process.env.npm_execpath;
    const executable = npmEntry ? process.execPath : "npm";
    const args = npmEntry ? [npmEntry, "run", script] : ["run", script];
    const child = execFile(executable, args, {
      env: { ...process.env },
      maxBuffer: 20 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const code = error
        ? (typeof (error as any).code === "number" ? (error as any).code : 1)
        : 0;
      resolve({ code, output: stdout + stderr });
    });
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);
  });
}

const results: Array<{ script: string; code: number }> = [];

for (const suite of suites) {
  console.log(`\n=== ${suite} ===`);
  const result = await runScript(suite);
  results.push({ script: suite, code: result.code });
}

await assertNoLeakedTestServers();

const failed = results.filter((r) => r.code !== 0);
console.log("\n=== Test Summary ===");
for (const result of results) {
  console.log(`${result.code === 0 ? "PASS" : "FAIL"} ${result.script}`);
}
if (failed.length) {
  process.exitCode = 1;
}
