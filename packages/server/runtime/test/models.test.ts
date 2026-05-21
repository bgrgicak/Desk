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
      "anthropic/claude-haiku-4-5\nopenai/gpt-5\n  \nanthropic/claude-opus-4-7\n",
    );
    expect(out).toEqual([
      { id: "anthropic/claude-haiku-4-5", provider: "anthropic" },
      { id: "openai/gpt-5", provider: "openai" },
      { id: "anthropic/claude-opus-4-7", provider: "anthropic" },
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
  it("returns the fake-driver model set without a sandbox when DESK_SANDBOX_DRIVER=fake", async () => {
    process.env.DESK_SANDBOX_DRIVER = "fake";

    await expect(listModels("wks_test", "desk")).resolves.toEqual([
      { id: "anthropic/claude-haiku-4-5", provider: "anthropic", contextWindow: 200_000, outputLimit: 64_000 },
    ]);
    await expect(listModels("wks_test", "desk", { provider: "anthropic" })).resolves.toEqual([
      { id: "anthropic/claude-haiku-4-5", provider: "anthropic", contextWindow: 200_000, outputLimit: 64_000 },
    ]);
    await expect(listModels("wks_test", "desk", { provider: "openai" })).resolves.toEqual([]);
  });
});
