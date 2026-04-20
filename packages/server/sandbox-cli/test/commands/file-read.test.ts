import { describe, it, expect, vi, beforeEach } from "vitest";
import { TOOLS } from "@desk/shared";

vi.mock("../../src/client.js", () => ({
  callTool: vi.fn(),
}));

// Capture stdout
let stdoutData = "";
const origWrite = process.stdout.write;

beforeEach(() => {
  vi.clearAllMocks();
  stdoutData = "";
  process.stdout.write = ((chunk: string) => {
    stdoutData += chunk;
    return true;
  }) as typeof process.stdout.write;
});

import { callTool } from "../../src/client.js";
import { run } from "../../src/commands/file-read.js";

describe("file read", () => {
  it("calls callTool with file.read and correct request", async () => {
    const mockResponse = { content: "hello", mime: "text/plain" };
    vi.mocked(callTool).mockResolvedValue(mockResponse);

    await run(["f_abc123"]);

    expect(callTool).toHaveBeenCalledWith("file.read", { fileId: "f_abc123" });

    const request = vi.mocked(callTool).mock.calls[0][1] as Record<string, unknown>;
    TOOLS["file.read"].request.parse(request);
  });

  it("throws on missing fileId", async () => {
    await expect(run([])).rejects.toThrow("Usage");
  });
});
