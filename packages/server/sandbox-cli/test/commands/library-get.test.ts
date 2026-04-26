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
import { run } from "../../src/commands/library-get.js";

describe("library get", () => {
  it("calls callTool with library.get and correct request", async () => {
    const mockResponse = {
      path: "library/doc.pdf",
      name: "doc.pdf",
      mime: "application/pdf",
      size: 1024,
      createdAt: "2025-01-01T00:00:00Z",
    };
    vi.mocked(callTool).mockResolvedValue(mockResponse);

    await run(["library/doc.pdf"]);

    expect(callTool).toHaveBeenCalledWith("library.get", { path: "library/doc.pdf" });

    const request = vi.mocked(callTool).mock.calls[0][1] as Record<string, unknown>;
    TOOLS["library.get"].request.parse(request);
  });

  it("throws on missing path", async () => {
    await expect(run([])).rejects.toThrow("Usage");
  });
});
