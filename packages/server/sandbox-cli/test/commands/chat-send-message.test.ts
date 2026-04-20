import { describe, it, expect, vi, beforeEach } from "vitest";
import { TOOLS } from "@desk/shared";

vi.mock("../../src/client.js", () => ({
  callTool: vi.fn(),
}));

let stdoutData = "";

beforeEach(() => {
  vi.clearAllMocks();
  stdoutData = "";
  process.stdout.write = ((chunk: string) => {
    stdoutData += chunk;
    return true;
  }) as typeof process.stdout.write;
});

import { callTool } from "../../src/client.js";
import { run } from "../../src/commands/chat-send-message.js";

describe("chat send-message", () => {
  it("calls callTool with chat.send_message and correct request", async () => {
    const mockResponse = {
      id: "m_1",
      chatId: "ch_abc",
      role: "assistant",
      content: { type: "text", text: "Hello" },
      createdAt: "2025-01-01T00:00:00Z",
    };
    vi.mocked(callTool).mockResolvedValue(mockResponse);

    await run(["--chat", "ch_abc", "Here is my analysis."]);

    expect(callTool).toHaveBeenCalledWith("chat.send_message", {
      chatId: "ch_abc",
      content: "Here is my analysis.",
    });

    const request = vi.mocked(callTool).mock.calls[0][1] as Record<string, unknown>;
    TOOLS["chat.send_message"].request.parse(request);
  });

  it("throws on missing args", async () => {
    await expect(run([])).rejects.toThrow("Usage");
  });
});
