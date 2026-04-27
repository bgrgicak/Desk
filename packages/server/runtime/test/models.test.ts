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
      { id: "anthropic/claude-opus-4-7", provider: "anthropic" },
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

describe("listModels (fake sandbox)", () => {
  it("returns a non-empty model list", async () => {
    const models = await listModels("agt_test", "desk");
    expect(models.length).toBeGreaterThan(0);
    expect(models[0].id.includes("/")).toBe(true);
    expect(models[0].provider).toBe(models[0].id.split("/")[0]);
  });

  it("filters by provider", async () => {
    const models = await listModels("agt_test", "desk", { provider: "opencode" });
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.provider === "opencode")).toBe(true);
  });
});
