import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface RoomySkillSpec {
  name: string;
  description: string;
  metadata?: Record<string, string>;
  body: () => string;
}

export const ROOMY_CLI_SKILL_NAME = "roomy-cli";
export const ROOMY_TASK_SCHEDULE_SKILL_NAME = "roomy-cli-task-schedule";
export const ROOMY_CHAT_ATTACH_ARTIFACT_SKILL_NAME = "roomy-cli-chat-attach-artifact";
export const ROOMY_CHAT_SEARCH_MESSAGES_SKILL_NAME = "roomy-cli-chat-search-messages";
export const ROOMY_FIND_LIBRARY_SKILL_NAME = "roomy-cli-find-library";
export const ROOMY_FILE_TO_MARKDOWN_SKILL_NAME = "roomy-cli-file-to-markdown";
export const ROOMY_APP_SCAFFOLD_SKILL_NAME = "roomy-app-scaffold";
export const ROOMY_APP_STORAGE_SKILL_NAME = "roomy-app-storage";
export const ROOMY_PERSISTENCE_SKILL_NAME = "roomy-persistence";
const CLI_SKILL_FILE = {
  built: "sandbox-cli-skill.md",
  source: "../../sandbox-cli/skill.md",
} as const;

const APP_SCAFFOLD_AGENTS_FILE = {
  built: "app-scaffold-agents.md",
  source: "../../../app-scaffold/AGENTS.md",
} as const;

const APP_STORAGE_SKILL_FILE = {
  built: "app-storage-skill.md",
  source: "app-storage-skill.md",
} as const;

const PERSISTENCE_SKILL_FILE = {
  built: "persistence-skill.md",
  source: "skills/persistence.md",
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
    throw new Error(`Missing heading "${heading}" in Roomy CLI skill source`);
  }
  const next = markdown.indexOf("\n## ", start + heading.length);
  return markdown.slice(start, next === -1 ? undefined : next).trim();
}

function taskScheduleReference(): string {
  return [
    "# Roomy task scheduling reference",
    "",
    extractSection(readCliManual(), "## roomy-agent task schedule"),
  ].join("\n");
}

function chatAttachArtifactReference(): string {
  return [
    "# Roomy chat artifact attachment reference",
    "",
    extractSection(readCliManual(), "## roomy-agent chat attach-artifact"),
  ].join("\n");
}

function chatSearchMessagesReference(): string {
  return [
    "# Roomy chat-message search reference",
    "",
    extractSection(readCliManual(), "## roomy-agent chat search-messages"),
  ].join("\n");
}

function findLibraryReference(): string {
  return [
    "# Roomy library discovery reference",
    "",
    extractSection(readCliManual(), "## roomy-agent find library"),
  ].join("\n");
}

function fileToMarkdownReference(): string {
  return [
    "# Roomy document conversion reference",
    "",
    extractSection(readCliManual(), "## roomy-agent file to-markdown"),
  ].join("\n");
}

function readAppScaffoldGuide(): string {
  return readSkill(APP_SCAFFOLD_AGENTS_FILE);
}

function readAppStorageGuide(): string {
  return readSkill(APP_STORAGE_SKILL_FILE);
}

function readPersistenceGuide(): string {
  return readSkill(PERSISTENCE_SKILL_FILE);
}

export const ROOMY_REFERENCE_SKILLS: ReadonlyArray<RoomySkillSpec> = [
  {
    name: ROOMY_CLI_SKILL_NAME,
    description:
      "Use when the agent needs the full Roomy CLI command manual, including command selection, environment, output, syntax, examples, and failure modes.",
    body: readCliManual,
  },
  {
    name: ROOMY_TASK_SCHEDULE_SKILL_NAME,
    description:
      "Use when the agent needs syntax, examples, cron reference, or failure modes for scheduling Roomy tasks.",
    body: taskScheduleReference,
  },
  {
    name: ROOMY_CHAT_ATTACH_ARTIFACT_SKILL_NAME,
    description:
      "Use when the agent needs syntax or examples for surfacing generated artifacts in Roomy chat.",
    body: chatAttachArtifactReference,
  },
  {
    name: ROOMY_CHAT_SEARCH_MESSAGES_SKILL_NAME,
    description:
      "Use when the agent needs to recall something the user mentioned in another chat, earlier in this chat (before the latest summary), or across the workspace's history. Full-text search over messages and chat summaries.",
    body: chatSearchMessagesReference,
  },
  {
    name: ROOMY_FIND_LIBRARY_SKILL_NAME,
    description:
      "Use before answering whether a reusable library item exists, or before building a new app, fragment, note, or doc, to discover existing library items and their params_schema.",
    body: findLibraryReference,
  },
  {
    name: ROOMY_FILE_TO_MARKDOWN_SKILL_NAME,
    description:
      "Use when the agent needs syntax, supported formats, or examples for converting documents to Markdown/text.",
    body: fileToMarkdownReference,
  },
  {
    name: ROOMY_APP_SCAFFOLD_SKILL_NAME,
    description:
      "Use when authoring or modifying a Roomy app: scaffold layout, fragments, build workflow, capability rules, and the static-only constraint.",
    body: readAppScaffoldGuide,
  },
  {
    name: ROOMY_APP_STORAGE_SKILL_NAME,
    description:
      "Use when inspecting, importing, exporting, migrating, repairing, or doing CRUD against an existing Roomy app's stored records.",
    body: readAppStorageGuide,
  },
  {
    name: ROOMY_PERSISTENCE_SKILL_NAME,
    description:
      "Use when making sandbox installs or configuration persist across restarts with ~/.roomyrc.",
    body: readPersistenceGuide,
  },
];
