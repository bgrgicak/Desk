/**
 * Unit tests for resolveOpenAiBillingSource — the run-time translation that
 * converts a Desk-only `codex/<name>` model id back to OpenCode's
 * `openai/<name>` while stripping OPENAI_API_KEY so the sandbox routes
 * through the Codex OAuth blob instead of the cloud key.
 */
import { describe, it, expect } from "vitest";
import { resolveOpenAiBillingSource } from "../src/runs.js";

describe("resolveOpenAiBillingSource", () => {
  it("passes through non-codex model ids and keys untouched", () => {
    const keys = { OPENAI_API_KEY: "sk-xxx", ANTHROPIC_API_KEY: "sk-ant" };
    const out = resolveOpenAiBillingSource("openai/gpt-5.4", keys);
    expect(out.runtimeModel).toBe("openai/gpt-5.4");
    // Same reference — no clone when nothing changes.
    expect(out.providerKeys).toBe(keys);
  });

  it("rewrites codex/* → openai/* and strips OPENAI_API_KEY", () => {
    const out = resolveOpenAiBillingSource("codex/gpt-5.4", {
      OPENAI_API_KEY: "sk-xxx",
      ANTHROPIC_API_KEY: "sk-ant",
    });
    expect(out.runtimeModel).toBe("openai/gpt-5.4");
    expect(out.providerKeys).toEqual({ ANTHROPIC_API_KEY: "sk-ant" });
    expect(out.providerKeys.OPENAI_API_KEY).toBeUndefined();
  });

  it("handles codex/* when no OPENAI_API_KEY is set", () => {
    const out = resolveOpenAiBillingSource("codex/gpt-5.4-mini", {});
    expect(out.runtimeModel).toBe("openai/gpt-5.4-mini");
    expect(out.providerKeys).toEqual({});
  });

  it("preserves the suffix verbatim — including dots and dashes", () => {
    const out = resolveOpenAiBillingSource("codex/gpt-4o-2024-11-20", {});
    expect(out.runtimeModel).toBe("openai/gpt-4o-2024-11-20");
  });
});
