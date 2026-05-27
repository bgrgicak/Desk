#!/usr/bin/env node
/**
 * Stage the server packages + their npm dependencies into a single
 * node_modules-style tree at packages/desktop/build-server/.
 *
 * electron-builder ships this tree as `Resources/server/` so the bundled
 * roomy-server can resolve `@roomy-ai/*` (and transitive deps like
 * busboy, croner, hash-wasm, zod, nanoid, ignore, kdbxweb,
 * @noble/hashes) via Node's standard node_modules walk.
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

const DESKTOP_ROOT = path.resolve(import.meta.dirname, "..");
const MONOREPO_ROOT = path.resolve(DESKTOP_ROOT, "..", "..");
const OUT = path.join(DESKTOP_ROOT, "build-server");
const NM = path.join(OUT, "node_modules");

const WORKSPACE_PACKAGES = [
  "api",
  "db",
  "runtime",
  "scheduler",
  "shared",
  "storage",
];

async function copyDir(src, dst) {
  await fsp.cp(src, dst, { recursive: true, filter: (s) => !s.endsWith(".map") });
}

async function main() {
  await fsp.rm(OUT, { recursive: true, force: true });
  await fsp.mkdir(OUT, { recursive: true });

  const desktopPkg = JSON.parse(
    await fsp.readFile(path.join(DESKTOP_ROOT, "package.json"), "utf-8")
  );

  // Collect every non-workspace dep across the server packages first so we
  // can drive a single npm install for the transitive tree.
  const collectedDeps = {};
  const workspacePkgs = [];
  for (const pkg of WORKSPACE_PACKAGES) {
    const src = path.join(MONOREPO_ROOT, "packages", "server", pkg);
    const pkgJson = JSON.parse(
      await fsp.readFile(path.join(src, "package.json"), "utf-8")
    );
    workspacePkgs.push({ pkg, src, pkgJson });
    for (const [name, version] of Object.entries(pkgJson.dependencies ?? {})) {
      if (name.startsWith("@roomy-ai/")) continue;
      collectedDeps[name] = version;
    }
  }

  await fsp.writeFile(
    path.join(OUT, "package.json"),
    JSON.stringify(
      {
        name: "@roomy-ai/server-bundle",
        version: desktopPkg.version,
        publishConfig: { access: "public", tag: "latest" },
        dependencies: collectedDeps,
      },
      null,
      2
    ) + "\n"
  );

  // Install transitive deps first — npm clears node_modules of anything not
  // listed in dependencies, so workspace packages have to be staged AFTER.
  execSync("npm install --omit=dev --ignore-scripts --no-audit --no-fund", {
    cwd: OUT,
    stdio: "inherit",
  });

  await fsp.mkdir(path.join(NM, "@roomy-ai"), { recursive: true });
  for (const { pkg, src, pkgJson } of workspacePkgs) {
    const dst = path.join(NM, "@roomy-ai", pkg);
    await fsp.mkdir(dst, { recursive: true });
    await fsp.writeFile(
      path.join(dst, "package.json"),
      JSON.stringify(pkgJson, null, 2) + "\n"
    );
    await copyDir(path.join(src, "dist"), path.join(dst, "dist"));

    // Asset directories the source reads via import.meta.url at runtime.
    // db reads migrations/ one level up from dist/.
    if (pkg === "db" && fs.existsSync(path.join(src, "migrations"))) {
      await copyDir(
        path.join(src, "migrations"),
        path.join(dst, "migrations")
      );
    }
  }

  console.log(
    `Staged ${WORKSPACE_PACKAGES.length} workspace packages + npm deps into ${OUT}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
