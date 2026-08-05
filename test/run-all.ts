import { execFile } from "node:child_process";
import { assertNoLeakedTestServers } from "./helpers.js";

const suites = [
  "test:startup-access",
  "test:runtime",
  "test:cli",
  "test:app-routing",
  "test:source-hygiene",
  "test:client-render",
  "test:preview",
  "test:thumbs",
  "test:auth",
  "test:content-origin",
  "test:service",
  "test:upgrade",
  "test:updates",
  "test:notify",
  "test:video",
  "test:transcript",
  "test:bindings",
  "test:agent-sessions",
  "test:codex-bridge",
  "test:action-dispatch",
  "test:artifacts",
  "test:e2e",
];

// `npm` is npm.cmd on Windows, which execFile cannot spawn without a shell — it
// failed with ENOENT, and because ENOENT surfaces as a *string* error code the
// old numeric check scored it 0 and printed PASS. Every suite silently
// "passed" on Windows without running. Resolve the real binary, and treat any
// error without a numeric exit code as a failure rather than a success.
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

function runScript(script: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = execFile(NPM, ["run", script], {
      env: { ...process.env },
      maxBuffer: 20 * 1024 * 1024,
      shell: process.platform === "win32",
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
