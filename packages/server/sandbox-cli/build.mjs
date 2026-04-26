import { build } from "esbuild";
import { chmod } from "node:fs/promises";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/desk.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  // Resolve workspace deps via the `@desk/dev` export condition so
  // esbuild picks up their TS source directly. Without this it follows
  // the default `import` condition (e.g. @desk/shared/dist/index.js),
  // which only exists after a separate `tsc` build — fine locally once
  // anyone has built the package, broken on fresh CI checkouts where
  // `npm ci` does not run package build scripts.
  conditions: ["@desk/dev"],
  banner: { js: "#!/usr/bin/env node" },
});

await chmod("dist/desk.js", 0o755);
