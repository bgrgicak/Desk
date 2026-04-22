import { describe, it, expect, beforeAll } from "vitest";
import { listModels, parseModelsOutput } from "../src/models.js";

beforeAll(() => {
  process.env.DESK_SANDBOX_DRIVER = "fake";
});

describe("parseModelsOutput", () => {
  it("parses provider/model lines", () => {
    const out = parseModelsOutput(
      "anthropic/claude-opus-4-7\nopenai/gpt-5\n  \nopencode/big-pickle\n",
    );
    expect(out).toEqual([
      { providerId: "anthropic", modelId: "claude-opus-4-7", fullId: "anthropic/claude-opus-4-7" },
      { providerId: "openai", modelId: "gpt-5", fullId: "openai/gpt-5" },
      { providerId: "opencode", modelId: "big-pickle", fullId: "opencode/big-pickle" },
    ]);
  });

  it("ignores blank lines and malformed entries", () => {
    const out = parseModelsOutput("\nnoslash\n/justmodel\nprovider/\nok/yes");
    expect(out).toEqual([
      { providerId: "ok", modelId: "yes", fullId: "ok/yes" },
    ]);
  });
});

describe("listModels (fake sandbox)", () => {
  it("returns a non-empty model list", async () => {
    const models = await listModels("agt_test");
    expect(models.length).toBeGreaterThan(0);
    expect(models[0].fullId.includes("/")).toBe(true);
  });

  it("filters by provider", async () => {
    const models = await listModels("agt_test", { provider: "anthropic" });
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.providerId === "anthropic")).toBe(true);
  });
});
