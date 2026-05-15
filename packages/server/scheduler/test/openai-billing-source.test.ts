/**
 * Unit tests for resolveOpenAiBillingSource — the run-time translation that
 * converts a Desk-only `codex/<name>` model id back to OpenCode's
 * `openai/<name>`. Strips OPENAI_API_KEY only when the OAuth path
 * (OPENCODE_AUTH_CONTENT in extraEnv) is actually present; otherwise
 * the cloud key is preserved so `openai/*` still has a way to auth.
 */
import { describe, it, expect } from "vitest";
import { resolveOpenAiBillingSource } from "../src/runs.js";

const oauth = { OPENCODE_AUTH_CONTENT: "{\"openai\":{\"type\":\"oauth\"}}" };

describe("resolveOpenAiBillingSource", () => {
  it("passes through non-codex model ids and keys untouched", () => {
    const keys = { OPENAI_API_KEY: "sk-xxx", ANTHROPIC_API_KEY: "sk-ant" };
    const out = resolveOpenAiBillingSource("openai/gpt-5.4", keys, oauth);
    expect(out.runtimeModel).toBe("openai/gpt-5.4");
    expect(out.providerKeys).toBe(keys);
  });

  it("rewrites codex/* → openai/* and strips OPENAI_API_KEY when OAuth is present", () => {
    const out = resolveOpenAiBillingSource(
      "codex/gpt-5.4",
      { OPENAI_API_KEY: "sk-xxx", ANTHROPIC_API_KEY: "sk-ant" },
      oauth,
    );
    expect(out.runtimeModel).toBe("openai/gpt-5.4");
    expect(out.providerKeys).toEqual({ ANTHROPIC_API_KEY: "sk-ant" });
    expect(out.providerKeys.OPENAI_API_KEY).toBeUndefined();
  });

  it("rewrites codex/* but KEEPS OPENAI_API_KEY when OAuth is NOT available", () => {
    // The user disabled the codex local source — no OPENCODE_AUTH_CONTENT
    // in extraEnv. Without this fallback, an agent whose model still
    // says codex/X strands the run with no auth at all.
    const out = resolveOpenAiBillingSource(
      "codex/gpt-5.4",
      { OPENAI_API_KEY: "sk-xxx", ANTHROPIC_API_KEY: "sk-ant" },
      {},
    );
    expect(out.runtimeModel).toBe("openai/gpt-5.4");
    expect(out.providerKeys.OPENAI_API_KEY).toBe("sk-xxx");
    expect(out.providerKeys.ANTHROPIC_API_KEY).toBe("sk-ant");
  });

  it("treats an empty OPENCODE_AUTH_CONTENT string as 'OAuth not available'", () => {
    const out = resolveOpenAiBillingSource(
      "codex/gpt-5.4",
      { OPENAI_API_KEY: "sk-xxx" },
      { OPENCODE_AUTH_CONTENT: "" },
    );
    expect(out.providerKeys.OPENAI_API_KEY).toBe("sk-xxx");
  });

  it("handles codex/* when no OPENAI_API_KEY is set", () => {
    const out = resolveOpenAiBillingSource("codex/gpt-5.4-mini", {}, oauth);
    expect(out.runtimeModel).toBe("openai/gpt-5.4-mini");
    expect(out.providerKeys).toEqual({});
  });

  it("preserves the suffix verbatim — including dots and dashes", () => {
    const out = resolveOpenAiBillingSource("codex/gpt-4o-2024-11-20", {}, oauth);
    expect(out.runtimeModel).toBe("openai/gpt-4o-2024-11-20");
  });
});
