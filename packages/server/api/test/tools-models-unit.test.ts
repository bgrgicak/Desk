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
import { listModels } from "../src/routes/tools.js";

const fakePool = {} as never;
const fakeWorkspace = { id: "wks_test", path: "desk", user_id: "usr_1", name: "Desk" };

const FREE_MODELS = [
  { id: "opencode/big-pickle", provider: "opencode" },
  { id: "opencode/gpt-5-nano", provider: "opencode" },
];
const ALL_MODELS = [
  ...FREE_MODELS,
  { id: "openai/gpt-5", provider: "openai" },
];

beforeEach(() => {
  vi.resetAllMocks();
});

describe("listModels — no workspace", () => {
  it("throws NotFoundError when no workspace is available", async () => {
    vi.mocked(queries.workspaces.list).mockResolvedValue([]);

    await expect(listModels(fakePool, {})).rejects.toThrow("No sandbox available");
  });
});

describe("listModels — decryption failure fallback", () => {
  it("returns models even when resolveProviderKeys throws", async () => {
    vi.mocked(queries.workspaces.list).mockResolvedValue([fakeWorkspace] as never);
    vi.mocked(resolveProviderKeys).mockRejectedValue(new Error("Decryption failed: bad tag"));
    vi.mocked(runtimeListModels).mockResolvedValue(FREE_MODELS);

    const models = await listModels(fakePool, {});
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.id.startsWith(`${m.provider}/`))).toBe(true);
    // Called with empty keys (fallback)
    expect(runtimeListModels).toHaveBeenCalledWith(fakeWorkspace.id, fakeWorkspace.path, {
      provider: undefined,
      providerKeys: {},
    });
  });
});

describe("listModels — happy path", () => {
  it("returns all models when no provider filter is given", async () => {
    vi.mocked(queries.workspaces.list).mockResolvedValue([fakeWorkspace] as never);
    vi.mocked(resolveProviderKeys).mockResolvedValue({ OPENAI_API_KEY: "sk-test" });
    vi.mocked(runtimeListModels).mockResolvedValue(ALL_MODELS);

    const models = await listModels(fakePool, {});
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m) => m.provider === "openai")).toBe(true);
  });

  it("filters by provider", async () => {
    vi.mocked(queries.workspaces.list).mockResolvedValue([fakeWorkspace] as never);
    vi.mocked(resolveProviderKeys).mockResolvedValue({});
    vi.mocked(runtimeListModels).mockResolvedValue(FREE_MODELS);

    const models = await listModels(fakePool, { provider: "opencode" });
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.provider === "opencode")).toBe(true);
    expect(runtimeListModels).toHaveBeenCalledWith(fakeWorkspace.id, fakeWorkspace.path, {
      provider: "opencode",
      providerKeys: {},
    });
  });
});
