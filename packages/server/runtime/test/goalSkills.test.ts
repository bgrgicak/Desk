import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { GOAL_KEYS } from "@agent-desk/shared";
import {
  DESK_SKILLS_MANIFEST_FILE,
  goalSkillName,
  writeDeskSkillFiles,
} from "../src/goalSkills.js";
import {
  DESK_CHAT_ATTACH_ARTIFACT_SKILL_NAME,
  DESK_CLI_SKILL_NAME,
  DESK_FILE_TO_MARKDOWN_SKILL_NAME,
  DESK_PERSISTENCE_SKILL_NAME,
  DESK_TASK_SCHEDULE_SKILL_NAME,
} from "../src/skills.js";

const REFERENCE_SKILLS = [
  DESK_CLI_SKILL_NAME,
  DESK_TASK_SCHEDULE_SKILL_NAME,
  DESK_CHAT_ATTACH_ARTIFACT_SKILL_NAME,
  DESK_FILE_TO_MARKDOWN_SKILL_NAME,
  DESK_PERSISTENCE_SKILL_NAME,
] as const;

describe("Desk skills", () => {
  it("materializes Desk reference and goal prompts into the global skills directory", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-runtime-skills-"));
    try {
      const skillsDir = path.join(home, ".skills");
      const customSkillDir = path.join(skillsDir, "custom-skill");
      await fs.mkdir(customSkillDir, { recursive: true });
      await fs.writeFile(path.join(customSkillDir, "SKILL.md"), "# User Skill\n", "utf-8");

      await writeDeskSkillFiles(home);

      expect(await fs.readFile(path.join(customSkillDir, "SKILL.md"), "utf-8"))
        .toBe("# User Skill\n");

      for (const name of [...REFERENCE_SKILLS, ...GOAL_KEYS.map(goalSkillName)]) {
        const skillDir = path.join(skillsDir, name);
        const skillPath = path.join(skillDir, "SKILL.md");
        const stat = await fs.stat(skillDir);
        const skill = await fs.readFile(skillPath, "utf-8");

        expect(stat.isDirectory()).toBe(true);
        expect(name).toMatch(/^desk-[a-z0-9-]+$/);
        expect(skill).toContain(`name: ${name}\n`);
        expect(skill).toMatch(/description: "?Use when/);
        expect(skill).toContain("compatibility: opencode");
        expect(skill).toContain("metadata:\n  source: desk");
        expect(skill).toMatch(/^---\n[\s\S]+\n---\n\n\S/);
      }

      const scheduled = await fs.readFile(path.join(skillsDir, goalSkillName("scheduled"), "SKILL.md"), "utf-8");
      expect(scheduled).toContain("description: \"Use when the user wants future or recurring work: every");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("splits long CLI reference sections into dedicated OpenCode skills", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-runtime-skills-"));
    try {
      await writeDeskSkillFiles(home);

      const skillsDir = path.join(home, ".skills");
      const cli = await fs.readFile(path.join(skillsDir, DESK_CLI_SKILL_NAME, "SKILL.md"), "utf-8");
      const schedule = await fs.readFile(path.join(skillsDir, DESK_TASK_SCHEDULE_SKILL_NAME, "SKILL.md"), "utf-8");
      const attach = await fs.readFile(path.join(skillsDir, DESK_CHAT_ATTACH_ARTIFACT_SKILL_NAME, "SKILL.md"), "utf-8");
      const convert = await fs.readFile(path.join(skillsDir, DESK_FILE_TO_MARKDOWN_SKILL_NAME, "SKILL.md"), "utf-8");
      const persistence = await fs.readFile(path.join(skillsDir, DESK_PERSISTENCE_SKILL_NAME, "SKILL.md"), "utf-8");

      expect(cli).toContain("# Desk CLI");
      expect(cli).toContain("## desk-agent chat attach-artifact");
      expect(cli).toContain("## desk-agent file to-markdown");
      expect(cli).toContain("## desk-agent task schedule");

      expect(schedule).toContain("## desk-agent task schedule");
      expect(schedule).toContain("### Cron quick reference");
      expect(schedule).toContain("### Failure modes worth knowing");
      expect(schedule).not.toContain("## desk-agent chat attach-artifact");

      expect(attach).toContain("## desk-agent chat attach-artifact");
      expect(attach).toContain("desk-agent chat attach-artifact --chat <id>");
      expect(attach).not.toContain("## desk-agent task schedule");

      expect(convert).toContain("## desk-agent file to-markdown");
      expect(convert).toContain("desk-agent file to-markdown [--output <path>]");
      expect(convert).toContain("Scanned PDFs and image-only pages");
      expect(convert).not.toContain("## desk-agent task schedule");

      expect(persistence).toContain("# Desk persistence playbook");
      expect(persistence).toContain("There are no ephemeral package installs");
      expect(persistence).toContain("always add the idempotent install command to");
      expect(persistence).toContain("`~/.deskrc` immediately");
      expect(persistence).toContain("Every entry in `~/.deskrc` must be safe to run repeatedly");
      expect(persistence).toContain("Recovery flow");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("only cleans directories listed in the Desk manifest", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-runtime-skills-"));
    try {
      const skillsDir = path.join(home, ".skills");
      await fs.mkdir(path.join(skillsDir, "desk-old-generated"), { recursive: true });
      await fs.mkdir(path.join(skillsDir, "custom-skill"), { recursive: true });
      await fs.writeFile(path.join(skillsDir, "desk-old-generated", "SKILL.md"), "old generated\n", "utf-8");
      await fs.writeFile(path.join(skillsDir, "custom-skill", "SKILL.md"), "user-created\n", "utf-8");
      await fs.writeFile(
        path.join(skillsDir, DESK_SKILLS_MANIFEST_FILE),
        JSON.stringify({ generatedBy: "Desk", directories: ["desk-old-generated"] }),
        "utf-8",
      );

      await writeDeskSkillFiles(home);

      await expect(fs.stat(path.join(skillsDir, "desk-old-generated"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(path.join(skillsDir, "custom-skill", "SKILL.md"), "utf-8"))
        .toBe("user-created\n");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
