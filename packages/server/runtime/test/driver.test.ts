import { describe, it, expect } from "vitest";
import { buildMessageParts, parseModelSpec, toSandboxPath } from "../src/driver.js";
import { SANDBOX_HOME } from "../src/mounts.js";

describe("toSandboxPath", () => {
  it("prepends SANDBOX_HOME to workspace-relative paths", () => {
    expect(toSandboxPath("notes.txt")).toBe(`${SANDBOX_HOME}/notes.txt`);
    expect(toSandboxPath(".chats/cht_1/attachments/x.md")).toBe(
      `${SANDBOX_HOME}/.chats/cht_1/attachments/x.md`,
    );
  });

  it("strips a stray leading slash so absolute-style inputs don't double up", () => {
    expect(toSandboxPath("/Random/file")).toBe(`${SANDBOX_HOME}/Random/file`);
    expect(toSandboxPath("///deep")).toBe(`${SANDBOX_HOME}/deep`);
  });
});

describe("parseModelSpec", () => {
  it("splits provider/model on the first slash", () => {
    expect(parseModelSpec("opencode/big-pickle")).toEqual({
      providerID: "opencode",
      modelID: "big-pickle",
    });
    expect(parseModelSpec("anthropic/claude-3.5-sonnet")).toEqual({
      providerID: "anthropic",
      modelID: "claude-3.5-sonnet",
    });
  });

  it("preserves slashes in the model part after the first one", () => {
    // Some registry-style ids include `/` (e.g. an OpenRouter `org/model`).
    // We split only on the first slash so the provider is the namespace.
    expect(parseModelSpec("openrouter/anthropic/claude-3")).toEqual({
      providerID: "openrouter",
      modelID: "anthropic/claude-3",
    });
  });

  it("defaults provider to opencode when there is no slash", () => {
    expect(parseModelSpec("big-pickle")).toEqual({
      providerID: "opencode",
      modelID: "big-pickle",
    });
  });
});

describe("buildMessageParts", () => {
  it("emits a single text part for a prompt with no attachments", () => {
    const parts = buildMessageParts({ prompt: "Hello" });
    expect(parts).toEqual([{ type: "text", text: "Hello" }]);
  });

  it("appends one text part per attachment with the sandbox-absolute path", () => {
    const parts = buildMessageParts({
      prompt: "Read the attached file.",
      attachments: ["notes.txt", "subdir/page.md"],
    });
    expect(parts).toHaveLength(3);
    expect(parts[0]).toEqual({ type: "text", text: "Read the attached file." });
    const first = parts[1] as { type: string; text: string };
    const second = parts[2] as { type: string; text: string };
    expect(first.type).toBe("text");
    expect(first.text).toContain(`${SANDBOX_HOME}/notes.txt`);
    expect(second.text).toContain(`${SANDBOX_HOME}/subdir/page.md`);
  });
});
