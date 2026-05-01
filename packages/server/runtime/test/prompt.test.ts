import { describe, it, expect } from "vitest";
import { GOAL_KEYS } from "@agent-desk/shared";
import { loadAndSub, renderPromptBody } from "../src/prompt.js";

describe("loadAndSub", () => {
  it("substitutes {{name}} placeholders from vars", () => {
    const out = loadAndSub("mandate.md", { agentName: "Jarvis", userName: "Desk" });
    expect(out).toContain("You are Jarvis, a coworker of Desk.");
  });

  it("throws when a referenced placeholder is missing, naming the fragment", () => {
    expect(() => loadAndSub("mandate.md", {})).toThrow(/mandate\.md/);
    expect(() => loadAndSub("mandate.md", {})).toThrow(/agentName/);
  });

  it("memoizes the raw read so disk content can change without re-reads", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const target = path.resolve(here, "..", "src", "prompts", "_memo-probe.md");
    fs.writeFileSync(target, "original {{x}}", "utf-8");
    try {
      // First call seeds the cache.
      const first = loadAndSub("_memo-probe.md", { x: "A" });
      expect(first).toBe("original A");

      // Mutate the file on disk; if the loader re-reads, we'll see "changed".
      fs.writeFileSync(target, "changed {{x}}", "utf-8");
      const second = loadAndSub("_memo-probe.md", { x: "B" });
      expect(second).toBe("original B");
    } finally {
      fs.unlinkSync(target);
    }
  });
});

describe("renderPromptBody", () => {
  const baseInput = {
    agentName: "Jarvis",
    userName: "Desk",
    instructions: "",
  };

  it("orders mandate → workbench → scheduling → goal → skills → user instructions", () => {
    const body = renderPromptBody({
      ...baseInput,
      chatId: "chat-x",
      goal: "document",
      userTimezone: "America/Los_Angeles",
    });

    const idxMandate = body.indexOf("Your mandate is to help");
    const idxWorkbench = body.indexOf("## Your workspace");
    const idxScheduling = body.indexOf("## Scheduling — act first, ask never");
    const idxGoal = body.indexOf("## User's goal: write a document");
    const idxSkills = body.indexOf("# Desk CLI");
    const idxUserInstructions = body.indexOf("## User instructions");

    expect(idxMandate).toBeGreaterThanOrEqual(0);
    expect(idxWorkbench).toBeGreaterThan(idxMandate);
    expect(idxScheduling).toBeGreaterThan(idxWorkbench);
    expect(idxGoal).toBeGreaterThan(idxScheduling);
    expect(idxSkills).toBeGreaterThan(idxGoal);
    expect(idxUserInstructions).toBeGreaterThan(idxSkills);
  });

  it("workbench-known includes the chat workbench paths when chatId is set", () => {
    const body = renderPromptBody({ ...baseInput, chatId: "chat-abc" });
    expect(body).toContain("Current chat workbench: ~/.chats/chat-abc/");
    expect(body).toContain("Chat attachments: ~/.chats/chat-abc/attachments/");
    expect(body).toContain("Chat notes:       ~/.chats/chat-abc/notes/");
  });

  it("workbench-unknown is rendered when chatId is omitted, with no concrete path", () => {
    const body = renderPromptBody({ ...baseInput });
    expect(body).toContain("## Your workspace");
    expect(body).not.toContain("Current chat workbench: ~/.chats/");
  });

  it("includes timezone-known fragment when userTimezone is provided", () => {
    const body = renderPromptBody({ ...baseInput, userTimezone: "Europe/Berlin" });
    expect(body).toContain("Europe/Berlin (Desk's app client)");
  });

  it("includes timezone-unknown fragment when userTimezone is missing", () => {
    const body = renderPromptBody({ ...baseInput });
    expect(body).toContain("not reported — assume UTC");
  });

  it("omits the goal fragment when goal is null/undefined", () => {
    const body = renderPromptBody({ ...baseInput });
    expect(body).not.toContain("## User's goal:");
  });

  it("each goal fragment renders an anchor phrase identifying its goal", () => {
    const anchors: Record<string, string> = {
      app: "User's goal: build an app",
      document: "User's goal: write a document",
      image: "User's goal: produce an image",
      data: "User's goal: work with data",
      site: "User's goal: build a site",
      run: "User's goal: run a check or automation",
      task: "User's goal: track a task",
      scheduled: "User's goal: schedule recurring or future work",
    };
    for (const goal of GOAL_KEYS) {
      const body = renderPromptBody({ ...baseInput, goal });
      expect(body, `goal=${goal}`).toContain(anchors[goal]);
    }
  });

  it("renders user instructions when provided", () => {
    const body = renderPromptBody({ ...baseInput, instructions: "Be terse." });
    expect(body).toContain("## User instructions");
    expect(body).toContain("Be terse.");
  });

  it("renders (none) when instructions are empty", () => {
    const body = renderPromptBody({ ...baseInput });
    expect(body).toContain("(none)");
  });
});
