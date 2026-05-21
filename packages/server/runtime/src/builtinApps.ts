import * as fs from "node:fs/promises";
import * as fssync from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { appsHostDir } from "./mounts.js";

export const BUILTIN_APPS_MANIFEST_FILE = ".desk-apps.json";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Locates the on-disk root of the bundled @agent-desk/desk-apps source.
 *
 * Source mode (tsx / vitest, `@agent-desk/dev` export condition): the
 * caller reads from `packages/desk-apps/` directly, 3 levels up from
 * `packages/server/runtime/src/`.
 *
 * Built mode: `scripts/copy-assets.mjs` mirrors that tree into
 * `packages/server/runtime/dist/desk-apps/`, so the built runtime
 * artifact is self-contained and bundles cleanly with the desktop app.
 *
 * Returns null when neither exists — `writeBuiltinApps` then becomes a
 * no-op, so tests and bundles without the desk-apps source still boot.
 */
function bundledAppsRoot(): string | null {
  const builtPath = path.resolve(here, "desk-apps");
  if (fssync.existsSync(builtPath)) return builtPath;
  const sourcePath = path.resolve(here, "..", "..", "..", "desk-apps");
  if (fssync.existsSync(sourcePath)) return sourcePath;
  return null;
}

function isAppDirName(entry: string): boolean {
  return /^[a-z][a-z0-9-]{0,62}\.app$/.test(entry);
}

async function listBundledApps(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && isAppDirName(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function readManifest(manifestPath: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(manifestPath, "utf-8");
    const parsed = JSON.parse(raw) as { generatedBy?: unknown; directories?: unknown };
    if (parsed.generatedBy !== "Desk" || !Array.isArray(parsed.directories)) return [];
    return parsed.directories.filter(
      (entry): entry is string => typeof entry === "string" && isAppDirName(entry),
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/**
 * Mirrors every `<name>.app/` from the bundled @agent-desk/desk-apps source
 * into `${home}/.apps/`. Overwrites Desk-shipped names on every call so the
 * server-start sync is the upgrade path. Removes directories that were
 * previously Desk-managed but no longer appear in the bundle (tracked via
 * `.desk-apps.json`). User-added apps with names outside the Desk-managed
 * set are untouched.
 *
 * Called once during server startup from `api/src/main.ts`, right after
 * `writeGoalSkillFiles`.
 */
export async function writeBuiltinApps(home: string): Promise<void> {
  const appsDir = appsHostDir(home);
  await fs.mkdir(appsDir, { recursive: true });

  const bundleRoot = bundledAppsRoot();
  const nextDirs = bundleRoot ? await listBundledApps(bundleRoot) : [];
  const manifestPath = path.join(appsDir, BUILTIN_APPS_MANIFEST_FILE);
  const previousDirs = await readManifest(manifestPath);

  await Promise.all(
    previousDirs
      .filter((dir) => !nextDirs.includes(dir))
      .map((dir) => fs.rm(path.join(appsDir, dir), { recursive: true, force: true })),
  );

  if (bundleRoot) {
    await Promise.all(
      nextDirs.map(async (name) => {
        const src = path.join(bundleRoot, name);
        const dest = path.join(appsDir, name);
        // Overwrite previous contents — Desk-managed apps are not
        // user-editable; `fs.cp` with `force: true` is enough since the
        // destination is exclusively managed by Desk.
        await fs.rm(dest, { recursive: true, force: true });
        await fs.cp(src, dest, { recursive: true });
      }),
    );
  }

  await fs.writeFile(
    manifestPath,
    `${JSON.stringify({ generatedBy: "Desk", directories: nextDirs }, null, 2)}\n`,
    "utf-8",
  );
}
