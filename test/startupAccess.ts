import assert from "node:assert/strict";
import {
  buildHostedPairingUrl,
  buildPairingUrl,
  formatHeadlessAccessOutput,
  renderTerminalQrCode,
  resolveConnectionHost,
  resolveConnectionString,
  resolveListeningPort,
} from "../server/startupAccess.js";

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    throw err;
  }
}

console.log("\n=== Startup Access Tests ===\n");

test("uses localhost when no bind host is configured", () => {
  assert.equal(resolveConnectionHost(undefined), "localhost");
  assert.equal(resolveConnectionString(undefined, 3000), "http://localhost:3000");
});

test("keeps explicit bind hosts", () => {
  assert.equal(resolveConnectionString("127.0.0.1", 3000), "http://127.0.0.1:3000");
  assert.equal(resolveConnectionString("::1", 3000), "http://[::1]:3000");
});

test("resolves wildcard hosts to an external interface", () => {
  assert.equal(
    resolveConnectionHost("0.0.0.0", {
      lo: [{ address: "127.0.0.1", family: "IPv4", internal: true } as any],
      eth0: [{ address: "192.168.1.42", family: "IPv4", internal: false } as any],
    }),
    "192.168.1.42",
  );
});

test("uses the bound port when available", () => {
  assert.equal(resolveListeningPort({ port: 4123 } as any, 3000), 4123);
  assert.equal(resolveListeningPort("pipe", 3000), 3000);
  assert.equal(resolveListeningPort(null, 3000), 3000);
});

test("builds direct pairing URLs with token in the hash", () => {
  assert.equal(buildPairingUrl("http://192.168.1.42:3000", "PAIRCODE"), "http://192.168.1.42:3000/pair#token=PAIRCODE");
});

test("builds hosted pairing URLs with host in query and token in hash", () => {
  assert.equal(
    buildHostedPairingUrl("https://surface.example", "https://backend.example:3000", "PAIRCODE"),
    "https://surface.example/pair?host=https%3A%2F%2Fbackend.example%3A3000#token=PAIRCODE",
  );
});

test("renders terminal QR codes", () => {
  const qr = renderTerminalQrCode("http://192.168.1.42:3000/pair#token=PAIRCODE");
  assert.match(qr, /[█▀▄]/);
  assert.ok(qr.split("\n").length > 10);
});

test("formats headless access output", () => {
  const output = formatHeadlessAccessOutput({
    connectionString: "http://192.168.1.42:3000",
    token: "PAIRCODE",
    pairingUrl: "http://192.168.1.42:3000/pair#token=PAIRCODE",
  });
  assert.match(output, /Connection string: http:\/\/192\.168\.1\.42:3000/);
  assert.match(output, /Token: PAIRCODE/);
  assert.match(output, /Pairing URL: http:\/\/192\.168\.1\.42:3000\/pair#token=PAIRCODE/);
  assert.match(output, /[█▀▄]/);
});

console.log("\n=== startup access tests passed ===\n");
