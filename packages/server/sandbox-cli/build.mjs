import { build } from "esbuild";
import { chmod } from "node:fs/promises";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/desk.js",
  bundle: true,
  platform: "node",
  // CJS because the sandbox image copies only this file to a standalone
  // `/usr/local/lib/.../*.js` path without package.json type metadata.
  format: "cjs",
  target: "node18",
  conditions: ["@agent-desk/dev"],
  banner: { js: "#!/usr/bin/env node" },
});

await chmod("dist/desk.js", 0o755);
