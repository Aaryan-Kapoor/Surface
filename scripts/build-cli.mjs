import { chmodSync } from "node:fs";
import { build } from "esbuild";

await build({
  entryPoints: ["bin/surface.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  banner: { js: "#!/usr/bin/env node" },
  outfile: "dist/surface.mjs",
});

chmodSync("dist/surface.mjs", 0o755);
