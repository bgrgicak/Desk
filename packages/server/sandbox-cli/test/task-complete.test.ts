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

  it("rejects missing --chat", async () => {
    await expect(run([])).rejects.toThrow(/Missing --chat/);
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
});
