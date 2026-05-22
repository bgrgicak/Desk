import { describe, it, expect, vi, beforeEach } from "vitest";
import { run } from "../src/commands/task-reschedule.js";

const postJsonMock = vi.fn();

vi.mock("../src/client.js", () => ({
  postJson: (path: string, body: unknown) => postJsonMock(path, body),
}));

vi.mock("../src/index.js", () => ({
  output: vi.fn(),
}));

beforeEach(() => {
  postJsonMock.mockReset();
  postJsonMock.mockResolvedValue({ id: "msg_x" });
});

describe("roomy-agent task reschedule", () => {
  it("posts a one-shot reschedule with chat + message-id + --at", async () => {
    await run([
      "--chat", "ch_a",
      "--message-id", "msg_1",
      "--at", "2026-05-01T09:00:00Z",
    ]);
    expect(postJsonMock).toHaveBeenCalledWith("/sandbox/messages/reschedule", {
      chatId: "ch_a",
      messageId: "msg_1",
      executeAt: "2026-05-01T09:00:00Z",
    });
  });

  it("posts a recurring reschedule with --cron", async () => {
    await run([
      "--chat", "ch_a",
      "--message-id", "msg_1",
      "--cron", "0 9 * * 1-5",
    ]);
    expect(postJsonMock).toHaveBeenCalledWith("/sandbox/messages/reschedule", {
      chatId: "ch_a",
      messageId: "msg_1",
      cron: "0 9 * * 1-5",
    });
  });

  it("forwards --title and positional content alongside --at", async () => {
    await run([
      "--chat", "ch_a",
      "--message-id", "msg_1",
      "--at", "2026-05-01T09:00:00Z",
      "--title", "Weekly review",
      "Pull", "this", "week's", "numbers",
    ]);
    expect(postJsonMock).toHaveBeenCalledWith("/sandbox/messages/reschedule", {
      chatId: "ch_a",
      messageId: "msg_1",
      executeAt: "2026-05-01T09:00:00Z",
      title: "Weekly review",
      content: "Pull this week's numbers",
    });
  });

  it("rejects --at and --cron together", async () => {
    await expect(
      run([
        "--chat", "ch_a",
        "--message-id", "msg_1",
        "--at", "2026-05-01T00:00:00Z",
        "--cron", "* * * * *",
      ]),
    ).rejects.toThrow(/mutually exclusive/);
    expect(postJsonMock).not.toHaveBeenCalled();
  });

  it("rejects when neither --at nor --cron is supplied", async () => {
    await expect(
      run(["--chat", "ch_a", "--message-id", "msg_1"]),
    ).rejects.toThrow(/Reschedule requires --at or --cron/);
    expect(postJsonMock).not.toHaveBeenCalled();
  });

  it("rejects missing --chat", async () => {
    await expect(
      run(["--message-id", "msg_1", "--at", "2026-05-01T00:00:00Z"]),
    ).rejects.toThrow(/Missing --chat/);
    expect(postJsonMock).not.toHaveBeenCalled();
  });

  it("rejects missing --message-id", async () => {
    await expect(
      run(["--chat", "ch_a", "--at", "2026-05-01T00:00:00Z"]),
    ).rejects.toThrow(/Missing --message-id/);
    expect(postJsonMock).not.toHaveBeenCalled();
  });
});
