import { describe, expect, it } from "vitest";
import {
  terminalAssistantMessage,
  translateTerminalAssistantText,
  type TranslateContext,
} from "../src/piEvents.js";

const ctx: TranslateContext = {
  sessionID: "cht_test",
  assistantMessageId: "msg_run",
  model: { providerID: "openai", modelID: "gpt-5.4" },
};

describe("terminalAssistantMessage", () => {
  it("detects terminal assistant errors from pi message_end events", () => {
    const out = terminalAssistantMessage({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "Project does not have access to model",
      },
    });

    expect(out).toEqual({
      stopReason: "error",
      exitCode: 1,
      text: "",
      errorMessage: "Project does not have access to model",
    });
  });

  it("detects successful terminal assistant text from session-style message events", () => {
    const out = terminalAssistantMessage({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello from fallback" }],
        stopReason: "stop",
        provider: "openai-codex",
        model: "gpt-5.5",
      },
    });

    expect(out).toEqual({
      stopReason: "stop",
      exitCode: 0,
      text: "Hello from fallback",
      model: { providerID: "openai-codex", modelID: "gpt-5.5" },
    });
  });

  it("ignores tool-use assistant messages because the turn is not terminal yet", () => {
    expect(terminalAssistantMessage({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "read", arguments: {} }],
        stopReason: "toolUse",
      },
    })).toBeNull();
  });
});

describe("translateTerminalAssistantText", () => {
  it("synthesizes a Desk text event from final assistant text", () => {
    const [line] = translateTerminalAssistantText({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Final answer" }],
        stopReason: "stop",
      },
    }, ctx);

    expect(JSON.parse(line!)).toEqual({
      type: "text",
      sessionID: "cht_test",
      model: { providerID: "openai", modelID: "gpt-5.4" },
      part: {
        type: "text",
        text: "Final answer",
        id: "msg_run",
        messageID: "msg_run",
      },
    });
  });
});
