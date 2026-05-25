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
const defaultPackageRoot = join(here, "..");

export async function buildApps({
  packageRoot = defaultPackageRoot,
  uiPackageRoot = join(packageRoot, "..", "ui"),
  typecheckOnly = false,
  run = runChild,
} = {}) {
  const apps = await discoverApps(packageRoot);

  if (apps.length === 0) {
    console.log("roomy-apps: no built-in apps yet, nothing to build.");
    return;
  }

  await ensureUiBuilt(uiPackageRoot, run);

  for (const app of apps) {
    const cwd = join(packageRoot, app);
    const script = typecheckOnly ? "typecheck" : "build";
    console.log(`roomy-apps: running \`npm run ${script}\` in ${app}`);
    await run("npm", ["run", script], { cwd });
  }
}

export async function discoverApps(packageRoot = defaultPackageRoot) {
  const entries = await readdir(packageRoot);
  const apps = [];
  for (const entry of entries) {
    if (!entry.endsWith(".app")) continue;
    const s = await stat(join(packageRoot, entry));
    if (s.isDirectory()) apps.push(entry);
  }
  return apps;
}

async function ensureUiBuilt(uiPackageRoot, run) {
  if (!(await isDirectory(uiPackageRoot))) return;
  if (await hasUiBuild(uiPackageRoot)) return;
  console.log("roomy-apps: building workspace dependency @roomy-ai/ui");
  await run("npm", ["run", "build"], { cwd: uiPackageRoot });
}

async function isDirectory(filePath) {
  try {
    return (await stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

async function hasUiBuild(uiPackageRoot) {
  try {
    const [js, dts] = await Promise.all([
      stat(join(uiPackageRoot, "dist", "index.js")),
      stat(join(uiPackageRoot, "dist", "index.d.ts")),
    ]);
    return js.isFile() && dts.isFile();
  } catch {
    return false;
  }
}

function runChild(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...opts });
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`))));
    child.on("error", reject);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildApps({ typecheckOnly: process.argv.includes("--typecheck") });
}
