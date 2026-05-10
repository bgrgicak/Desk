import { describe, it, expect, vi, beforeEach } from "vitest";
import { run } from "../src/commands/task-schedule.js";

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

describe("desk-agent task schedule", () => {
  it("posts a manual task (no schedule) with chat + content", async () => {
    await run(["--chat", "ch_a", "buy", "milk"]);
    expect(postJsonMock).toHaveBeenCalledWith("/sandbox/messages", {
      chatId: "ch_a",
      content: "buy milk",
    });
  });

  it("can request a fresh chat for a simple manual task with attachments", async () => {
    await run([
      "--chat", "ch_source",
      "--new-chat",
      "--title", "Investigate blank replies",
      "--attach", ".chats/ch_source/artifacts/report.md",
      "Fix", "blank", "replies",
    ]);
    expect(postJsonMock).toHaveBeenCalledWith("/sandbox/messages", {
      chatId: "ch_source",
      newChat: true,
      content: "Fix blank replies",
      title: "Investigate blank replies",
      attachments: [{ path: ".chats/ch_source/artifacts/report.md", name: "report.md" }],
    });
  });

  it("forwards --title, --at, --kind", async () => {
    await run([
      "--chat", "ch_a",
      "--title", "Daily standup",
      "--at", "2026-05-01T09:00:00Z",
      "--kind", "task",
      "Post the standup template",
    ]);
    expect(postJsonMock).toHaveBeenCalledWith("/sandbox/messages", {
      chatId: "ch_a",
      content: "Post the standup template",
      title: "Daily standup",
      executeAt: "2026-05-01T09:00:00Z",
      kind: "task",
    });
  });

  it("forwards --cron", async () => {
    await run(["--chat", "ch_a", "--cron", "0 9 * * 1-5", "ping"]);
    expect(postJsonMock).toHaveBeenCalledWith("/sandbox/messages", {
      chatId: "ch_a",
      content: "ping",
      cron: "0 9 * * 1-5",
    });
  });

  it("rejects --at and --cron together", async () => {
    await expect(
      run(["--chat", "ch_a", "--at", "2026-05-01T00:00:00Z", "--cron", "* * * * *", "x"]),
    ).rejects.toThrow(/mutually exclusive/);
    expect(postJsonMock).not.toHaveBeenCalled();
  });

  it("rejects --new-chat for scheduled or recurring tasks", async () => {
    await expect(
      run(["--chat", "ch_a", "--new-chat", "--at", "2026-05-01T00:00:00Z", "x"]),
    ).rejects.toThrow(/only for simple manual tasks/);
    await expect(
      run(["--chat", "ch_a", "--new-chat", "--cron", "* * * * *", "x"]),
    ).rejects.toThrow(/only for simple manual tasks/);
    expect(postJsonMock).not.toHaveBeenCalled();
  });

  it("rejects --new-chat with a non-task kind", async () => {
    await expect(
      run(["--chat", "ch_a", "--new-chat", "--kind", "chat", "x"]),
    ).rejects.toThrow(/--kind must be omitted or task/);
    expect(postJsonMock).not.toHaveBeenCalled();
  });

  it("rejects missing --chat", async () => {
    await expect(run(["hello"])).rejects.toThrow(/Missing --chat/);
    expect(postJsonMock).not.toHaveBeenCalled();
  });

  it("rejects missing content", async () => {
    await expect(run(["--chat", "ch_a"])).rejects.toThrow(/Missing task content/);
    expect(postJsonMock).not.toHaveBeenCalled();
  });
});
