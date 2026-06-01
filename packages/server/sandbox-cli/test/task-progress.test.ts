import { describe, it, expect, vi, beforeEach } from "vitest";
import { run } from "../src/commands/task-progress.js";

const postJsonMock = vi.fn();

vi.mock("../src/client.js", () => ({
  postJson: (path: string, body: unknown) => postJsonMock(path, body),
}));

vi.mock("../src/index.js", () => ({
  output: vi.fn(),
}));

beforeEach(() => {
  postJsonMock.mockReset();
  postJsonMock.mockResolvedValue({ message: { id: "msg_progress" } });
});

describe("roomy-agent task progress", () => {
  it("posts progress to the current task by default", async () => {
    await run(["--message", "Scaffolding RSS app"]);
    expect(postJsonMock).toHaveBeenCalledWith("/sandbox/tasks/progress", {
      message: "Scaffolding RSS app",
    });
  });

  it("accepts positional progress text", async () => {
    await run(["Running", "tests"]);
    expect(postJsonMock).toHaveBeenCalledWith("/sandbox/tasks/progress", {
      message: "Running tests",
    });
  });

  it("rejects missing progress text", async () => {
    await expect(run([])).rejects.toThrow(/Missing progress message/);
    expect(postJsonMock).not.toHaveBeenCalled();
  });
});
