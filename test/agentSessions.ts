import assert from "node:assert/strict";
import { executableLooksLikeCodex } from "../server/agentSessions.js";

assert.equal(executableLooksLikeCodex("codex"), true);
assert.equal(executableLooksLikeCodex("/usr/local/bin/codex"), true);
assert.equal(executableLooksLikeCodex("codex\n"), true);
assert.equal(executableLooksLikeCodex("codex-live-stan\n"), true);
assert.equal(executableLooksLikeCodex("/Applications/Codex.app/Contents/MacOS/codex-aarch64-apple-darwin"), true);
assert.equal(executableLooksLikeCodex("C:\\tools\\codex.exe"), true);

assert.equal(executableLooksLikeCodex("/Users/aarya/.codex/bin/node"), false);
assert.equal(executableLooksLikeCodex("/opt/codex-helper/node"), false);
assert.equal(executableLooksLikeCodex("mycodex"), false);
assert.equal(executableLooksLikeCodex("codexhelper"), false);

console.log("Agent session process-name tests passed");
