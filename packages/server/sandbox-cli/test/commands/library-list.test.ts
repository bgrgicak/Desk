import { describe, it, expect, vi, beforeEach } from "vitest";
import { TOOLS } from "@desk/shared";

vi.mock("../../src/client.js", () => ({
  callTool: vi.fn(),
}));

let stdoutData = "";

beforeEach(() => {
  vi.clearAllMocks();
  stdoutData = "";
  process.stdout.write = ((chunk: string) => {
    stdoutData += chunk;
    return true;
  }) as typeof process.stdout.write;
});

import { callTool } from "../../src/client.js";
import { run } from "../../src/commands/library-list.js";

describe("library list", () => {
  it("calls callTool with library.list and correct request", async () => {
    vi.mocked(callTool).mockResolvedValue({ items: [], nextCursor: undefined });

    await run(["--workspace", "ws_abc", "--limit", "10"]);

    expect(callTool).toHaveBeenCalledWith("library.list", {
      workspaceId: "ws_abc",
      limit: 10,
    });

    const request = vi.mocked(callTool).mock.calls[0][1] as Record<string, unknown>;
    TOOLS["library.list"].request.parse(request);
  });

  it("passes cursor when provided", async () => {
    vi.mocked(callTool).mockResolvedValue({ items: [] });

    await run(["--workspace", "ws_abc", "--cursor", "c_1"]);

    expect(callTool).toHaveBeenCalledWith("library.list", {
      workspaceId: "ws_abc",
      cursor: "c_1",
    });
  });

  it("throws on missing workspace", async () => {
    await expect(run([])).rejects.toThrow("Usage");
  });
});
