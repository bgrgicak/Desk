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

  it("parses Pi --list-models table output", () => {
    const out = parseModelsOutput(`provider        model                   context  max-out  thinking  images
github-copilot  claude-sonnet-4.5       144K     32K      yes       yes
openrouter      anthropic/claude-3.7    200K     16K      yes       no
google          gemini-3-pro-preview    1.0M     65.5K    yes       yes
`);
    expect(out).toEqual([
      { id: "github-copilot/claude-sonnet-4.5", provider: "github-copilot", contextWindow: 144_000, outputLimit: 32_000 },
      { id: "openrouter/anthropic/claude-3.7", provider: "openrouter", contextWindow: 200_000, outputLimit: 16_000 },
      { id: "google/gemini-3-pro-preview", provider: "google", contextWindow: 1_000_000, outputLimit: 65_500 },
    ]);
  });

  it("does not treat Pi no-provider guidance as model rows", () => {
    const out = parseModelsOutput(`No models available. Use /login to log into a provider via OAuth or API key. See:
  /opt/node/lib/node_modules/@earendil-works/pi-coding-agent/docs/providers.md
  /opt/node/lib/node_modules/@earendil-works/pi-coding-agent/docs/models.md
`);

    expect(out).toEqual([]);
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
