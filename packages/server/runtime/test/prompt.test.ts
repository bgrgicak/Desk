import { describe, it, expect } from "vitest";
import { GOAL_KEYS } from "@agent-desk/shared";
import { loadAndSub, renderPromptBody } from "../src/prompt.js";
import { DESK_REFERENCE_SKILLS } from "../src/skills.js";

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

  it("orders mandate → artifacts → context → scheduling → goal autodetect → goal → Desk skill router → user instructions", () => {
    const body = renderPromptBody({
      ...baseInput,
      chatId: "chat-x",
      goal: "document",
      userTimezone: "America/Los_Angeles",
    });

    const idxMandate = body.indexOf("Your mandate is to help");
    const idxArtifacts = body.indexOf("## Your workspace");
    const idxContext = body.indexOf("## Building task context");
    const idxScheduling = body.indexOf("## Scheduling — act first, ask never");
    const idxGoalAutodetect = body.indexOf("## Goal autodetection");
    const idxGoal = body.indexOf("## User's goal: write a document");
    const idxSkills = body.indexOf("## Desk native skills");
    const idxUserInstructions = body.indexOf("## User instructions");

    expect(idxMandate).toBeGreaterThanOrEqual(0);
    expect(idxArtifacts).toBeGreaterThan(idxMandate);
    expect(idxContext).toBeGreaterThan(idxArtifacts);
    expect(idxScheduling).toBeGreaterThan(idxContext);
    expect(idxGoalAutodetect).toBeGreaterThan(idxScheduling);
    expect(idxGoal).toBeGreaterThan(idxGoalAutodetect);
    expect(idxSkills).toBeGreaterThan(idxGoal);
    expect(idxUserInstructions).toBeGreaterThan(idxSkills);
  });

  it("does not inline the long Desk CLI manual", () => {
    const body = renderPromptBody({ ...baseInput, chatId: "chat-x" });
    expect(body).toContain("## Desk native skills");
    expect(body).toContain("desk-cli-task-schedule");
    expect(body).toContain("desk-cli-chat-attach-artifact");
    expect(body).toContain("desk-app-storage");
    expect(body).toContain("load `desk-app-storage` before touching");
    expect(body).not.toContain("# Desk CLI");
    expect(body).not.toContain("### Cron quick reference");
    expect(body).not.toContain("NO_TOKEN");
  });

  it("includes goal autodetection even when no persisted goal is set", () => {
    const body = renderPromptBody({ ...baseInput });
    expect(body).toContain("## Goal autodetection");
    expect(body).toContain("desk-goal-<goal>");
    expect(body).toContain("native `skill` tool");
    expect(body).toContain("Do not announce the detected goal");
  });

  it("makes an explicit persisted goal authoritative over autodetection", () => {
    const body = renderPromptBody({ ...baseInput, goal: "site" });
    expect(body).toContain("If this prompt includes a persisted user-goal section");
    expect(body).toContain("treat that as the\n   loaded goal skill for the chat");
    expect(body).toContain("## User's goal: build a site");
  });

  it("artifacts fragment includes the chat paths when chatId is set", () => {
    const body = renderPromptBody({ ...baseInput, chatId: "chat-abc" });
    expect(body).toContain("Chat artifacts:   ~/.chats/chat-abc/artifacts/");
    expect(body).toContain("Chat attachments: ~/.chats/chat-abc/attachments/");
    expect(body).toContain("Chat summaries:   ~/.chats/chat-abc/notes/");
  });

  it("artifacts fragment omits the chat paths when chatId is missing", () => {
    const body = renderPromptBody({ ...baseInput });
    expect(body).toContain("## Your workspace");
    expect(body).not.toContain("Chat artifacts:");
  });

  it("artifacts fragment includes attach-artifact instruction when chatId is set", () => {
    const body = renderPromptBody({ ...baseInput, chatId: "chat-xyz" });
    expect(body).toContain('desk-agent chat attach-artifact --chat chat-xyz "<path>"');
    expect(body).toContain("as the last step of any turn");
    expect(body).toContain("no exceptions for type");
    expect(body).toContain("pass the directory path");
    expect(body).toContain("Do not reply to the user until the attach command has been executed");
    expect(body).toContain("If the command fails, report the error inline instead of silently skipping");
    expect(body).toContain("Quote the path.");
    expect(body).toContain("desk-cli-chat-attach-artifact");
    expect(body).toContain("chat-xyz");
  });

  it("artifacts fragment omits attach-artifact instruction when chatId is missing", () => {
    const body = renderPromptBody({ ...baseInput });
    expect(body).not.toContain("Always run `desk-agent chat attach-artifact");
  });

  it("summary mode uses summary-only instructions and omits artifact workflow", () => {
    const body = renderPromptBody({ ...baseInput, chatId: "chat-abc", runMode: "summary", goal: "document" });

    expect(body).toContain("## Chat summary");
    expect(body).toContain("Do not write `chat-summary.md`");
    expect(body).toContain("# Chat Summary — <short descriptive title>");
    expect(body).toContain("## Conversation arc");
    expect(body).toContain("## Open threads");
    expect(body).toContain("Chat summaries: ~/.chats/chat-abc/notes/");
    expect(body).toContain("Chat artifacts:  ~/.chats/chat-abc/artifacts/");
    expect(body).not.toContain("## Your workspace");
    expect(body).not.toContain("Save before replying");
    expect(body).not.toContain("desk-agent chat attach-artifact");
    expect(body).not.toContain("## Scheduling");
    expect(body).not.toContain("## Goal autodetection");
    expect(body).not.toContain("## User's goal:");
    expect(body).not.toContain("## Desk native skills");
  });

  it("artifacts fragment enumerates artifacts/ and attachments/ but not notes/ when asking about files", () => {
    const body = renderPromptBody({ ...baseInput, chatId: "chat-abc" });
    const start = body.indexOf("what files you can see");
    const end = body.indexOf("don't guess.", start) + "don't guess.".length;
    const visibilitySentence = body.slice(start, end);
    expect(visibilitySentence).toContain("artifacts/");
    expect(visibilitySentence).toContain("attachments/");
    expect(visibilitySentence).not.toContain("notes/");
  });

  it("frames task context as conditional and prioritized", () => {
    const body = renderPromptBody({ ...baseInput, chatId: "chat-abc" });

    expect(body).toContain("Use only the context needed to do the task well.");
    expect(body).toContain("When you need more context, prefer sources in this order:");
    expect(body).toContain("This is a priority order, not\na requirement to load every source.");
    expect(body).toContain("Don't scan attachments, artifacts, or ~/\neagerly");
    expect(body).toContain("If the user says they pasted, shared, or provided something earlier");
    expect(body).toContain("checked the visible transcript context you already received");

    const idxChat = body.indexOf("1. The current chat conversation");
    const idxCurrentAttachment = body.indexOf("2. File attached to the current message");
    const idxChatAttachments = body.indexOf("3. Other attachments in attachments/ for this chat");
    const idxArtifacts = body.indexOf("4. Prior outputs in artifacts/ for this chat");
    const idxHome = body.indexOf("5. Files elsewhere under ~/ only when the task still needs more local context");

    expect(idxChat).toBeGreaterThanOrEqual(0);
    expect(idxCurrentAttachment).toBeGreaterThan(idxChat);
    expect(idxChatAttachments).toBeGreaterThan(idxCurrentAttachment);
    expect(idxArtifacts).toBeGreaterThan(idxChatAttachments);
    expect(idxHome).toBeGreaterThan(idxArtifacts);
  });

  it("guides ask-vs-act decisions", () => {
    const body = renderPromptBody({ ...baseInput, chatId: "chat-abc" });

    expect(body).toContain("Ask for feedback or clarification only when a missing choice would materially");
    expect(body).toContain("Otherwise choose a reasonable\ndefault, act, and state the assumption briefly.");
  });

  it("guides Library-file fallback when attachment symlinks are broken", () => {
    const body = renderPromptBody({ ...baseInput, chatId: "chat-abc" });

    expect(body).toContain("When the user names a Library file, the Library is `~/`.");
    expect(body).toContain("try the\nLibrary file with the same basename");
    expect(body).toContain("not missing user context");
  });

  it("includes timezone-known fragment when userTimezone is provided", () => {
    const body = renderPromptBody({ ...baseInput, userTimezone: "Europe/Berlin" });
    expect(body).toContain("Europe/Berlin (Desk's app client)");
    expect(body).toContain("desk-cli-task-schedule");
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

  it("the `app` goal points the agent at the scaffold + fragment composition", () => {
    // PR-A added the desk-app-scaffold flow; PR-D pushed the goal toward
    // multi-fragment composition. Pin the load-bearing pieces of that
    // prompt so a future tweak doesn't quietly drop the agent into the
    // single-HTML-file pattern PR-A replaced.
    const body = renderPromptBody({ ...baseInput, goal: "app" });
    expect(body).toContain("desk-agent app create");
    expect(body).toContain("desk-app-scaffold");
    expect(body).toContain("getStorageClient()");
    expect(body).toContain("storage.read");
    expect(body).not.toContain("per-app storage API in later issues");
    expect(body).toMatch(/fragment/i);
    expect(body).not.toContain("self-contained HTML file");
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

describe("Desk reference skills", () => {
  it("publishes a general app storage CRUD guide", () => {
    const skill = DESK_REFERENCE_SKILLS.find((s) => s.name === "desk-app-storage");

    expect(skill).toBeTruthy();
    expect(skill?.description).toMatch(/CRUD/);
    expect(skill?.body()).toContain("First, load the app's contract");
    expect(skill?.body()).toContain(".storage/data.sqlite");
    expect(skill?.body()).toContain("create the `.storage/` directory");
    expect(skill?.body()).toContain("Never create a parallel fallback store");
    expect(skill?.body()).toContain("just read the first `skill.md` returned by glob");
    expect(skill?.body()).toContain("Use Node's `node:sqlite` module for direct CRUD");
    expect(skill?.body()).toContain("Recommended direct-write pattern");
    expect(skill?.body()).toContain("What app and fragment skills should document");
  });

  it("keeps scaffold guidance explicit about app storage contracts", () => {
    const skill = DESK_REFERENCE_SKILLS.find((s) => s.name === "desk-app-scaffold");
    const body = skill?.body() ?? "";

    expect(body).toContain("Persistent app storage");
    expect(body).toContain("App and fragment skills");
    expect(body).toContain("Storage contract");
    expect(body).toContain("getStorageClient()");
  });
});
