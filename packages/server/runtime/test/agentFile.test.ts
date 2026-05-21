import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { renderAgentFile, writeAgentFile } from "../src/agentFile.js";
import { ensureLayout, ensureWorkspaceLayout, workspaceRootPath } from "@agent-desk/storage";

describe("renderAgentFile", () => {
  it("generates a plain markdown body (pi reads AGENTS.md as text, no frontmatter)", () => {
    const result = renderAgentFile({
      agentId: "agt_123",
      agentName: "Jarvis",
      model: "anthropic/claude-haiku-4-5",
      userName: "Desk",
    });

    // Header from the new renderer
    expect(result).toMatch(/^# Jarvis/);
    // The opencode-specific YAML frontmatter is gone — pi treats this
    // as plain system-prompt text and the model/permissions come from
    // CLI flags. The body still uses long `---...---` divider lines, so
    // assert the absence of frontmatter keys rather than the bare `---`.
    expect(result).not.toMatch(/^---\n[\s\S]*?\nmodel:/);
    expect(result).not.toContain("permission:");
    expect(result).not.toContain("mode: primary");

    // Identity framing
    expect(result).toContain("You are Jarvis, call me Desk.");

    // Workspace-as-home framing
    expect(result).toContain("~/ is your workspace");
    expect(result).toContain("foo.md");
    expect(result).toContain(".foo.md");
    expect(result).toContain("~/.chats/");

    // Desk reference manuals are skills, not inlined prompt text.
    expect(result).toContain("## Desk native skills");
    expect(result).toContain("desk-cli-task-schedule");
    expect(result).toContain("desk-agent task schedule");
    expect(result).not.toContain("# Desk CLI");

    expect(result).toContain("## Memory and recall");
  });

  it("renders the user's timezone in the scheduling section", () => {
    const result = renderAgentFile({
      agentId: "agt_tz",
      agentName: "Helper",
      model: "anthropic/claude-haiku-4-5",
      userName: "Desk",
      userTimezone: "America/Los_Angeles",
    });

    expect(result).toContain("America/Los_Angeles (Desk's app client)");
    expect(result).toContain("## Scheduling");
  });

  it("tells the agent to assume UTC + mention it when timezone is unknown", () => {
    const result = renderAgentFile({
      agentId: "agt_no_tz",
      agentName: "Helper",
      model: "anthropic/claude-haiku-4-5",
      userName: "Desk",
    });

    expect(result).toContain("not reported — assume UTC");
    expect(result).toContain("`desk-agent task schedule`");
    expect(result).toContain("`desk-agent task reschedule`");
    expect(result).toContain("`desk-agent task cancel`");
  });

  it("includes goal autodetection instructions by default", () => {
    const result = renderAgentFile({
      agentId: "agt_goal_detect",
      agentName: "Helper",
      model: "anthropic/claude-haiku-4-5",
      userName: "Desk",
    });

    expect(result).toContain("## Goal autodetection");
  });

  it("omits goal autodetection when includeGoalAutodetect is false", () => {
    const result = renderAgentFile({
      agentId: "agt_goal_detect",
      agentName: "Helper",
      model: "anthropic/claude-haiku-4-5",
      userName: "Desk",
      includeGoalAutodetect: false,
    });

    expect(result).not.toContain("## Goal autodetection");
  });

  it("renders the per-chat artifact paths when chatId is supplied", () => {
    const result = renderAgentFile({
      agentId: "agt_chat",
      agentName: "Helper",
      model: "anthropic/claude-haiku-4-5",
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
      model: "anthropic/claude-haiku-4-5",
      userName: "Desk",
      chatId: "cht_abc",
      runMode: "summary",
    });

    expect(result).toContain("## Chat summary");
    expect(result).toContain("Desk stores the final markdown as a `summary` message");
    expect(result).toContain("Chat summaries: ~/.chats/cht_abc/notes/");
    expect(result).not.toContain("## Your workspace");
    expect(result).not.toContain("desk-agent chat attach-artifact");
    expect(result).not.toContain("## Memory and recall");
  });

  it("omits the goal fragment when no goal is provided", () => {
    const result = renderAgentFile({
      agentId: "agt_nogoal",
      agentName: "Helper",
      model: "anthropic/claude-haiku-4-5",
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
        model: "anthropic/claude-haiku-4-5",
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
      model: "anthropic/claude-haiku-4-5",
      userName: "Desk",
    });
    expect(result).toContain("Your mandate is to help Desk accomplish their goals");
    expect(result).toContain("## Your workspace");
    expect(result).toContain("## Scheduling");
    expect(result).toContain("## Goal autodetection");
    expect(result).toContain("## Desk native skills");
    expect(result).toContain("## Memory and recall");
    expect(result).not.toContain("# Desk CLI");
    expect(result).not.toContain("### Cron quick reference");
    expect(result).not.toContain("NO_TOKEN");
  });

  it("renders goal and chat paths before the Desk skill router", () => {
    const result = renderAgentFile({
      agentId: "agt_doc",
      agentName: "Helper",
      model: "anthropic/claude-haiku-4-5",
      userName: "Desk",
      chatId: "chat-x",
      goal: "document",
    });
    expect(result).toContain("Chat artifacts:   ~/.chats/chat-x/artifacts/");
    expect(result).toContain("## User's goal: write a document");
    expect(result.indexOf("Chat artifacts:   ~/.chats/chat-x/artifacts/"))
      .toBeLessThan(result.indexOf("## User's goal: write a document"));
    expect(result.indexOf("## User's goal: write a document"))
      .toBeLessThan(result.indexOf("## Desk native skills"));
  });
});

describe("writeAgentFile", () => {
  it("writes AGENTS.md at the workspace root (pi's auto-discovered location)", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-agentfile-"));
    try {
      await ensureLayout(home);
      await ensureWorkspaceLayout(home, "ws");
      await writeAgentFile(home, "ws", {
        agentId: "agt_x",
        agentName: "Helper",
        model: "anthropic/claude-haiku-4-5",
        userName: "Desk",
      });
      const target = path.join(workspaceRootPath(home, "ws"), "AGENTS.md");
      const body = await fs.readFile(target, "utf-8");
      expect(body).toContain("# Helper");
      expect(body).toContain("You are Helper, call me Desk.");
      // No opencode-specific frontmatter leaks into the file.
      expect(body).not.toContain("model:");
      expect(body).not.toContain("permission:");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
