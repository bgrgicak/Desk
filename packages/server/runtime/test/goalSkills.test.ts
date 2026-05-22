import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { GOAL_KEYS } from "@roomy-ai/shared";
import {
  ROOMY_SKILLS_MANIFEST_FILE,
  goalSkillName,
  writeRoomySkillFiles,
} from "../src/goalSkills.js";
import { ROOMY_REFERENCE_SKILLS } from "../src/skills.js";

const REFERENCE_SKILLS = ROOMY_REFERENCE_SKILLS.map((skill) => skill.name);
const skillName = (name: string) => ROOMY_REFERENCE_SKILLS.find((skill) => skill.name === name)?.name ?? name;

describe("Roomy skills", () => {
  it("materializes Roomy reference and goal prompts into the global skills directory", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-runtime-skills-"));
    try {
      const skillsDir = path.join(home, ".skills");
      const customSkillDir = path.join(skillsDir, "custom-skill");
      await fs.mkdir(customSkillDir, { recursive: true });
      await fs.writeFile(path.join(customSkillDir, "SKILL.md"), "# User Skill\n", "utf-8");

      await writeRoomySkillFiles(home);

      expect(await fs.readFile(path.join(customSkillDir, "SKILL.md"), "utf-8"))
        .toBe("# User Skill\n");

      for (const name of [...REFERENCE_SKILLS, ...GOAL_KEYS.map(goalSkillName)]) {
        const skillDir = path.join(skillsDir, name);
        const skillPath = path.join(skillDir, "SKILL.md");
        const stat = await fs.stat(skillDir);
        const skill = await fs.readFile(skillPath, "utf-8");

        expect(stat.isDirectory()).toBe(true);
        expect(name).toMatch(/^roomy-[a-z0-9-]+$/);
        expect(skill).toContain(`name: ${name}\n`);
        expect(skill).toMatch(/description: "?(Use when|Use before)/);
        // No pi-specific compatibility marker — pi uses the
        // standard Agent Skills frontmatter (name + description).
        expect(skill).not.toContain("compatibility:");
        expect(skill).toContain("metadata:\n  source: roomy");
        expect(skill).toMatch(/^---\n[\s\S]+\n---\n\n\S/);
      }

      const scheduled = await fs.readFile(path.join(skillsDir, goalSkillName("scheduled"), "SKILL.md"), "utf-8");
      expect(scheduled).toContain("description: \"Use when the user wants future or recurring work: every");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("splits long CLI reference sections into dedicated pi skills", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-runtime-skills-"));
    try {
      await writeRoomySkillFiles(home);

      const skillsDir = path.join(home, ".skills");
      const cli = await fs.readFile(path.join(skillsDir, skillName("roomy-cli"), "SKILL.md"), "utf-8");
      const schedule = await fs.readFile(path.join(skillsDir, skillName("roomy-cli-task-schedule"), "SKILL.md"), "utf-8");
      const attach = await fs.readFile(path.join(skillsDir, skillName("roomy-cli-chat-attach-artifact"), "SKILL.md"), "utf-8");
      const convert = await fs.readFile(path.join(skillsDir, skillName("roomy-cli-file-to-markdown"), "SKILL.md"), "utf-8");
      const persistence = await fs.readFile(path.join(skillsDir, skillName("roomy-persistence"), "SKILL.md"), "utf-8");

      expect(cli).toContain("# Roomy CLI");
      expect(cli).toContain("## roomy-agent chat attach-artifact");
      expect(cli).toContain("## roomy-agent file to-markdown");
      expect(cli).toContain("## roomy-agent task schedule");

      expect(schedule).toContain("## roomy-agent task schedule");
      expect(schedule).toContain("### Cron quick reference");
      expect(schedule).toContain("### Failure modes worth knowing");
      expect(schedule).not.toContain("## roomy-agent chat attach-artifact");

      expect(attach).toContain("## roomy-agent chat attach-artifact");
      expect(attach).toContain("roomy-agent chat attach-artifact [--chat <id>]");
      expect(attach).not.toContain("## roomy-agent task schedule");

      expect(convert).toContain("## roomy-agent file to-markdown");
      expect(convert).toContain("roomy-agent file to-markdown [--output <path>]");
      expect(convert).toContain("Scanned PDFs and image-only pages");
      expect(convert).not.toContain("## roomy-agent task schedule");

      expect(persistence).toContain("# Roomy persistence playbook");
      expect(persistence).toContain("There are no ephemeral package installs");
      expect(persistence).toContain("always add the idempotent install command to");
      expect(persistence).toContain("`~/.roomyrc` immediately");
      expect(persistence).toContain("Every entry in `~/.roomyrc` must be safe to run repeatedly");
      expect(persistence).toContain("Recovery flow");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("only cleans directories listed in the Roomy manifest", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-runtime-skills-"));
    try {
      const skillsDir = path.join(home, ".skills");
      await fs.mkdir(path.join(skillsDir, "roomy-old-generated"), { recursive: true });
      await fs.mkdir(path.join(skillsDir, "custom-skill"), { recursive: true });
      await fs.writeFile(path.join(skillsDir, "roomy-old-generated", "SKILL.md"), "old generated\n", "utf-8");
      await fs.writeFile(path.join(skillsDir, "custom-skill", "SKILL.md"), "user-created\n", "utf-8");
      await fs.writeFile(
        path.join(skillsDir, ROOMY_SKILLS_MANIFEST_FILE),
        JSON.stringify({ generatedBy: "Roomy", directories: ["roomy-old-generated"] }),
        "utf-8",
      );

      await writeRoomySkillFiles(home);

      await expect(fs.stat(path.join(skillsDir, "roomy-old-generated"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(path.join(skillsDir, "custom-skill", "SKILL.md"), "utf-8"))
        .toBe("user-created\n");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
