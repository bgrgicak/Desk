import { describe, it, expect, vi, beforeEach } from "vitest";
import { run } from "../src/commands/task-complete.js";

const postJsonMock = vi.fn();

vi.mock("../src/client.js", () => ({
  postJson: (path: string, body: unknown) => postJsonMock(path, body),
}));

vi.mock("../src/index.js", () => ({
  output: vi.fn(),
}));

beforeEach(() => {
  postJsonMock.mockReset();
  postJsonMock.mockResolvedValue({ task: { id: "msg_x", state: "succeeded" } });
});

describe("desk-agent task complete", () => {
  it("posts the thread chat id alone when no --message is given", async () => {
    await run(["--chat", "ch_thread_xyz"]);
    expect(postJsonMock).toHaveBeenCalledWith("/sandbox/messages/complete", {
      chatId: "ch_thread_xyz",
    });
  });

  it("forwards --message verbatim as the report-back body", async () => {
    await run([
      "--chat", "ch_thread_xyz",
      "--message", "Audited 12 PRs. 3 need follow-up: #145, #161, #163.",
    ]);
    expect(postJsonMock).toHaveBeenCalledWith("/sandbox/messages/complete", {
      chatId: "ch_thread_xyz",
      message: "Audited 12 PRs. 3 need follow-up: #145, #161, #163.",
    });
  });

  it("rejects when neither --chat nor --message-id is given", async () => {
    await expect(run([])).rejects.toThrow(/--chat .* or --message-id/);
    expect(postJsonMock).not.toHaveBeenCalled();
  });

  it("rejects positional arguments — the outcome belongs in --message, not as positionals", async () => {
    await expect(
      run(["--chat", "ch_a", "done"]),
    ).rejects.toThrow(/Unexpected positional/);
    expect(postJsonMock).not.toHaveBeenCalled();
  });

  it("omits --message when it's a whitespace-only value", async () => {
    // A blank --message is the same as no message; the server-side rule
    // treats trimmed-empty as 'no report' so we don't bother sending it.
    await run(["--chat", "ch_thread_xyz", "--message", "   "]);
    expect(postJsonMock).toHaveBeenCalledWith("/sandbox/messages/complete", {
      chatId: "ch_thread_xyz",
    });
  });

  // --message-id is the escape hatch for agents that aren't sitting inside
  // the task's thread chat — they identify the task by its anchor id.
  it("posts messageId when --message-id is given", async () => {
    await run(["--message-id", "msg_anchor_abc"]);
    expect(postJsonMock).toHaveBeenCalledWith("/sandbox/messages/complete", {
      messageId: "msg_anchor_abc",
    });
  });

  it("forwards --message alongside --message-id", async () => {
    await run([
      "--message-id", "msg_anchor_abc",
      "--message", "Brief written; closing out.",
    ]);
    expect(postJsonMock).toHaveBeenCalledWith("/sandbox/messages/complete", {
      messageId: "msg_anchor_abc",
      message: "Brief written; closing out.",
    });
  });

  it("rejects passing both --chat and --message-id", async () => {
    await expect(
      run(["--chat", "ch_a", "--message-id", "msg_b"]),
    ).rejects.toThrow(/not both/);
    expect(postJsonMock).not.toHaveBeenCalled();
  });
});
