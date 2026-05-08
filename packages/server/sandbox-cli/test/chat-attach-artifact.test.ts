import { describe, it, expect, vi, beforeEach } from "vitest";
import { run } from "../src/commands/chat-attach-artifact.js";

const postJsonMock = vi.fn();

vi.mock("../src/client.js", () => ({
  postJson: (path: string, body: unknown) => postJsonMock(path, body),
}));

vi.mock("../src/index.js", () => ({
  output: vi.fn(),
}));

beforeEach(() => {
  postJsonMock.mockReset();
  postJsonMock.mockResolvedValue({ id: "msg_artifact" });
});

describe("desk-agent chat attach-artifact", () => {
  it("posts the chat and workspace-relative artifact path", async () => {
    await run(["--chat", "cht_a", ".chats/cht_a/artifacts/report.md"]);

    expect(postJsonMock).toHaveBeenCalledWith("/sandbox/artifacts", {
      chatId: "cht_a",
      path: ".chats/cht_a/artifacts/report.md",
    });
  });

  it("forwards an optional display name", async () => {
    await run(["--chat", "cht_a", "--name", "Weekly report", ".chats/cht_a/artifacts/report.md"]);

    expect(postJsonMock).toHaveBeenCalledWith("/sandbox/artifacts", {
      chatId: "cht_a",
      path: ".chats/cht_a/artifacts/report.md",
      name: "Weekly report",
    });
  });

  it("rejects missing arguments", async () => {
    await expect(run(["--chat", "cht_a"])).rejects.toThrow(/Missing artifact path/);
    await expect(run([".chats/cht_a/artifacts/report.md"])).rejects.toThrow(/Missing --chat/);
    expect(postJsonMock).not.toHaveBeenCalled();
  });

  it("collects repeated --param flags", async () => {
    await run([
      "--chat",
      "cht_a",
      "--param",
      "note_id=abc",
      "--param",
      "mode=edit",
      "notes.app/dist/fragments/editor",
    ]);

    expect(postJsonMock).toHaveBeenCalledWith("/sandbox/artifacts", {
      chatId: "cht_a",
      path: "notes.app/dist/fragments/editor",
      params: { note_id: "abc", mode: "edit" },
    });
  });
});
