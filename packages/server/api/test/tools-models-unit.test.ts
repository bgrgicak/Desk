/**
 * Unit tests for the listModels route handler. These mock the runtime's
 * listModels so they don't need Docker or real API keys. They cover
 * edge-case error handling that the integration test (tools-models.integration.test.ts)
 * doesn't exercise: missing workspace (404) and decryption failure fallback.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@agent-desk/db", () => ({
  queries: {
    workspaces: {
      list: vi.fn(),
    },
  },
}));

vi.mock("../src/providerKeys.js", () => ({
  resolveProviderKeys: vi.fn(),
}));

vi.mock("@agent-desk/runtime", () => ({
  listModels: vi.fn(),
  resolveLocalSourceEnv: vi.fn(async () => ({})),
  SandboxExecError: class SandboxExecError extends Error {
    exitCode: number;
    stderr: string;
    constructor(message: string, exitCode: number, stderr: string) {
      super(message);
      this.exitCode = exitCode;
      this.stderr = stderr;
    }
  },
}));

import { queries } from "@agent-desk/db";
import { resolveProviderKeys } from "../src/providerKeys.js";
import { listModels as runtimeListModels } from "@agent-desk/runtime";
import { listModels, expandOpenAiBySource } from "../src/routes/tools.js";

const fakePool = {} as never;
const fakeWorkspace = { id: "wks_test", path: "desk", user_id: "usr_1", name: "Desk" };

const FREE_MODELS = [
  { id: "anthropic/claude-haiku-4-5", provider: "anthropic" },
  { id: "anthropic/claude-haiku-4-5", provider: "anthropic" },
];
const ALL_MODELS = [
  ...FREE_MODELS,
  { id: "openai/gpt-5", provider: "openai" },
];
const CODEX_ONLY_MODELS = [
  ...FREE_MODELS,
  { id: "openai-codex/gpt-5.4", provider: "openai-codex" },
  { id: "openai-codex/gpt-5.5", provider: "openai-codex" },
];
const BOTH_OPENAI_CHANNELS = [
  ...FREE_MODELS,
  { id: "openai/gpt-4o", provider: "openai" },
  { id: "openai/gpt-5", provider: "openai" },
  { id: "openai-codex/gpt-5.5", provider: "openai-codex" },
];

beforeEach(() => {
  vi.resetAllMocks();
});

describe("listModels — no workspace", () => {
  it("throws NotFoundError when no workspace is available", async () => {
    vi.mocked(queries.workspaces.list).mockResolvedValue([]);

    await expect(listModels(fakePool, undefined, {})).rejects.toThrow("No sandbox available");
  });
});

describe("listModels — decryption failure fallback", () => {
  it("returns models even when resolveProviderKeys throws", async () => {
    vi.mocked(queries.workspaces.list).mockResolvedValue([fakeWorkspace] as never);
    vi.mocked(resolveProviderKeys).mockRejectedValue(new Error("Decryption failed: bad tag"));
    vi.mocked(runtimeListModels).mockResolvedValue(FREE_MODELS);

    const models = await listModels(fakePool, undefined, {});
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.id.startsWith(`${m.provider}/`))).toBe(true);
    // Called with empty keys (fallback)
    expect(runtimeListModels).toHaveBeenCalledWith(fakeWorkspace.id, fakeWorkspace.path, {
      provider: undefined,
      providerKeys: {},
      env: {},
    });
  });
});

describe("expandOpenAiBySource — pi's openai-codex/* → Desk's codex/* relabel", () => {
  it("relabels openai-codex/* → codex/* and passes other providers through", () => {
    const models = [
      { id: "anthropic/claude-haiku-4-5", provider: "anthropic" },
      { id: "openai/gpt-5.4", provider: "openai" },
      { id: "openai-codex/gpt-5.4", provider: "openai-codex" },
      { id: "openai-codex/gpt-5.5", provider: "openai-codex" },
      { id: "anthropic/claude-4-7", provider: "anthropic" },
    ];
    const out = expandOpenAiBySource(models);

    // openai-codex/* gets the Desk UI prefix; runtime translates it back.
    expect(out.find((m) => m.id === "codex/gpt-5.4")?.provider).toBe("codex");
    expect(out.find((m) => m.id === "codex/gpt-5.5")?.provider).toBe("codex");
    // The raw openai-codex/* entries are replaced, not duplicated.
    expect(out.some((m) => m.id.startsWith("openai-codex/"))).toBe(false);
    // openai/* (API-key path) passes through verbatim.
    expect(out.find((m) => m.id === "openai/gpt-5.4")?.provider).toBe("openai");
    // Non-OpenAI providers are untouched.
    expect(out.find((m) => m.id === "anthropic/claude-4-7")?.provider).toBe("anthropic");
    expect(out.find((m) => m.id === "anthropic/claude-haiku-4-5")?.provider).toBe("anthropic");
  });

  it("is a no-op when pi did not emit any openai-codex/* models", () => {
    const models = [
      { id: "openai/gpt-5", provider: "openai" },
      { id: "anthropic/claude-4-7", provider: "anthropic" },
    ];
    const out = expandOpenAiBySource(models);
    expect(out.find((m) => m.id === "openai/gpt-5")?.provider).toBe("openai");
    expect(out.some((m) => m.provider === "codex")).toBe(false);
  });
});

describe("listModels — happy path", () => {
  it("returns all models when no provider filter is given", async () => {
    vi.mocked(queries.workspaces.list).mockResolvedValue([fakeWorkspace] as never);
    vi.mocked(resolveProviderKeys).mockResolvedValue({ OPENAI_API_KEY: "sk-test", GITHUB_TOKEN: "github_pat_test" });
    vi.mocked(runtimeListModels).mockResolvedValue(ALL_MODELS);

    const models = await listModels(fakePool, undefined, {});
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m) => m.provider === "openai")).toBe(true);
    expect(runtimeListModels).toHaveBeenCalledWith(fakeWorkspace.id, fakeWorkspace.path, {
      provider: undefined,
      providerKeys: { OPENAI_API_KEY: "sk-test" },
      env: {},
    });
  });

  it("re-IDs pi's openai-codex/* as 'codex/*' when only Codex auth is active", async () => {
    vi.mocked(queries.workspaces.list).mockResolvedValue([fakeWorkspace] as never);
    vi.mocked(resolveProviderKeys).mockResolvedValue({});
    const { resolveLocalSourceEnv } = await import("@agent-desk/runtime");
    vi.mocked(resolveLocalSourceEnv as unknown as (..._args: unknown[]) => Promise<Record<string, string>>)
      .mockResolvedValue({ PI_AUTH_JSON_BASE64: "abc" });
    // Mirrors pi's real output with only the OAuth blob present: only the
    // openai-codex channel is listed.
    vi.mocked(runtimeListModels).mockResolvedValue(CODEX_ONLY_MODELS);

    const models = await listModels(fakePool, undefined, { userId: "usr_1" });
    // No raw openai-codex/* leaks through — it's relabeled.
    expect(models.some((m) => m.id.startsWith("openai-codex/"))).toBe(false);
    // No openai/* either — pi didn't list any (no API key).
    expect(models.some((m) => m.id.startsWith("openai/"))).toBe(false);
    const codex = models.filter((m) => m.id.startsWith("codex/"));
    expect(codex.length).toBeGreaterThan(0);
    expect(codex.every((m) => m.provider === "codex")).toBe(true);
  });

  it("emits both openai/* and codex/* when pi lists both channels", async () => {
    vi.mocked(queries.workspaces.list).mockResolvedValue([fakeWorkspace] as never);
    vi.mocked(resolveProviderKeys).mockResolvedValue({ OPENAI_API_KEY: "sk-test" });
    const { resolveLocalSourceEnv } = await import("@agent-desk/runtime");
    vi.mocked(resolveLocalSourceEnv as unknown as (..._args: unknown[]) => Promise<Record<string, string>>)
      .mockResolvedValue({ PI_AUTH_JSON_BASE64: "abc" });
    vi.mocked(runtimeListModels).mockResolvedValue(BOTH_OPENAI_CHANNELS);

    const models = await listModels(fakePool, undefined, { userId: "usr_1" });
    expect(models.find((m) => m.id === "openai/gpt-5")?.provider).toBe("openai");
    expect(models.find((m) => m.id === "codex/gpt-5.5")?.provider).toBe("codex");
  });

  it("filters by provider", async () => {
    vi.mocked(queries.workspaces.list).mockResolvedValue([fakeWorkspace] as never);
    vi.mocked(resolveProviderKeys).mockResolvedValue({});
    vi.mocked(runtimeListModels).mockResolvedValue(FREE_MODELS);

    const models = await listModels(fakePool, undefined, { provider: "anthropic" });
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.provider === "anthropic")).toBe(true);
    expect(runtimeListModels).toHaveBeenCalledWith(fakeWorkspace.id, fakeWorkspace.path, {
      provider: "anthropic",
      providerKeys: {},
      env: {},
    });
  });
});
