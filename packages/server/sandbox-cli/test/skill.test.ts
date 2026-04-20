import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLS, type ToolName } from "@desk/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillContent = readFileSync(
  resolve(__dirname, "../skill.md"),
  "utf-8",
);

describe("skill.md", () => {
  const toolNames = Object.keys(TOOLS) as ToolName[];

  for (const toolName of toolNames) {
    it(`mentions tool name "${toolName}"`, () => {
      expect(skillContent).toContain(toolName);
    });
  }

  const subcommands = [
    "desk file read",
    "desk file write",
    "desk library list",
    "desk library get",
    "desk chat send-message",
    "desk chat attach-artifact",
    "desk web fetch",
  ];

  for (const sub of subcommands) {
    it(`mentions subcommand "${sub}"`, () => {
      expect(skillContent).toContain(sub);
    });
  }

  it("mentions DESK_TOOL_TOKEN", () => {
    expect(skillContent).toContain("DESK_TOOL_TOKEN");
  });

  it("mentions DESK_TOOL_SOCKET", () => {
    expect(skillContent).toContain("DESK_TOOL_SOCKET");
  });
});
