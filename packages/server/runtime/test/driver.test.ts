import { describe, it, expect } from "vitest";
import {
  buildMessageParts,
  parseModelSpec,
  synthesizeNonTextEvents,
  toSandboxPath,
} from "../src/driver.js";
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

  it("rewrites the Desk-only `codex/...` relabel back to `openai/...`", () => {
    // Desk's settings UI relabels OpenAI models as `codex/...` when the
    // user authed via the ChatGPT/Codex bridge (no `OPENAI_API_KEY`).
    // The `opencode-serve` daemon only knows the `openai` provider, so
    // dispatching `codex/gpt-5.5` 500s with ProviderModelNotFoundError.
    expect(parseModelSpec("codex/gpt-5.5")).toEqual({
      providerID: "openai",
      modelID: "gpt-5.5",
    });
  });
});

describe("synthesizeNonTextEvents", () => {
  // Locks in the contract that broke in PR #111: opencode-serve 1.14.50
  // doesn't broadcast tool/step/reasoning parts over SSE — they only
  // become visible via `GET /session/:id/message` once the turn ends.
  // The runtime fetches that list and synthesizes non-text events so
  // the UI's tool-card / step-marker renderers have something to draw.
  const SES = "ses_test";
  const TURN = {
    parts: [
      { type: "step-start", id: "prt_s1", messageID: "msg_a" },
      {
        type: "reasoning",
        id: "prt_r1",
        text: "thinking...",
        messageID: "msg_a",
      },
      {
        type: "tool",
        id: "prt_t1",
        tool: "bash",
        state: { status: "completed", title: "pwd" },
        messageID: "msg_a",
      },
      { type: "text", id: "prt_x1", text: "the result is X", messageID: "msg_a" },
      { type: "step-finish", id: "prt_e1", reason: "stop", messageID: "msg_a" },
    ],
  };

  it("emits an event for every non-text part with run-format type names (hyphens -> underscores)", () => {
    const lines = [...synthesizeNonTextEvents(TURN, SES)];
    const events = lines.map((l) => JSON.parse(l));
    expect(events.map((e) => e.type)).toEqual([
      "step_start",
      "reasoning",
      "tool",
      // text part dropped — SSE already streamed it as deltas
      "step_finish",
    ]);
    // Each event carries the daemon-side `part` payload so downstream
    // renderers (ToolCallChip etc.) can read `part.tool` / `part.state`.
    const toolEvent = events.find((e) => e.type === "tool");
    expect(toolEvent.sessionID).toBe(SES);
    expect(toolEvent.part).toEqual({
      type: "tool",
      id: "prt_t1",
      tool: "bash",
      state: { status: "completed", title: "pwd" },
      messageID: "msg_a",
    });
  });

  it("returns nothing when the envelope has no parts (defensive guard)", () => {
    expect([...synthesizeNonTextEvents({}, SES)]).toEqual([]);
    expect([...synthesizeNonTextEvents({ parts: [] }, SES)]).toEqual([]);
    expect([...synthesizeNonTextEvents(null, SES)]).toEqual([]);
  });

  it("skips parts whose `type` field is missing or non-string", () => {
    const malformed = { parts: [{ id: "x" }, { type: 7 }, { type: "step-start" }] };
    const events = [...synthesizeNonTextEvents(malformed, SES)].map((l) =>
      JSON.parse(l),
    );
    expect(events).toEqual([
      expect.objectContaining({ type: "step_start" }),
    ]);
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
