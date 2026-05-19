#!/usr/bin/env node
// Postbuild step: copy markdown assets that the runtime reads at runtime
// next to the bundled JS so the built artifact is self-contained.
//
// - `src/prompts/**` → `dist/prompts/**`  (read by `prompt.ts`)
// - `../sandbox-cli/skill.md` → `dist/sandbox-cli-skill.md`  (materialized as Desk skills)
// - `../../app-scaffold/AGENTS.md` → `dist/app-scaffold-agents.md`  (the desk-app-scaffold skill body)
// - `src/app-storage-skill.md` → `dist/app-storage-skill.md`  (the desk-app-storage skill body)
// - `src/skills/persistence.md` → `dist/persistence-skill.md`  (the desk-persistence skill body)
//
// Source-mode (tsx / vitest with the `@agent-desk/dev` export condition)
// reads these files from `src/` and `../sandbox-cli/` directly; the dist
// copies exist only for shipped builds.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.resolve(here, "..");

function copyTree(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyTree(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

// Mirror src/prompts/ → dist/prompts/ exactly. Removing the destination first
// keeps dist in sync with renames/deletes — without this, a renamed fragment
// would leave its stale predecessor in dist forever.
const promptsSrc = path.join(runtimeRoot, "src", "prompts");
const promptsDest = path.join(runtimeRoot, "dist", "prompts");
fs.rmSync(promptsDest, { recursive: true, force: true });
copyTree(promptsSrc, promptsDest);

const skillSrc = path.resolve(runtimeRoot, "..", "sandbox-cli", "skill.md");
const skillDest = path.join(runtimeRoot, "dist", "sandbox-cli-skill.md");
fs.mkdirSync(path.dirname(skillDest), { recursive: true });
fs.copyFileSync(skillSrc, skillDest);

const scaffoldGuideSrc = path.resolve(runtimeRoot, "..", "..", "app-scaffold", "AGENTS.md");
const scaffoldGuideDest = path.join(runtimeRoot, "dist", "app-scaffold-agents.md");
fs.mkdirSync(path.dirname(scaffoldGuideDest), { recursive: true });
fs.copyFileSync(scaffoldGuideSrc, scaffoldGuideDest);

const appStorageSkillSrc = path.join(runtimeRoot, "src", "app-storage-skill.md");
const appStorageSkillDest = path.join(runtimeRoot, "dist", "app-storage-skill.md");
fs.mkdirSync(path.dirname(appStorageSkillDest), { recursive: true });
fs.copyFileSync(appStorageSkillSrc, appStorageSkillDest);

const persistenceSkillSrc = path.join(runtimeRoot, "src", "skills", "persistence.md");
const persistenceSkillDest = path.join(runtimeRoot, "dist", "persistence-skill.md");
fs.mkdirSync(path.dirname(persistenceSkillDest), { recursive: true });
fs.copyFileSync(persistenceSkillSrc, persistenceSkillDest);

// Mirror the @agent-desk/desk-apps source tree into dist/desk-apps/ so the
// built runtime artifact is self-contained. `writeBuiltinApps` reads from
// this location in built mode (and from the workspace path in source mode).
const deskAppsSrc = path.resolve(runtimeRoot, "..", "..", "desk-apps");
const deskAppsDest = path.join(runtimeRoot, "dist", "desk-apps");
fs.rmSync(deskAppsDest, { recursive: true, force: true });
if (fs.existsSync(deskAppsSrc)) {
  // Only copy `*.app/` directories — skip package.json, scripts/, README.
  for (const entry of fs.readdirSync(deskAppsSrc)) {
    if (!entry.endsWith(".app")) continue;
    const entryStat = fs.statSync(path.join(deskAppsSrc, entry));
    if (!entryStat.isDirectory()) continue;
    copyTree(path.join(deskAppsSrc, entry), path.join(deskAppsDest, entry));
  }
}
