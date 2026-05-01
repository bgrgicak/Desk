import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Sandbox skills are markdown documents that get inlined into every agent
 * definition file before OpenCode reads it. Treat them as always-on context
 * the agent should know about — usage docs for the in-sandbox `desk` CLI
 * today, more surfaces tomorrow.
 *
 * Why inline instead of mounting into a discovery path: opencode-ai (sst.dev)
 * has no "skills" concept of its own, just agent files and AGENTS.md. The
 * agent file is the one channel guaranteed to land in the model's context,
 * so that's where skills go.
 *
 * Resolution: the postbuild step (`scripts/copy-assets.mjs`) copies each
 * skill markdown next to the bundled JS — `dist/sandbox-cli-skill.md` for
 * the `sandbox-cli` package skill. We resolve to that path first so the
 * built artifact is self-contained. In source mode (running under tsx /
 * vitest with the `@agent-desk/dev` export condition), the dist copy
 * doesn't exist; fall back to the source-tree location.
 */
const SKILL_FILES: ReadonlyArray<{ built: string; source: string }> = [
  { built: "sandbox-cli-skill.md", source: "../../sandbox-cli/skill.md" },
];

const here = path.dirname(fileURLToPath(import.meta.url));

function readSkill(spec: { built: string; source: string }): string {
  const builtPath = path.resolve(here, spec.built);
  if (fs.existsSync(builtPath)) return fs.readFileSync(builtPath, "utf-8").trim();
  const sourcePath = path.resolve(here, spec.source);
  return fs.readFileSync(sourcePath, "utf-8").trim();
}

export const SKILLS_MARKDOWN: string = SKILL_FILES.map(readSkill).join("\n\n");
