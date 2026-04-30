import { describe, it, expect } from "vitest";
import { parseModelsOutput } from "../src/models.js";

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
