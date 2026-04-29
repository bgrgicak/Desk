import { describe, it, expect } from "vitest";
import { renderAgentFile } from "../src/agentFile.js";

describe("renderAgentFile", () => {
  it("generates valid frontmatter and body", () => {
    const result = renderAgentFile({
      agentId: "agt_123",
      agentName: "Jarvis",
      model: "anthropic/claude-sonnet-4-5",
      instructions: "Help me with code reviews.",
      userName: "Desk",
    });

    // Frontmatter
    expect(result).toContain("---\n");
    expect(result).toContain("description: Jarvis");
    expect(result).toContain("model: anthropic/claude-sonnet-4-5");
    expect(result).toContain("mode: primary");

    // Identity framing
    expect(result).toContain("You are Jarvis, a coworker of Desk.");

    // Workspace-as-home framing
    expect(result).toContain("~/ is your workspace");
    // Dotfile visibility rule
    expect(result).toContain("foo.md");
    expect(result).toContain(".foo.md");
    // Per-chat workbench
    expect(result).toContain("~/.chats/");

    // Inlined skills — desk-cli skill must appear before the user
    // instructions section so OpenCode sees it as always-on context.
    expect(result).toContain("# Desk CLI");
    expect(result).toContain("desk task schedule");
    expect(result.indexOf("# Desk CLI")).toBeLessThan(result.indexOf("## User instructions"));

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

  it("renders the user's timezone in the scheduling section", () => {
    const result = renderAgentFile({
      agentId: "agt_tz",
      agentName: "Helper",
      model: "anthropic/claude-sonnet-4-5",
      instructions: "",
      userName: "Desk",
      userTimezone: "America/Los_Angeles",
    });

    expect(result).toContain("America/Los_Angeles (Desk's app client)");
    expect(result).toContain("## Scheduling — act first, ask never");
  });

  it("tells the agent to assume UTC + mention it when timezone is unknown", () => {
    const result = renderAgentFile({
      agentId: "agt_no_tz",
      agentName: "Helper",
      model: "anthropic/claude-sonnet-4-5",
      instructions: "",
      userName: "Desk",
    });

    expect(result).toContain("not reported — assume UTC");
    expect(result).toContain("RUN `desk task schedule`");
  });
});
