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
  it("parses pi's column-table output", () => {
    const out = parseModelsOutput(
      [
        "provider  model                  context  max-out  thinking  images",
        "openai    gpt-4                  8.2K     8.2K     no        no    ",
        "openai    gpt-5                  400K     128K     yes       yes   ",
        "anthropic claude-haiku-4-5       200K     64K      no        yes   ",
        "",
      ].join("\n"),
    );
    expect(out).toEqual([
      { id: "openai/gpt-4", provider: "openai" },
      { id: "openai/gpt-5", provider: "openai" },
      { id: "anthropic/claude-haiku-4-5", provider: "anthropic" },
    ]);
  });

  it("returns empty list when pi prints the no-providers banner", () => {
    const out = parseModelsOutput(
      "No models available. Use /login to log into a provider via OAuth or API key. See:\n  /usr/local/lib/node_modules/@earendil-works/pi-coding-agent/docs/providers.md\n",
    );
    expect(out).toEqual([]);
  });

  it("ignores rows with malformed provider/model tokens", () => {
    const out = parseModelsOutput(
      [
        "provider  model                  context",
        "ok        yes                    1K",
        "bad/prov  whatever               1K",
        "spaced    name with spaces       1K",
      ].join("\n"),
    );
    // The "spaced" row still parses — the model column is just the first
    // whitespace-separated token. Pi's real output never embeds spaces in
    // model ids, so this matches reality.
    expect(out).toEqual([
      { id: "ok/yes", provider: "ok" },
      { id: "spaced/name", provider: "spaced" },
    ]);
  });
});

describe("listModels", () => {
  it("returns the fake-driver model set without a sandbox when DESK_SANDBOX_DRIVER=fake", async () => {
    process.env.DESK_SANDBOX_DRIVER = "fake";

    // Unfiltered: every fake model surfaces (free `opencode/big-pickle`
    // + a claude entry so consumers can exercise auth-required paths).
    const all = await listModels("wks_test", "desk");
    expect(all.some((m) => m.id === "opencode/big-pickle")).toBe(true);
    expect(all.some((m) => m.id === "anthropic/claude-haiku-4-5")).toBe(true);

    // Filtered to anthropic — only the claude entry remains.
    await expect(listModels("wks_test", "desk", { provider: "anthropic" })).resolves.toEqual([
      { id: "anthropic/claude-haiku-4-5", provider: "anthropic", contextWindow: 200_000, outputLimit: 64_000 },
    ]);
    // openai isn't seeded in the fake driver.
    await expect(listModels("wks_test", "desk", { provider: "openai" })).resolves.toEqual([]);
  });
});
