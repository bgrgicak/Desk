/**
 * Integration test: invokes the production reflection callback against
 * the real `opencode` CLI on the host. Asserts the parsed result is
 * shaped like the prompt asks for — non-empty journal, array of
 * memoryEdits — without locking us into a specific journal body the
 * model is free to vary.
 *
 * Skipped when `opencode` isn't on PATH so CI environments without the
 * CLI don't fail this test. The local `npm run ci:local` mirror has it.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import {
  productionReflectWorkspace,
  productionReflectUser,
} from "../../src/reflectFn.js";

function opencodeAvailable(): boolean {
  try {
    const result = spawnSync("opencode", ["--version"], { stdio: "ignore" });
    return result.status === 0;
  } catch {
    return false;
  }
}

const SKIP = !opencodeAvailable();
const describeIf = SKIP ? describe.skip : describe;

describeIf("productionReflectWorkspace (real opencode)", () => {
  it("returns a non-empty journal and an array of memory edits", async () => {
    // 5-minute timeout: the gpt-5-nano free model is slow but free.
    const result = await productionReflectWorkspace({
      workspaceSlug: "kanban",
      workspaceName: "Kanban",
      date: "2026-05-05",
      activity: [
        {
          chatId: "chat_demo",
          role: "user",
          createdAt: "2026-05-05T10:00:00.000Z",
          body: "Set up the kanban board with todo, doing, done columns.",
        },
        {
          chatId: "chat_demo",
          role: "agent",
          createdAt: "2026-05-05T10:01:00.000Z",
          body: "Done. Added the three columns.",
        },
        {
          chatId: "chat_demo",
          role: "user",
          createdAt: "2026-05-05T10:05:00.000Z",
          body: "Move the Q2 review onto the board.",
        },
      ],
    });

    expect(typeof result.journal).toBe("string");
    expect(result.journal.length).toBeGreaterThan(0);
    // The reflection prompt asks for a markdown body with bullets and
    // section breaks; either a leading "# heading" or any "## section"
    // marker proves the model produced structured markdown rather than
    // a degraded `(reflection failed: …)` placeholder.
    const hasMarkdownStructure =
      result.journal.includes("# ") ||
      result.journal.includes("## ") ||
      result.journal.includes("- ");
    expect(
      hasMarkdownStructure,
      `journal should contain markdown structure; got: ${result.journal.slice(0, 200)}`,
    ).toBe(true);
    // Reflection must never mark itself as degraded for a healthy call.
    expect(result.journal.startsWith("(reflection failed:")).toBe(false);

    // memoryEdits is optional but, if present, must be an array of
    // { path, body } objects.
    if (result.memoryEdits !== undefined) {
      expect(Array.isArray(result.memoryEdits)).toBe(true);
      for (const edit of result.memoryEdits) {
        expect(typeof edit.path).toBe("string");
        expect(typeof edit.body).toBe("string");
      }
    }
  }, 240_000);
});

describeIf("productionReflectUser (real opencode)", () => {
  it("returns a non-empty journal for a per-user rollup", async () => {
    const result = await productionReflectUser({
      userId: "user_demo",
      date: "2026-05-05",
      workspaceJournals: [
        {
          workspaceSlug: "kanban",
          body: "# Kanban\n\nUser set up todo/doing/done columns and dropped Q2 review on the board.",
        },
        {
          workspaceSlug: "writing",
          body: "# Writing\n\nUser drafted intro and asked for a tighter pull-quote.",
        },
      ],
    });

    expect(typeof result.journal).toBe("string");
    expect(result.journal.length).toBeGreaterThan(0);
    expect(result.journal.startsWith("(reflection failed:")).toBe(false);
    if (result.memoryEdits !== undefined) {
      expect(Array.isArray(result.memoryEdits)).toBe(true);
    }
  }, 240_000);
});
