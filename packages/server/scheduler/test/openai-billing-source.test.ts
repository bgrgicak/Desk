/**
 * Unit tests for the run-time model resolver.
 *
 * `resolveModelForRun` translates Desk-only `codex/*` ids back to pi's
 * provider channels: `openai-codex/*` when the ChatGPT OAuth bridge is
 * available, or `openai/*` when only an API key is configured. Models
 * outside the codex prefix pass through unchanged. Missing-auth is
 * handled by pi itself — Desk no longer substitutes a fallback model.
 *
 * `resolveOpenAiBillingSource` is kept as a thin compatibility shim;
 * the original test cases below still exercise it to lock the
 * Codex-translation surface that other code paths rely on.
 */
import { describe, it, expect } from "vitest";
import {
  resolveOpenAiBillingSource,
  resolveModelChainForRun,
  resolveModelForRun,
} from "../src/runs.js";

// Pi consumes the OAuth blob via PI_AUTH_JSON_BASE64 — the legacy
// OPENCODE_AUTH_CONTENT key is still emitted by localSources/codex.ts as
// the "is OAuth available" signal the resolver reads from.
const oauth = { OPENCODE_AUTH_CONTENT: "{\"openai-codex\":{\"type\":\"oauth\"}}" };

describe("resolveOpenAiBillingSource", () => {
  it("passes through non-codex model ids and keys untouched", () => {
    const keys = { OPENAI_API_KEY: "sk-xxx", ANTHROPIC_API_KEY: "sk-ant" };
    const out = resolveOpenAiBillingSource("openai/gpt-5.4", keys, oauth);
    expect(out.runtimeModel).toBe("openai/gpt-5.4");
    expect(out.providerKeys).toBe(keys);
  });

  it("rewrites codex/* → openai-codex/* when OAuth is present (keys untouched)", () => {
    const out = resolveOpenAiBillingSource(
      "codex/gpt-5.4",
      { OPENAI_API_KEY: "sk-xxx", ANTHROPIC_API_KEY: "sk-ant" },
      oauth,
    );
    expect(out.runtimeModel).toBe("openai-codex/gpt-5.4");
    expect(out.providerKeys.OPENAI_API_KEY).toBe("sk-xxx");
    expect(out.providerKeys.ANTHROPIC_API_KEY).toBe("sk-ant");
  });

  it("rewrites codex/* → openai/* when OAuth is NOT available but an API key is", () => {
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
    expect(out.runtimeModel).toBe("openai/gpt-5.4");
  });

  it("handles codex/* when no OPENAI_API_KEY is set (OAuth path)", () => {
    const out = resolveOpenAiBillingSource("codex/gpt-5.4-mini", {}, oauth);
    expect(out.runtimeModel).toBe("openai-codex/gpt-5.4-mini");
    expect(out.providerKeys).toEqual({});
  });

  it("preserves the suffix verbatim — including dots and dashes", () => {
    const out = resolveOpenAiBillingSource("codex/gpt-4o-2024-11-20", {}, oauth);
    expect(out.runtimeModel).toBe("openai-codex/gpt-4o-2024-11-20");
  });
});

describe("resolveModelForRun — auth-missing surfaces to pi (no Desk-side substitution)", () => {
  it("keeps codex/* on the openai-codex channel even when neither OAuth nor an API key is set, so pi raises a clear error", () => {
    // Previously Desk substituted a FALLBACK_MODEL when no auth was
    // live; that masked the real problem (missing connection). Now we
    // route to pi's expected channel and let pi report which provider
    // it can't authenticate.
    const out = resolveModelForRun("codex/gpt-5.5", {}, {});
    expect(out.runtimeModel).toBe("openai-codex/gpt-5.5");
    expect(out.reason).toBeNull();
  });

  it("passes openai/* through even when OPENAI_API_KEY is missing", () => {
    const out = resolveModelForRun("openai/gpt-5", {}, {});
    expect(out.runtimeModel).toBe("openai/gpt-5");
    expect(out.reason).toBeNull();
  });

  it("passes anthropic/* through even when ANTHROPIC_API_KEY is missing", () => {
    const out = resolveModelForRun("anthropic/claude-3-5-sonnet", {}, {});
    expect(out.runtimeModel).toBe("anthropic/claude-3-5-sonnet");
    expect(out.reason).toBeNull();
  });

  it("passes opencode/* through unchanged regardless of provider state", () => {
    const out = resolveModelForRun("opencode/big-pickle", {}, {});
    expect(out.runtimeModel).toBe("opencode/big-pickle");
    expect(out.reason).toBeNull();
  });

  it("flags the codex-OAuth path with the right reason for logging", () => {
    const out = resolveModelForRun("codex/gpt-5", { OPENAI_API_KEY: "sk" }, oauth);
    expect(out.runtimeModel).toBe("openai-codex/gpt-5");
    expect(out.reason).toBe("codex-oauth");
    expect(out.providerKeys.OPENAI_API_KEY).toBe("sk");
  });

  it("flags the codex-API-key fallback path with the right reason", () => {
    const out = resolveModelForRun("codex/gpt-5", { OPENAI_API_KEY: "sk" }, {});
    expect(out.runtimeModel).toBe("openai/gpt-5");
    expect(out.reason).toBe("codex-fallback-api-key");
    expect(out.providerKeys.OPENAI_API_KEY).toBe("sk");
  });

  it("passes raw openai-codex/* through unchanged", () => {
    // Agents persisted with the raw pi provider id should reach pi
    // verbatim — no extra translation, no fallback.
    const out = resolveModelForRun("openai-codex/gpt-5.5", {}, oauth);
    expect(out.runtimeModel).toBe("openai-codex/gpt-5.5");
    expect(out.reason).toBeNull();
  });
});

describe("resolveModelChainForRun", () => {
  it("resolves the primary model and all active fallbacks in order", () => {
    const out = resolveModelChainForRun(
      ["anthropic/claude-sonnet-4-6", "codex/gpt-5.5", "openai/gpt-5.4"],
      { OPENAI_API_KEY: "sk-openai" },
      oauth,
    );
    expect(out.runtimeModels).toEqual([
      "anthropic/claude-sonnet-4-6",
      "openai-codex/gpt-5.5",
      "openai/gpt-5.4",
    ]);
    expect(out.primary.runtimeModel).toBe("anthropic/claude-sonnet-4-6");
    expect(out.fallbackRuntimeModels).toEqual([
      "openai-codex/gpt-5.5",
      "openai/gpt-5.4",
    ]);
  });

  it("de-duplicates repeated model ids before resolving fallbacks", () => {
    const out = resolveModelChainForRun(
      ["codex/gpt-5.5", "codex/gpt-5.5", "openai/gpt-5.4"],
      { OPENAI_API_KEY: "sk-openai" },
      {},
    );
    expect(out.runtimeModels).toEqual(["openai/gpt-5.5", "openai/gpt-5.4"]);
  });
});
