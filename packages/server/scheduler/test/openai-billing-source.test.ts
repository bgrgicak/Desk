/**
 * Unit tests for the run-time model resolver.
 *
 * `resolveModelForRun` translates Desk-only `codex/*` ids back to
 * opencode-serve's `openai/*`, strips `OPENAI_API_KEY` only when the
 * OAuth path is actually available, and — the part this file pins for
 * regression — falls back to the free `FALLBACK_MODEL` whenever the
 * requested model's provider has no live auth at all. Without that
 * fallback, a chat whose agent still says `codex/X` or `openai/X`
 * after the user disables every provider in Settings stalls on a
 * `ProviderModelNotFoundError` or silently rides a stale OAuth blob
 * the daemon cached from a previous spawn.
 *
 * `resolveOpenAiBillingSource` is kept as a thin compatibility shim;
 * the original test cases below still exercise it to lock the
 * Codex-translation surface that other code paths rely on.
 */
import { describe, it, expect } from "vitest";
import {
  resolveOpenAiBillingSource,
  resolveModelForRun,
  FALLBACK_MODEL,
} from "../src/runs.js";

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

describe("resolveModelForRun — fallback when no provider auth is live", () => {
  it("falls back to FALLBACK_MODEL when codex/* has neither OAuth nor an API key", () => {
    // The user-reported scenario: agent.model = codex/X, user disabled
    // Codex AND OPENAI_API_KEY in Settings. Before the fallback the
    // run would either fail with `ProviderModelNotFoundError` or — if
    // the daemon's stale auth file still held an OAuth blob — silently
    // run against a "disabled" provider. With the fallback it just
    // runs on the free default.
    const out = resolveModelForRun("codex/gpt-5.5-fast", {}, {});
    expect(out.runtimeModel).toBe(FALLBACK_MODEL);
    expect(out.reason).toBe("no-auth-fallback");
  });

  it("falls back when openai/* is requested but OPENAI_API_KEY is empty/missing", () => {
    const out = resolveModelForRun("openai/gpt-5", {}, {});
    expect(out.runtimeModel).toBe(FALLBACK_MODEL);
    expect(out.reason).toBe("no-auth-fallback");
  });

  it("keeps openai/* when OPENAI_API_KEY is set", () => {
    const out = resolveModelForRun("openai/gpt-5", { OPENAI_API_KEY: "sk" }, {});
    expect(out.runtimeModel).toBe("openai/gpt-5");
    expect(out.reason).toBeNull();
  });

  it("keeps openai/* when only Codex OAuth is available (OAuth covers the openai provider)", () => {
    // OPENCODE_AUTH_CONTENT registers an `openai` auth in opencode-
    // serve, so an `openai/<name>` model picked from the Desk UI can
    // still run via OAuth even with no API key set.
    const out = resolveModelForRun("openai/gpt-5", {}, oauth);
    expect(out.runtimeModel).toBe("openai/gpt-5");
    expect(out.reason).toBeNull();
  });

  it("falls back when anthropic/* is requested but ANTHROPIC_API_KEY is missing", () => {
    const out = resolveModelForRun("anthropic/claude-3-5-sonnet", {}, {});
    expect(out.runtimeModel).toBe(FALLBACK_MODEL);
    expect(out.reason).toBe("no-auth-fallback");
  });

  it("keeps anthropic/* when its key is present", () => {
    const out = resolveModelForRun(
      "anthropic/claude-3-5-sonnet",
      { ANTHROPIC_API_KEY: "sk-ant" },
      {},
    );
    expect(out.runtimeModel).toBe("anthropic/claude-3-5-sonnet");
    expect(out.reason).toBeNull();
  });

  it("passes free opencode/* models through unchanged regardless of provider state", () => {
    // Free models don't need auth, so they always run as-is even when
    // every cloud provider is disabled.
    const out = resolveModelForRun("opencode/big-pickle", {}, {});
    expect(out.runtimeModel).toBe("opencode/big-pickle");
    expect(out.reason).toBeNull();
  });

  it("flags the codex-OAuth path with the right reason for logging", () => {
    const out = resolveModelForRun("codex/gpt-5", { OPENAI_API_KEY: "sk" }, oauth);
    expect(out.runtimeModel).toBe("openai/gpt-5");
    expect(out.reason).toBe("codex-oauth");
    expect(out.providerKeys.OPENAI_API_KEY).toBeUndefined();
  });

  it("flags the codex-API-key fallback path with the right reason", () => {
    const out = resolveModelForRun("codex/gpt-5", { OPENAI_API_KEY: "sk" }, {});
    expect(out.runtimeModel).toBe("openai/gpt-5");
    expect(out.reason).toBe("codex-fallback-api-key");
    // The API key STAYS in providerKeys here — without it the daemon
    // couldn't authenticate the openai provider at all.
    expect(out.providerKeys.OPENAI_API_KEY).toBe("sk");
  });
});
