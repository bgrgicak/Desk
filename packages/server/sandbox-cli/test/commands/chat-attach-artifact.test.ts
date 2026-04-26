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
import { run } from "../../src/commands/chat-attach-artifact.js";

describe("chat attach-artifact", () => {
  it("calls callTool with chat.attach_artifact and correct request", async () => {
    const mockResponse = {
      id: "msg_1",
      chatId: "cht_abc",
      role: "agent",
      content: { type: "artifactRef", path: "artifacts/out.md", name: "out.md", mime: "text/markdown" },
      createdAt: "2025-01-01T00:00:00Z",
    };
    vi.mocked(callTool).mockResolvedValue(mockResponse);

    await run(["--chat", "cht_abc", "--path", "artifacts/out.md"]);

    expect(callTool).toHaveBeenCalledWith("chat.attach_artifact", {
      chatId: "cht_abc",
      path: "artifacts/out.md",
    });

    const request = vi.mocked(callTool).mock.calls[0][1] as Record<string, unknown>;
    TOOLS["chat.attach_artifact"].request.parse(request);
  });

  it("throws on missing args", async () => {
    await expect(run(["--chat", "cht_abc"])).rejects.toThrow("Usage");
  });
});
