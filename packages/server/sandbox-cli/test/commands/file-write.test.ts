import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Readable } from "node:stream";
import { TOOLS } from "@desk/shared";

vi.mock("../../src/client.js", () => ({
  callTool: vi.fn(),
}));

let stdoutData = "";
const origStdin = process.stdin;

beforeEach(() => {
  vi.clearAllMocks();
  stdoutData = "";
  process.stdout.write = ((chunk: string) => {
    stdoutData += chunk;
    return true;
  }) as typeof process.stdout.write;
});

import { callTool } from "../../src/client.js";
import { run } from "../../src/commands/file-write.js";

describe("file write", () => {
  it("calls callTool with file.write and stdin base64", async () => {
    const mockResponse = {
      id: "f_1",
      workspaceId: "ws_1",
      class: "artifact",
      path: "/hello.txt",
      name: "hello.txt",
      mime: "text/plain",
      size: 5,
      createdAt: "2025-01-01T00:00:00Z",
    };
    vi.mocked(callTool).mockResolvedValue(mockResponse);

    // Mock stdin as a readable stream with known content
    const fakeStdin = Readable.from([Buffer.from("hello")]);
    Object.defineProperty(process, "stdin", { value: fakeStdin, writable: true });

    await run(["--workspace", "ws_1", "--name", "hello.txt", "--mime", "text/plain"]);

    expect(callTool).toHaveBeenCalledWith("file.write", {
      workspaceId: "ws_1",
      name: "hello.txt",
      mime: "text/plain",
      contentBase64: Buffer.from("hello").toString("base64"),
    });

    const request = vi.mocked(callTool).mock.calls[0][1] as Record<string, unknown>;
    TOOLS["file.write"].request.parse(request);
  });

  afterEach(() => {
    Object.defineProperty(process, "stdin", { value: origStdin, writable: true });
  });

  it("includes chatId when provided", async () => {
    vi.mocked(callTool).mockResolvedValue({
      id: "f_1",
      workspaceId: "ws_1",
      class: "artifact",
      path: "/hello.txt",
      name: "hello.txt",
      mime: "text/plain",
      size: 5,
      createdAt: "2025-01-01T00:00:00Z",
    });

    const fakeStdin = Readable.from([Buffer.from("data")]);
    Object.defineProperty(process, "stdin", { value: fakeStdin, writable: true });

    await run([
      "--workspace", "ws_1",
      "--name", "file.txt",
      "--mime", "text/plain",
      "--chat", "ch_1",
    ]);

    expect(callTool).toHaveBeenCalledWith("file.write", expect.objectContaining({
      chatId: "ch_1",
    }));
  });
});
