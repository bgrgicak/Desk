import { describe, it, expect, vi, beforeEach } from "vitest";
import { run } from "../src/commands/task-fail.js";

const postJsonMock = vi.fn();

vi.mock("../src/client.js", () => ({
  postJson: (path: string, body: unknown) => postJsonMock(path, body),
}));

vi.mock("../src/index.js", () => ({
  output: vi.fn(),
}));

beforeEach(() => {
  postJsonMock.mockReset();
  postJsonMock.mockResolvedValue({ task: { id: "msg_task", state: "failed" } });
});

describe("roomy-agent task fail", () => {
  it("posts failure to the current task by default", async () => {
    await run(["--message", "Docker container is marked for removal"]);
    expect(postJsonMock).toHaveBeenCalledWith("/sandbox/tasks/fail", {
      message: "Docker container is marked for removal",
    });
  });

  it("accepts positional failure text", async () => {
    await run(["Provider", "timed", "out"]);
    expect(postJsonMock).toHaveBeenCalledWith("/sandbox/tasks/fail", {
      message: "Provider timed out",
    });
  });

  it("rejects missing failure text", async () => {
    await expect(run([])).rejects.toThrow(/Missing failure message/);
    expect(postJsonMock).not.toHaveBeenCalled();
  });
});
