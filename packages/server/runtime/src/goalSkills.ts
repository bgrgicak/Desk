import * as fs from "node:fs/promises";
import * as path from "node:path";
import { GOAL_KEYS, type GoalKey } from "@agent-desk/shared";
import { loadAndSub } from "./prompt.js";
import { SKILLS_SANDBOX_DIR, skillsHostDir } from "./mounts.js";
import { DESK_REFERENCE_SKILLS, type DeskSkillSpec } from "./skills.js";

const GOAL_SKILL_DESCRIPTIONS: Record<GoalKey, string> = {
  scheduled: "Use when the user wants future or recurring work: every, daily, tomorrow, at a time, cron, remind me.",
  task: "Use when the user wants to track or manage a todo, task, follow-up, due item, or work to chase.",
  app: "Use when the user wants to build or iterate on an app, tracker, dashboard, tool, or calculator.",
  site: "Use when the user wants to build or iterate on a site, website, landing page, portfolio, or page.",
  image: "Use when the user wants an image, design, logo, illustration, palette, visual, photo, or picture.",
  data: "Use when the user wants to work with data, spreadsheets, tables, CSV, metrics, numbers, charts, or graphs.",
  run: "Use when the user wants to run, check, monitor, scan, sync, automate, or watch something.",
  document: "Use when the user wants to write, draft, create, plan, brief, report, email, notes, or summarize.",
};

export const DESK_GOAL_SKILL_PREFIX = "desk-goal-";
export const DESK_SKILL_PREFIX = "desk-";
export const DESK_SKILLS_MANIFEST_FILE = ".desk-skills.json";
export const GOAL_SKILLS_SANDBOX_DIR = SKILLS_SANDBOX_DIR;
export const DESK_SKILLS_SANDBOX_DIR = SKILLS_SANDBOX_DIR;

const LEGACY_GOAL_SKILLS_MANIFEST_FILE = ".desk-goal-skills.json";

export function goalSkillName(goal: GoalKey): string {
  return `${DESK_GOAL_SKILL_PREFIX}${goal}`;
}

function goalSkillSpec(goal: GoalKey): DeskSkillSpec {
  return {
    name: goalSkillName(goal),
    description: GOAL_SKILL_DESCRIPTIONS[goal],
    metadata: { goal },
    body: () => loadAndSub(`goal/${goal}.md`, {}).trim(),
  };
}

function renderSkill(spec: DeskSkillSpec): string {
  validateSkillName(spec.name);
  validateDescription(spec.description);
  const metadata = Object.entries(spec.metadata ?? {});
  return [
    "---",
    `name: ${frontmatterScalar(spec.name)}`,
    `description: ${frontmatterScalar(spec.description)}`,
    "metadata:",
    "  source: desk",
    ...metadata.map(([key, value]) => `  ${key}: ${frontmatterScalar(value)}`),
    "---",
    "",
    spec.body().trim(),
    "",
  ].join("\n");
}

/**
 * Materializes packaged Desk reference docs as native pi skills following
 * the Agent Skills standard. The host directory is mounted read-only inside
 * the sandbox and symlinked into pi's discovery path: ~/.agents/skills.
 */
export async function writeDeskSkillFiles(home: string): Promise<void> {
  const skillsDir = skillsHostDir(home);
  await fs.mkdir(skillsDir, { recursive: true });

  const skillSpecs = [...DESK_REFERENCE_SKILLS, ...GOAL_KEYS.map(goalSkillSpec)];
  const nextDirs = skillSpecs.map((spec) => spec.name);
  const manifestPath = path.join(skillsDir, DESK_SKILLS_MANIFEST_FILE);
  const previousDirs = unique([
    ...(await readManifest(manifestPath)),
    ...(await readManifest(path.join(skillsDir, LEGACY_GOAL_SKILLS_MANIFEST_FILE))),
  ]);

  await Promise.all(
    previousDirs
      .filter((dir) => !nextDirs.includes(dir))
      .map((dir) => fs.rm(path.join(skillsDir, dir), { recursive: true, force: true })),
  );

  await Promise.all(
    skillSpecs.map(async (spec) => {
      const skillDir = path.join(skillsDir, spec.name);
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, "SKILL.md"), renderSkill(spec), "utf-8");
    }),
  );
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify({ generatedBy: "Desk", directories: nextDirs }, null, 2)}\n`,
    "utf-8",
  );
}

export const writeGoalSkillFiles = writeDeskSkillFiles;

async function readManifest(manifestPath: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(manifestPath, "utf-8");
    const parsed = JSON.parse(raw) as { generatedBy?: unknown; directories?: unknown; files?: unknown };
    const entries = Array.isArray(parsed.directories) ? parsed.directories : parsed.files;
    if (parsed.generatedBy !== "Desk" || !Array.isArray(entries)) return [];
    return entries.filter((entry): entry is string => typeof entry === "string" && isDeskSkillName(entry));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

function unique(entries: string[]): string[] {
  return [...new Set(entries)];
}

function isDeskSkillName(name: string): boolean {
  return /^desk-[a-z0-9-]+$/.test(name);
}

function validateSkillName(name: string): void {
  if (!isDeskSkillName(name)) {
    throw new Error(`Invalid Desk skill name "${name}"`);
  }
}

function validateDescription(description: string): void {
  if (description.trim() !== description || description.length === 0 || description.includes("\n")) {
    throw new Error(`Invalid Desk skill description "${description}"`);
  }
}

function frontmatterScalar(value: string): string {
  if (value.trim() !== value || value.length === 0 || value.includes("\n") || /:(\s|$)/.test(value)) {
    return JSON.stringify(value);
  }
  return value;
}
