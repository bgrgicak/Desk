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
 * Adding a skill: drop a markdown file somewhere sensible (typically in the
 * package that owns the surface it documents) and reference it here. Each
 * skill file is responsible for its own headings; this module only joins
 * them with blank lines.
 *
 * Resolution: paths are relative to *this file* and walk back through the
 * monorepo layout. After tsc emits to `runtime/dist/`, the same relative
 * walk lands on the same source files because the workspace tree is
 * preserved on the host. If we ever ship as a packaged tarball that drops
 * the source tree, switch to a build-time copy step that lands the
 * markdown next to the bundled JS.
 */
const SKILL_FILES: readonly string[] = [
  "../../sandbox-cli/skill.md",
];

const here = path.dirname(fileURLToPath(import.meta.url));

export const SKILLS_MARKDOWN: string = SKILL_FILES
  .map((rel) => fs.readFileSync(path.resolve(here, rel), "utf-8").trim())
  .join("\n\n");
