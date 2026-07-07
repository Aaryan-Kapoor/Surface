import { chmodSync } from "node:fs";
import { build } from "esbuild";

// CLI: fully self-contained single file — runs with plain node, no node_modules.
await build({
  entryPoints: ["bin/surface.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  banner: { js: "#!/usr/bin/env node" },
  outfile: "dist/surface.mjs",
});

chmodSync("dist/surface.mjs", 0o755);

// Server: bundles local TS only; npm packages (express, better-sqlite3, …) stay
// external and resolve from the installed package's node_modules. better-sqlite3
// is a native module and cannot be inlined.
await build({
  entryPoints: ["server/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  outfile: "dist/server.mjs",
});
