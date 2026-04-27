import { build } from "esbuild";
import { chmod } from "node:fs/promises";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/desk.js",
  bundle: true,
  platform: "node",
  // CJS, not ESM: the sandbox base image ships Node 18, which requires
  // `.mjs` (or a "type":"module" package.json) to load ESM `.js`. esbuild
  // rewrites our ESM source imports into requires, producing a single
  // self-contained script that runs on any Node version with `.js`.
  format: "cjs",
  target: "node18",
  conditions: ["@desk/dev"],
  banner: { js: "#!/usr/bin/env node" },
});

await chmod("dist/desk.js", 0o755);
