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
      "opencode/gpt-5-nano\nopenai/gpt-5\n  \nopencode/big-pickle\n",
    );
    expect(out).toEqual([
      { id: "opencode/gpt-5-nano", provider: "opencode" },
      { id: "openai/gpt-5", provider: "openai" },
      { id: "opencode/big-pickle", provider: "opencode" },
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
      { id: "opencode/big-pickle", provider: "opencode" },
    ]);
    await expect(listModels("wks_test", "desk", { provider: "opencode" })).resolves.toEqual([
      { id: "opencode/big-pickle", provider: "opencode" },
    ]);
    await expect(listModels("wks_test", "desk", { provider: "openai" })).resolves.toEqual([]);
  });
});
