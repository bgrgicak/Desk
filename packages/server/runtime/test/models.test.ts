import { afterEach, describe, it, expect } from "vitest";
import { listModels, parseModelsOutput } from "../src/models.js";

const originalSandboxDriver = process.env.DESK_SANDBOX_DRIVER;

afterEach(() => {
  if (originalSandboxDriver === undefined) {
    delete process.env.DESK_SANDBOX_DRIVER;
  } else {
    process.env.DESK_SANDBOX_DRIVER = originalSandboxDriver;
  }
});

describe("parseModelsOutput", () => {
  it("parses provider/model lines", () => {
    const out = parseModelsOutput(
      "opencode/big-pickle\nopenai/gpt-5\n  \nopencode/hy3-preview-free\n",
    );
    expect(out).toEqual([
      { id: "opencode/big-pickle", provider: "opencode" },
      { id: "openai/gpt-5", provider: "openai" },
      { id: "opencode/hy3-preview-free", provider: "opencode" },
    ]);
  });

  it("parses verbose model limits", () => {
    const out = parseModelsOutput(`openai/gpt-5.5
{
  "id": "gpt-5.5",
  "providerID": "openai",
  "limit": {
    "context": 400000,
    "input": 272000,
    "output": 128000
  }
}
opencode/big-pickle
{
  "id": "big-pickle",
  "providerID": "opencode",
  "limit": {
    "context": 200000,
    "output": 128000
  }
}
`);

    expect(out).toEqual([
      { id: "openai/gpt-5.5", provider: "openai", contextWindow: 400000, inputLimit: 272000, outputLimit: 128000 },
      { id: "opencode/big-pickle", provider: "opencode", contextWindow: 200000, outputLimit: 128000 },
    ]);
  });

  it("ignores blank lines and malformed entries", () => {
    const out = parseModelsOutput("\nnoslash\n/justmodel\nprovider/\nok/yes");
    expect(out).toEqual([
      { id: "ok/yes", provider: "ok" },
    ]);
  });
});

describe("listModels", () => {
  it("returns free opencode models without a sandbox when the fake driver is active", async () => {
    process.env.DESK_SANDBOX_DRIVER = "fake";

    await expect(listModels("wks_test", "desk")).resolves.toEqual([
      { id: "opencode/big-pickle", provider: "opencode", contextWindow: 200_000, outputLimit: 128_000 },
    ]);
    await expect(listModels("wks_test", "desk", { provider: "opencode" })).resolves.toEqual([
      { id: "opencode/big-pickle", provider: "opencode", contextWindow: 200_000, outputLimit: 128_000 },
    ]);
    await expect(listModels("wks_test", "desk", { provider: "openai" })).resolves.toEqual([]);
  });
});
