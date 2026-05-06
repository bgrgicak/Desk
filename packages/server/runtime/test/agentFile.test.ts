import { describe, it, expect } from "vitest";
import { renderAgentFile } from "../src/agentFile.js";

describe("renderAgentFile", () => {
  it("generates valid frontmatter and body", () => {
    const result = renderAgentFile({
      agentId: "agt_123",
      agentName: "Jarvis",
      model: "opencode/gpt-5-nano",
      instructions: "Help me with code reviews.",
      userName: "Desk",
    });

    // Frontmatter
    expect(result).toContain("---\n");
    expect(result).toContain("description: Jarvis");
    expect(result).toContain("model: opencode/gpt-5-nano");
    expect(result).toContain("mode: primary");

    // Identity framing
    expect(result).toContain("You are Jarvis, a coworker of Desk.");

    // Workspace-as-home framing
    expect(result).toContain("~/ is your workspace");
    // Dotfile visibility rule
    expect(result).toContain("foo.md");
    expect(result).toContain(".foo.md");
    // Per-chat artifacts
    expect(result).toContain("~/.chats/");

    // Desk reference manuals are native OpenCode skills, not inlined prompt text.
    expect(result).toContain("## Desk native skills");
    expect(result).toContain("desk-cli-task-schedule");
    expect(result).toContain("desk-cli-file-to-markdown");
    expect(result).toContain("desk-agent task schedule");
    expect(result).not.toContain("# Desk CLI");
    expect(result.indexOf("## Desk native skills")).toBeLessThan(result.indexOf("## User instructions"));

    // User instructions
    expect(result).toContain("## User instructions");
    expect(result).toContain("Help me with code reviews.");
  });

  it("handles empty instructions", () => {
    const result = renderAgentFile({
      agentId: "agt_empty",
      agentName: "Assistant",
      model: "opencode/gpt-5-nano",
      instructions: "",
      userName: "Alice",
    });

    expect(result).toContain("You are Assistant, a coworker of Alice.");
    expect(result).toContain("## User instructions");
    expect(result).toContain("(none)");
  });

  it("renders the user's timezone in the scheduling section", () => {
    const result = renderAgentFile({
      agentId: "agt_tz",
      agentName: "Helper",
      model: "opencode/gpt-5-nano",
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
      model: "opencode/gpt-5-nano",
      instructions: "",
      userName: "Desk",
    });

    expect(result).toContain("not reported — assume UTC");
    expect(result).toContain("RUN `desk-agent task schedule`");
  });

  it("includes prompt-level goal autodetection instructions", () => {
    const result = renderAgentFile({
      agentId: "agt_goal_detect",
      agentName: "Helper",
      model: "opencode/gpt-5-nano",
      instructions: "",
      userName: "Desk",
    });

    expect(result).toContain("## Goal autodetection");
    expect(result).toContain("desk-goal-<goal>");
    expect(result).toContain("native `skill` tool");
    expect(result).toContain("Do not announce the detected goal");
  });

  it("renders the per-chat artifact paths when chatId is supplied", () => {
    const result = renderAgentFile({
      agentId: "agt_chat",
      agentName: "Helper",
      model: "opencode/gpt-5-nano",
      instructions: "",
      userName: "Desk",
      chatId: "cht_abc",
    });

    expect(result).toContain("Chat artifacts:   ~/.chats/cht_abc/artifacts/");
    expect(result).toContain("Chat attachments: ~/.chats/cht_abc/attachments/");
    expect(result).toContain("Chat summaries:   ~/.chats/cht_abc/notes/");
  });

  it("renders a narrow summary-only prompt for summary runs", () => {
    const result = renderAgentFile({
      agentId: "agt_summary",
      agentName: "Helper",
      model: "opencode/gpt-5-nano",
      instructions: "",
      userName: "Desk",
      chatId: "cht_abc",
      runMode: "summary",
    });

    expect(result).toContain("## Chat summary");
    expect(result).toContain("Desk stores the final markdown as a `summary` message");
    expect(result).toContain("Chat summaries: ~/.chats/cht_abc/notes/");
    expect(result).not.toContain("## Your workspace");
    expect(result).not.toContain("desk-agent chat attach-artifact");
  });

  it("omits the goal fragment when no goal is provided", () => {
    const result = renderAgentFile({
      agentId: "agt_nogoal",
      agentName: "Helper",
      model: "opencode/gpt-5-nano",
      instructions: "",
      userName: "Desk",
    });
    expect(result).not.toContain("## User's goal:");
  });

  it("includes the matching goal fragment for each GoalKey", () => {
    const cases: Array<{ goal: "app" | "document" | "image" | "data" | "site" | "run" | "task" | "scheduled"; anchor: string }> = [
      { goal: "app", anchor: "User's goal: build an app" },
      { goal: "document", anchor: "User's goal: write a document" },
      { goal: "image", anchor: "User's goal: produce an image" },
      { goal: "data", anchor: "User's goal: work with data" },
      { goal: "site", anchor: "User's goal: build a site" },
      { goal: "run", anchor: "User's goal: run a check or automation" },
      { goal: "task", anchor: "User's goal: track a task" },
      { goal: "scheduled", anchor: "User's goal: schedule recurring or future work" },
    ];
    for (const { goal, anchor } of cases) {
      const result = renderAgentFile({
        agentId: `agt_${goal}`,
        agentName: "Helper",
        model: "opencode/gpt-5-nano",
        instructions: "",
        userName: "Desk",
        goal,
      });
      expect(result, `goal=${goal}`).toContain(anchor);
    }
  });

  it("keeps the base prompt concise when no goal or chat is set", () => {
    const result = renderAgentFile({
      agentId: "agt_baseline",
      agentName: "Helper",
      model: "opencode/gpt-5-nano",
      instructions: "Stay focused.",
      userName: "Desk",
    });
    expect(result).toContain("Your mandate is to help Desk accomplish their goals");
    expect(result).toContain("## Your workspace");
    expect(result).toContain("## Scheduling — act first, ask never");
    expect(result).toContain("## Goal autodetection");
    expect(result).toContain("## Desk native skills");
    expect(result).toContain("## User instructions");
    expect(result).toContain("Stay focused.");
    expect(result).not.toContain("# Desk CLI");
    expect(result).not.toContain("### Cron quick reference");
    expect(result).not.toContain("NO_TOKEN");
  });

  it("renders goal and chat paths before the Desk skill router", () => {
    const result = renderAgentFile({
      agentId: "agt_doc",
      agentName: "Helper",
      model: "opencode/gpt-5-nano",
      instructions: "",
      userName: "Desk",
      chatId: "chat-x",
      goal: "document",
    });
    // Spot-check the goal fragment + chat path render together.
    expect(result).toContain("Chat artifacts:   ~/.chats/chat-x/artifacts/");
    expect(result).toContain("## User's goal: write a document");
    // Ordering: artifacts (chatId) renders before goal, goal before skill router.
    expect(result.indexOf("Chat artifacts:   ~/.chats/chat-x/artifacts/"))
      .toBeLessThan(result.indexOf("## User's goal: write a document"));
    expect(result.indexOf("## User's goal: write a document"))
      .toBeLessThan(result.indexOf("## Desk native skills"));
  });
});
