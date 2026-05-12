import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { renderAgentFile, chatNeedsBrowser, writePiSystemFile, writeWorkspaceMcpConfig } from "../src/agentFile.js";
import { ensureLayout, ensureWorkspaceLayout, workspaceRootPath } from "@agent-desk/storage";

describe("renderAgentFile", () => {
  it("generates valid frontmatter and body", () => {
    const result = renderAgentFile({
      agentId: "agt_123",
      agentName: "Jarvis",
      model: "opencode/big-pickle",
      userName: "Desk",
    });

    // Frontmatter
    expect(result).toContain("---\n");
    expect(result).toContain("description: Jarvis");
    expect(result).toContain("model: opencode/big-pickle");
    expect(result).toContain("mode: primary");

    // Identity framing
    expect(result).toContain("You are Jarvis, call me Desk.");

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

    // Memory rules section is present (P1.3/P1.4).
    expect(result).toContain("## Memory and recall");
  });

  it("renders the user's timezone in the scheduling section", () => {
    const result = renderAgentFile({
      agentId: "agt_tz",
      agentName: "Helper",
      model: "opencode/big-pickle",
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
      model: "opencode/big-pickle",
      userName: "Desk",
    });

    expect(result).toContain("not reported — assume UTC");
    expect(result).toContain("run `desk-agent task schedule`");
  });

  it("includes goal autodetection instructions by default", () => {
    const result = renderAgentFile({
      agentId: "agt_goal_detect",
      agentName: "Helper",
      model: "opencode/big-pickle",
      userName: "Desk",
    });

    expect(result).toContain("## Goal autodetection");
  });

  it("omits goal autodetection when includeGoalAutodetect is false", () => {
    const result = renderAgentFile({
      agentId: "agt_goal_detect",
      agentName: "Helper",
      model: "opencode/big-pickle",
      userName: "Desk",
      includeGoalAutodetect: false,
    });

    expect(result).not.toContain("## Goal autodetection");
  });

  it("renders the per-chat artifact paths when chatId is supplied", () => {
    const result = renderAgentFile({
      agentId: "agt_chat",
      agentName: "Helper",
      model: "opencode/big-pickle",
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
      model: "opencode/big-pickle",
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
      model: "opencode/big-pickle",
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
        model: "opencode/big-pickle",
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
      model: "opencode/big-pickle",
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
      model: "opencode/big-pickle",
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

describe("chatNeedsBrowser", () => {
  it("enables browser only for site/app goals", () => {
    expect(chatNeedsBrowser("site")).toBe(true);
    expect(chatNeedsBrowser("app")).toBe(true);
    // Conservative on purpose: a `document` chat that occasionally needs the
    // browser still doesn't get firefox preloaded; the user can flip it on
    // explicitly. Anything else returns false.
    expect(chatNeedsBrowser("document")).toBe(false);
    expect(chatNeedsBrowser("data")).toBe(false);
    expect(chatNeedsBrowser(null)).toBe(false);
    expect(chatNeedsBrowser(undefined)).toBe(false);
  });
});

describe("writePiSystemFile", () => {
  it("can write a per-run system prompt file to avoid concurrent-run races", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-pi-system-"));
    try {
      await ensureLayout(home);
      await ensureWorkspaceLayout(home, "pi-ws");
      const filePath = await writePiSystemFile(home, "pi-ws", {
        agentId: "agt_pi",
        agentName: "Helper",
        model: "openrouter/anthropic/claude-sonnet-4.5",
        userName: "Desk",
      }, { fileName: "SYSTEM-run_pi_1.md" });
      expect(filePath).toBe(path.join(workspaceRootPath(home, "pi-ws"), ".pi", "SYSTEM-run_pi_1.md"));
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toContain("You are Helper, call me Desk.");
      expect(content).not.toContain("model: openrouter/anthropic/claude-sonnet-4.5");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});

describe("writeWorkspaceMcpConfig", () => {
  it("writes playwright with enabled=true when the chat needs a browser", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-mcp-cfg-"));
    try {
      await ensureLayout(home);
      await ensureWorkspaceLayout(home, "mcp-ws");
      await writeWorkspaceMcpConfig(home, "mcp-ws", { enablePlaywright: true });
      const cfg = JSON.parse(
        await fs.readFile(path.join(workspaceRootPath(home, "mcp-ws"), ".opencode", "opencode.json"), "utf-8"),
      );
      expect(cfg.mcp.playwright.enabled).toBe(true);
      expect(cfg.mcp.playwright.command).toEqual(["playwright-mcp", "--browser", "firefox"]);
      const piCfg = JSON.parse(
        await fs.readFile(path.join(workspaceRootPath(home, "mcp-ws"), ".pi", "mcp.json"), "utf-8"),
      );
      expect(piCfg.mcpServers.playwright.command).toBe("playwright-mcp");
      expect(piCfg.mcpServers.playwright.args).toEqual(["--browser", "firefox"]);
      expect(piCfg.mcpServers.playwright.lifecycle).toBe("lazy");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("writes playwright with enabled=false otherwise, so an older image with playwright in the global config doesn't keep firefox alive", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-mcp-cfg-"));
    try {
      await ensureLayout(home);
      await ensureWorkspaceLayout(home, "mcp-ws");
      await writeWorkspaceMcpConfig(home, "mcp-ws", { enablePlaywright: false });
      const cfg = JSON.parse(
        await fs.readFile(path.join(workspaceRootPath(home, "mcp-ws"), ".opencode", "opencode.json"), "utf-8"),
      );
      // The key still has to be present — `mcp: {}` would let a global
      // `playwright.enabled=true` win the merge and keep firefox running.
      expect(cfg.mcp.playwright).toBeDefined();
      expect(cfg.mcp.playwright.enabled).toBe(false);
      const piCfg = JSON.parse(
        await fs.readFile(path.join(workspaceRootPath(home, "mcp-ws"), ".pi", "mcp.json"), "utf-8"),
      );
      expect(piCfg.mcpServers).toEqual({});
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
