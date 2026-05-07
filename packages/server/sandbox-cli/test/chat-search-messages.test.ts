import { describe, it, expect, vi, beforeEach } from "vitest";
import { run } from "../src/commands/chat-search-messages.js";

const getJsonMock = vi.fn();
const outputMock = vi.fn();

vi.mock("../src/client.js", () => ({
  getJson: (pathname: string) => getJsonMock(pathname),
}));

vi.mock("../src/index.js", () => ({
  output: (data: unknown) => outputMock(data),
}));

beforeEach(() => {
  getJsonMock.mockReset();
  outputMock.mockReset();
  getJsonMock.mockResolvedValue({ hits: [] });
});

describe("desk-agent chat search-messages", () => {
  it("issues a GET to /sandbox/search/messages with the encoded query", async () => {
    await run(["--query", "kanban board"]);
    expect(getJsonMock).toHaveBeenCalledTimes(1);
    const url = getJsonMock.mock.calls[0][0] as string;
    expect(url.startsWith("/sandbox/search/messages?")).toBe(true);
    const params = new URLSearchParams(url.split("?")[1]);
    expect(params.get("q")).toBe("kanban board");
  });

  it("forwards optional --chat / --workspace / --kind / --limit flags", async () => {
    await run([
      "--query",
      "owls",
      "--chat",
      "cht_a",
      "--workspace",
      "project-a",
      "--kind",
      "summary",
      "--limit",
      "5",
    ]);
    const url = getJsonMock.mock.calls[0][0] as string;
    const params = new URLSearchParams(url.split("?")[1]);
    expect(params.get("q")).toBe("owls");
    expect(params.get("chat")).toBe("cht_a");
    expect(params.get("workspace")).toBe("project-a");
    expect(params.get("kind")).toBe("summary");
    expect(params.get("limit")).toBe("5");
  });

  it("prints the API response via output()", async () => {
    getJsonMock.mockResolvedValue({ hits: [{ messageId: "msg_1" }] });
    await run(["--query", "anything"]);
    expect(outputMock).toHaveBeenCalledWith({ hits: [{ messageId: "msg_1" }] });
  });

  it("rejects when --query is missing or empty", async () => {
    await expect(run([])).rejects.toThrow(/Missing --query/);
    await expect(run(["--query", ""])).rejects.toThrow(/Missing --query/);
    expect(getJsonMock).not.toHaveBeenCalled();
  });
});
