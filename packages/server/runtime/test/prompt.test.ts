import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { GOAL_KEYS } from "@agent-desk/shared";
import {
  ensureLayout,
  ensureWorkspaceLayout,
  userMemoryIndexPath,
  workspaceMemoryIndexPath,
} from "@agent-desk/storage";
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
  };

  it("orders mandate → artifacts → task context → scheduling → goal autodetect → persistence → memory rules → goal → Desk skill router", () => {
    const body = renderPromptBody({
      ...baseInput,
      chatId: "chat-x",
      goal: "document",
      userTimezone: "America/Los_Angeles",
    });

    const idxMandate = body.indexOf("Your mandate is to help");
    const idxArtifacts = body.indexOf("## Your workspace");
    const idxTaskContext = body.indexOf("## Building task context");
    const idxScheduling = body.indexOf("## Scheduling — act first, ask never");
    const idxGoalAutodetect = body.indexOf("## Goal autodetection");
    const idxPersistence = body.indexOf("## Persistence (~/.deskrc)");
    const idxMemoryRules = body.indexOf("## Memory and recall");
    const idxGoal = body.indexOf("## User's goal: write a document");
    const idxSkills = body.indexOf("## Desk native skills");

    expect(idxMandate).toBeGreaterThanOrEqual(0);
    expect(idxArtifacts).toBeGreaterThan(idxMandate);
    expect(idxTaskContext).toBeGreaterThan(idxArtifacts);
    expect(idxScheduling).toBeGreaterThan(idxTaskContext);
    expect(idxGoalAutodetect).toBeGreaterThan(idxScheduling);
    expect(idxPersistence).toBeGreaterThan(idxGoalAutodetect);
    expect(idxMemoryRules).toBeGreaterThan(idxPersistence);
    expect(idxGoal).toBeGreaterThan(idxMemoryRules);
    expect(idxSkills).toBeGreaterThan(idxGoal);
  });

  it("includes persistence guidance in chat-mode prompts", () => {
    const body = renderPromptBody({ ...baseInput, chatId: "chat-x" });
    expect(body).toContain("## Persistence (~/.deskrc)");
    expect(body).toContain("There are no ephemeral package installs");
    expect(body).toContain("always add the idempotent install command to");
    expect(body).toContain("`~/.deskrc` immediately");
    expect(body).toContain("`npm install -g`");
    expect(body).toContain("Installing a package without persisting it in `~/.deskrc` is an incomplete");
    expect(body).toContain("sudo apt-get update && sudo apt-get install -y --no-install-recommends");
    expect(body).toContain("Every line must be idempotent");
    expect(body).toContain("desk-persistence");
  });

  it("omits persistence guidance from summary-mode prompts", () => {
    const body = renderPromptBody({ ...baseInput, chatId: "chat-x", runMode: "summary" });
    expect(body).not.toContain("## Persistence (~/.deskrc)");
  });

  it("does not inline the long Desk CLI manual", () => {
    const body = renderPromptBody({ ...baseInput, chatId: "chat-x" });
    expect(body).toContain("## Desk native skills");
    expect(body).toContain("desk-cli-task-schedule");
    expect(body).toContain("desk-cli-chat-attach-artifact");
    expect(body).toContain("desk-cli-file-to-markdown");
    expect(body).toContain("desk-persistence");
    expect(body).toContain("the `playwright` MCP server");
    expect(body).toContain("assume Firefox");
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

  it("can omit goal autodetection while keeping the persisted goal section", () => {
    const body = renderPromptBody({ ...baseInput, goal: "app", includeGoalAutodetect: false });
    expect(body).not.toContain("## Goal autodetection");
    expect(body).not.toContain("desk-goal-<goal>");
    expect(body).toContain("## User's goal: build an app");
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
    expect(body).toContain("create, significantly update, or retrieve from the current chat/workspace library");
    expect(body).toContain("no exceptions for type");
    expect(body).toContain("library item");
    expect(body).toContain("Library search is scoped to the current chat/workspace");
    expect(body).toContain("pass the directory path");
    expect(body).toContain("Do not reply to the user until the attach command has been executed or you have determined no attachable current-workspace path exists");
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
    // Thread-based format (P2.3): active / closed / open-threads sections.
    expect(body).toContain("## Active threads");
    expect(body).toContain("## Closed threads");
    expect(body).toContain("## Open threads / next steps");
    expect(body).toContain("Preserve every fact from the prior summary");
    // Old chronology-based "Conversation arc" + "Artifacts" table are gone.
    expect(body).not.toContain("## Conversation arc");
    expect(body).not.toContain("| File | Description |");
    expect(body).toContain("Chat summaries: ~/.chats/chat-abc/notes/");
    expect(body).toContain("Chat artifacts:  ~/.chats/chat-abc/artifacts/");
    expect(body).not.toContain("## Your workspace");
    expect(body).not.toContain("Save before replying");
    expect(body).not.toContain("desk-agent chat attach-artifact");
    expect(body).not.toContain("## Scheduling");
    expect(body).not.toContain("## Goal autodetection");
    expect(body).not.toContain("## User's goal:");
    expect(body).not.toContain("## Desk native skills");
    expect(body).not.toContain("## Persistence (~/.deskrc)");
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

  it("points the agent at search_chat_messages from the always-on context", () => {
    // P3.5: context.md must name the chat-search tool and its Desk skill so
    // recall is discoverable without preloading desk-skills.
    const body = renderPromptBody({ ...baseInput, chatId: "chat-abc" });

    expect(body).toContain("## Memory and recall");
    expect(body).toContain("search_chat_messages");
    expect(body).toContain("desk-cli-chat-search-messages");
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

  it("requires library discovery before answering library availability", () => {
    const body = renderPromptBody({ ...baseInput, chatId: "chat-abc" });

    expect(body).toContain("Before answering whether the user's library already has");
    expect(body).toContain("run\n`desk-agent find library`");
    expect(body).toContain("Also run `desk-agent find library` before answering a\nrequest that looks like it could be satisfied by a reusable tool");
    expect(body).toContain("even\nwhen the request could also be answered inline with a quick calculation");
    expect(body).toContain("Never say that no matching library item exists\nunless you ran `desk-agent find library`");
    expect(body).toContain("Do not say \"I checked\", \"I found\", or \"there is no app\"");
    expect(body).toContain("Filesystem/search tools may supplement library discovery but do not\nreplace it for availability claims or tool-like request handling");
  });

  it("requires current-workspace library fallback when targeted discovery is incomplete", () => {
    const body = renderPromptBody({ ...baseInput, chatId: "chat-abc" });

    expect(body).toContain("Use the requested library item kind\nwhen it is clear; otherwise use `--kind any`");
    expect(body).toContain("desk-agent find library --kind <app|fragment|note|doc|any> --limit 100");
    expect(body).toContain("assume the search\nquery was too narrow");
  });

  it("requires matching library items to be reused and attached immediately", () => {
    const body = renderPromptBody({ ...baseInput, chatId: "chat-abc" });

    expect(body).toContain("When `desk-agent find library` returns a library item that satisfies the user's\nrequest, reuse it");
    expect(body).toContain("Do not scaffold, rebuild, or create a duplicate app");
    expect(body).toContain("Library discovery is scoped to the current\nchat/workspace; do not expect results from other workspaces");
    expect(body).toContain("When returning a matching library item to the user, attach it in the same turn\nwith `desk-agent chat attach-artifact` before replying");
    expect(body).toContain("Only pass a hit's `path` directly to `attach-artifact`\nwhen it is in the current chat/workspace");
    expect(body).toContain("Do not merely describe a matching item\nor ask whether the user wants to see it");
  });

  it("the `app` goal searches existing library items before scaffolding", () => {
    const body = renderPromptBody({ ...baseInput, goal: "app" });

    expect(body).toContain("Before scaffolding, offering to build, or saying an app does not exist");
    expect(body).toContain("search the current workspace library with `desk-agent find library`");
    expect(body).toContain("If a matching app or fragment satisfies the request, reuse it and attach it");
    expect(body).toContain("do not scaffold, rebuild,\n   or duplicate it");
    expect(body).toContain("Only build a new app when no suitable app/fragment exists or\n   the user explicitly asks for a new one");
    expect(body).toContain("library discovery does not return other workspaces");
    expect(body).toContain("immediately when it satisfies the request and has a current-workspace\n   attachable path");
  });

});

describe("memory injection", () => {
  let home: string;

  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-prompt-memory-"));
    await ensureLayout(home);
    await ensureWorkspaceLayout(home, "alpha");
  });

  afterAll(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  const baseInput = {
    agentName: "Jarvis",
    userName: "Desk",
  };

  it("injects context.md (memory rules) followed by user and workspace memory indexes in order", async () => {
    await fs.writeFile(
      userMemoryIndexPath(home),
      "# User memory\n\n- prefers terse replies\n",
      "utf-8",
    );
    await fs.writeFile(
      workspaceMemoryIndexPath(home, "alpha"),
      "# Workspace memory\n\n- this workspace ships SQLite\n",
      "utf-8",
    );

    const body = renderPromptBody({
      ...baseInput,
      home,
      workspaceSlug: "alpha",
      goal: "document",
    });

    const idxRules = body.indexOf("## Memory and recall");
    const idxUserIndex = body.indexOf("prefers terse replies");
    const idxWorkspaceIndex = body.indexOf("this workspace ships SQLite");
    const idxGoal = body.indexOf("## User's goal: write a document");

    expect(idxRules).toBeGreaterThanOrEqual(0);
    expect(idxUserIndex).toBeGreaterThan(idxRules);
    expect(idxWorkspaceIndex).toBeGreaterThan(idxUserIndex);
    expect(idxGoal).toBeGreaterThan(idxWorkspaceIndex);

    expect(body).toContain("<!-- Desk user memory index -->");
    expect(body).toContain("<!-- Desk workspace memory index -->");
    expect(body).toContain("Workspace memory is writable from the sandbox");
    expect(body).toContain("~/.memory/workspace.md");
    expect(body).not.toContain("~/Desk/.memory/memory.md");
    expect(body).not.toContain("~/Desk/workspaces/alpha/.memory/workspace.md");
  });

  it("injects empty stubs when memory indexes are missing", async () => {
    const fresh = await fs.mkdtemp(path.join(os.tmpdir(), "desk-prompt-memory-fresh-"));
    try {
      const body = renderPromptBody({
        ...baseInput,
        home: fresh,
        workspaceSlug: "alpha",
      });
      expect(body).toContain("## Memory and recall");
      expect(body).toContain("# User memory");
      expect(body).toContain("# Workspace memory");
      expect(body).toContain("nothing remembered yet");
    } finally {
      await fs.rm(fresh, { recursive: true, force: true });
    }
  });

  it("surfaces unexpected memory read failures instead of injecting empty stubs", async () => {
    const broken = await fs.mkdtemp(path.join(os.tmpdir(), "desk-prompt-memory-broken-"));
    try {
      await fs.mkdir(path.dirname(userMemoryIndexPath(broken)), { recursive: true });
      await fs.mkdir(userMemoryIndexPath(broken));

      const body = renderPromptBody({
        ...baseInput,
        home: broken,
        workspaceSlug: "alpha",
      });

      expect(body).toContain("# User memory");
      expect(body).toContain("memory unavailable:");
      expect(body).not.toContain("# User memory\n\n_(empty — nothing remembered yet)_");
    } finally {
      await fs.rm(broken, { recursive: true, force: true });
    }
  });

  it("skips memory injection when home/workspaceSlug are not provided", () => {
    const body = renderPromptBody({ ...baseInput });
    expect(body).not.toContain("<!-- Desk user memory index -->");
    expect(body).not.toContain("<!-- Desk workspace memory index -->");
  });

  it("does not inject memory indexes during summary mode", () => {
    const body = renderPromptBody({
      ...baseInput,
      runMode: "summary",
      home,
      workspaceSlug: "alpha",
      chatId: "chat-x",
    });
    expect(body).not.toContain("## Memory and recall");
    expect(body).not.toContain("<!-- Desk user memory index -->");
  });
});

describe("Desk reference skills", () => {
  it("publishes current-workspace artifact attachment guidance", () => {
    const skill = DESK_REFERENCE_SKILLS.find((s) => s.name === "desk-cli-chat-attach-artifact");
    const body = skill?.body() ?? "";

    expect(skill).toBeTruthy();
    expect(body).toContain("Only pass paths that exist in the current chat/workspace");
    expect(body).toContain("library hit should already be scoped there");
    expect(body).toContain("no attachable\ncurrent-workspace path exists");
  });

  it("publishes a persistence playbook", () => {
    const skill = DESK_REFERENCE_SKILLS.find((s) => s.name === "desk-persistence");

    expect(skill).toBeTruthy();
    expect(skill?.description).toMatch(/persist/);
    expect(skill?.body()).toContain("# Desk persistence playbook");
    expect(skill?.body()).toContain("sudo apt-get update && sudo apt-get install");
    expect(skill?.body()).toContain("grep -qxF");
    expect(skill?.body()).toContain("MCP server registrations");
    expect(skill?.body()).toContain("Recovery flow");
    expect(skill?.body()).toContain("Incorrect entries");
  });

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

  it("publishes a chat-message search reference (P3.5)", () => {
    const skill = DESK_REFERENCE_SKILLS.find((s) => s.name === "desk-cli-chat-search-messages");
    expect(skill).toBeTruthy();
    expect(skill?.description).toMatch(/recall|history|search/i);
    const body = skill?.body() ?? "";
    expect(body).toContain("desk-agent chat search-messages");
    expect(body).toContain("--query");
    expect(body).toContain("--workspace");
  });

  it("publishes hard reuse rules in the library discovery reference", () => {
    const skill = DESK_REFERENCE_SKILLS.find((s) => s.name === "desk-cli-find-library");
    const body = skill?.body() ?? "";

    expect(skill).toBeTruthy();
    expect(body).toContain("attach it with `desk-agent chat\nattach-artifact` in the same turn");
    expect(body).toContain("Do not\nscaffold or rebuild an app, fragment, note, doc");
    expect(body).toContain("unless the user explicitly asks for a new one");
    expect(body).toContain("Discovery is scoped to the current\nchat/workspace; cross-workspace library search is not available yet");
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
