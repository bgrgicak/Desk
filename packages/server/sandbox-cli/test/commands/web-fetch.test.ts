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
import { run } from "../../src/commands/web-fetch.js";

describe("web fetch", () => {
  it("calls callTool with web.fetch and correct request", async () => {
    const mockResponse = {
      status: 200,
      headers: { "content-type": "text/html" },
      bodyBase64: Buffer.from("<html></html>").toString("base64"),
    };
    vi.mocked(callTool).mockResolvedValue(mockResponse);

    await run([
      "https://example.com",
      "--method", "GET",
      "--header", "Accept=text/html",
    ]);

    expect(callTool).toHaveBeenCalledWith("web.fetch", {
      url: "https://example.com",
      method: "GET",
      headers: { Accept: "text/html" },
    });

    const request = vi.mocked(callTool).mock.calls[0][1] as Record<string, unknown>;
    TOOLS["web.fetch"].request.parse(request);
  });

  it("throws on missing url", async () => {
    await expect(run([])).rejects.toThrow("Usage");
  });

  it("passes multiple headers", async () => {
    vi.mocked(callTool).mockResolvedValue({
      status: 200,
      headers: {},
      bodyBase64: "",
    });

    await run([
      "https://example.com",
      "--header", "Accept=text/html",
      "--header", "Authorization=Bearer tok",
    ]);

    expect(callTool).toHaveBeenCalledWith("web.fetch", {
      url: "https://example.com",
      headers: {
        Accept: "text/html",
        Authorization: "Bearer tok",
      },
    });
  });
});
