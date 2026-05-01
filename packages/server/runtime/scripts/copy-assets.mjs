#!/usr/bin/env node
// Postbuild step: copy markdown assets that the runtime reads at runtime
// next to the bundled JS so the built artifact is self-contained.
//
// - `src/prompts/**` → `dist/prompts/**`  (read by `prompt.ts`)
// - `../sandbox-cli/skill.md` → `dist/sandbox-cli-skill.md`  (read by `skills.ts`)
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

const promptsSrc = path.join(runtimeRoot, "src", "prompts");
const promptsDest = path.join(runtimeRoot, "dist", "prompts");
copyTree(promptsSrc, promptsDest);

const skillSrc = path.resolve(runtimeRoot, "..", "sandbox-cli", "skill.md");
const skillDest = path.join(runtimeRoot, "dist", "sandbox-cli-skill.md");
fs.mkdirSync(path.dirname(skillDest), { recursive: true });
fs.copyFileSync(skillSrc, skillDest);
