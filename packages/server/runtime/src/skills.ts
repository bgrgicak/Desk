import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface DeskSkillSpec {
  name: string;
  description: string;
  metadata?: Record<string, string>;
  body: () => string;
}

export const DESK_CLI_SKILL_NAME = "desk-cli";
export const DESK_TASK_SCHEDULE_SKILL_NAME = "desk-cli-task-schedule";
export const DESK_CHAT_ATTACH_ARTIFACT_SKILL_NAME = "desk-cli-chat-attach-artifact";

const CLI_SKILL_FILE = {
  built: "sandbox-cli-skill.md",
  source: "../../sandbox-cli/skill.md",
} as const;

const here = path.dirname(fileURLToPath(import.meta.url));

function readSkill(spec: { built: string; source: string }): string {
  const builtPath = path.resolve(here, spec.built);
  if (fs.existsSync(builtPath)) return fs.readFileSync(builtPath, "utf-8").trim();
  const sourcePath = path.resolve(here, spec.source);
  return fs.readFileSync(sourcePath, "utf-8").trim();
}

function readCliManual(): string {
  return readSkill(CLI_SKILL_FILE);
}

function extractSection(markdown: string, heading: string): string {
  const start = markdown.indexOf(heading);
  if (start === -1) {
    throw new Error(`Missing heading "${heading}" in Desk CLI skill source`);
  }
  const next = markdown.indexOf("\n## ", start + heading.length);
  return markdown.slice(start, next === -1 ? undefined : next).trim();
}

function taskScheduleReference(): string {
  return [
    "# Desk task scheduling reference",
    "",
    extractSection(readCliManual(), "## desk-agent task schedule"),
  ].join("\n");
}

function chatAttachArtifactReference(): string {
  return [
    "# Desk chat artifact attachment reference",
    "",
    extractSection(readCliManual(), "## desk-agent chat attach-artifact"),
  ].join("\n");
}

export const DESK_REFERENCE_SKILLS: ReadonlyArray<DeskSkillSpec> = [
  {
    name: DESK_CLI_SKILL_NAME,
    description:
      "Use when the agent needs the full Desk CLI command manual, including command selection, environment, output, syntax, examples, and failure modes.",
    body: readCliManual,
  },
  {
    name: DESK_TASK_SCHEDULE_SKILL_NAME,
    description:
      "Use when the agent needs syntax, examples, cron reference, or failure modes for scheduling Desk tasks.",
    body: taskScheduleReference,
  },
  {
    name: DESK_CHAT_ATTACH_ARTIFACT_SKILL_NAME,
    description:
      "Use when the agent needs syntax or examples for surfacing generated artifacts in Desk chat.",
    body: chatAttachArtifactReference,
  },
];
