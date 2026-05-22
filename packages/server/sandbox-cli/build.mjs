import { build } from "esbuild";
import { chmod } from "node:fs/promises";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/roomy.js",
  bundle: true,
  platform: "node",
  // CJS because the sandbox image copies only this file to a standalone
  // `/usr/local/lib/.../*.js` path without package.json type metadata.
  format: "cjs",
  target: "node18",
  conditions: ["@roomy-ai/dev"],
  banner: { js: "#!/usr/bin/env node" },
});

await chmod("dist/roomy.js", 0o755);
