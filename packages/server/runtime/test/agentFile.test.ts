import { describe, it, expect } from "vitest";
import { renderAgentFile } from "../src/agentFile.js";

describe("renderAgentFile", () => {
  it("generates valid frontmatter and body", () => {
    const result = renderAgentFile({
      agentId: "agt_123",
      agentName: "Jarvis",
      model: "anthropic/claude-sonnet-4-5",
      instructions: "Help me with code reviews.",
      userName: "Bero",
    });

    // Frontmatter
    expect(result).toContain("---\n");
    expect(result).toContain("description: Jarvis");
    expect(result).toContain("model: anthropic/claude-sonnet-4-5");
    expect(result).toContain("mode: primary");

    // Identity framing
    expect(result).toContain("You are Jarvis, a coworker of Bero.");

    // File access docs
    expect(result).toContain("/mnt/desk/files");
    expect(result).toContain("/mnt/desk/library");
    expect(result).toContain("/mnt/desk/desktop");

    // User instructions
    expect(result).toContain("## User instructions");
    expect(result).toContain("Help me with code reviews.");
  });

  it("handles empty instructions", () => {
    const result = renderAgentFile({
      agentId: "agt_empty",
      agentName: "Assistant",
      model: "anthropic/claude-haiku-4-5",
      instructions: "",
      userName: "Alice",
    });

    expect(result).toContain("You are Assistant, a coworker of Alice.");
    expect(result).toContain("## User instructions");
  });
});
