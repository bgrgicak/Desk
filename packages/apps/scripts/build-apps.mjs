#!/usr/bin/env node
/**
 * Iterates every `*.app/` directory in this package and runs its build (or
 * typecheck). Mirrors `npm run build` inside each app dir, so the same
 * commands work when promoting an app from a workspace into this package.
 *
 * v0: this is a no-op when no apps are present yet; we ship apps one at a
 * time as the dogfood produces them.
 */
import { readdir, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const typecheckOnly = process.argv.includes("--typecheck");

const entries = await readdir(packageRoot);
const apps = [];
for (const entry of entries) {
  if (!entry.endsWith(".app")) continue;
  const s = await stat(join(packageRoot, entry));
  if (s.isDirectory()) apps.push(entry);
}

if (apps.length === 0) {
  console.log("roomy-apps: no built-in apps yet, nothing to build.");
  process.exit(0);
}

for (const app of apps) {
  const cwd = join(packageRoot, app);
  const script = typecheckOnly ? "typecheck" : "build";
  console.log(`roomy-apps: running \`npm run ${script}\` in ${app}`);
  await runChild("npm", ["run", script], { cwd });
}

function runChild(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...opts });
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`))));
    child.on("error", reject);
  });
}
