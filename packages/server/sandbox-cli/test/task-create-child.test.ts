import { describe, it, expect, vi, beforeEach } from "vitest";
import { run } from "../src/commands/task-create-child.js";

const postJsonMock = vi.fn();

vi.mock("../src/client.js", () => ({
  postJson: (path: string, body: unknown) => postJsonMock(path, body),
}));

vi.mock("../src/index.js", () => ({
  output: vi.fn(),
}));

beforeEach(() => {
  postJsonMock.mockReset();
  postJsonMock.mockResolvedValue({ message: { id: "msg_child" } });
});

describe("roomy-agent task create-child", () => {
  it("creates a child task under the current task by default", async () => {
    await run(["--title", "Implement parser", "Parse", "RSS"]);
    expect(postJsonMock).toHaveBeenCalledWith("/sandbox/messages", {
      title: "Implement parser",
      content: "Parse RSS",
    });
  });

  it("forwards an explicit parent task id", async () => {
    await run(["--parent-task", "msg_parent", "--title", "Implement parser", "Parse RSS"]);
    expect(postJsonMock).toHaveBeenCalledWith("/sandbox/messages", {
      title: "Implement parser",
      content: "Parse RSS",
      parentTaskId: "msg_parent",
    });
  });

  it("rejects missing title", async () => {
    await expect(run(["Parse RSS"])).rejects.toThrow(/Missing --title/);
    expect(postJsonMock).not.toHaveBeenCalled();
  });

  it("rejects missing content", async () => {
    await expect(run(["--title", "Implement parser"])).rejects.toThrow(/Missing task content/);
    expect(postJsonMock).not.toHaveBeenCalled();
  });
});
