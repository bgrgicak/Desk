import { beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/commands/find-artifacts.js";

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

describe("desk-agent find artifacts", () => {
  it("forwards query options to /sandbox/find/artifacts", async () => {
    await run(["--query", "note editor", "--kind", "fragment", "--workspace", "*", "--limit", "5"]);
    const url = getJsonMock.mock.calls[0][0] as string;
    expect(url.startsWith("/sandbox/find/artifacts?")).toBe(true);
    const params = new URLSearchParams(url.split("?")[1]);
    expect(params.get("q")).toBe("note editor");
    expect(params.get("kind")).toBe("fragment");
    expect(params.get("workspace")).toBe("*");
    expect(params.get("limit")).toBe("5");
  });

  it("rejects invalid kinds", async () => {
    await expect(run(["--kind", "message"])).rejects.toThrow(/--kind/);
    expect(getJsonMock).not.toHaveBeenCalled();
  });
});
