/**
 * Unit tests for the listModels route handler. These run against the fake
 * sandbox driver so they don't need Docker or real API keys. They cover
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

import { queries } from "@agent-desk/db";
import { resolveProviderKeys } from "../src/providerKeys.js";
import { listModels } from "../src/routes/tools.js";

const fakePool = {} as never;
const fakeWorkspace = { id: "wks_test", path: "desk", user_id: "usr_1", name: "Desk" };

beforeEach(() => {
  vi.resetAllMocks();
  process.env.DESK_SANDBOX_DRIVER = "fake";
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

    const models = await listModels(fakePool, {});
    // fake sandbox returns anthropic + openai models even with no keys
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.id.startsWith(`${m.provider}/`))).toBe(true);
  });
});

describe("listModels — happy path (fake sandbox)", () => {
  it("returns all models when no provider filter is given", async () => {
    vi.mocked(queries.workspaces.list).mockResolvedValue([fakeWorkspace] as never);
    vi.mocked(resolveProviderKeys).mockResolvedValue({ ANTHROPIC_API_KEY: "sk-test" });

    const models = await listModels(fakePool, {});
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m) => m.provider === "anthropic")).toBe(true);
  });

  it("filters by provider", async () => {
    vi.mocked(queries.workspaces.list).mockResolvedValue([fakeWorkspace] as never);
    vi.mocked(resolveProviderKeys).mockResolvedValue({});

    const models = await listModels(fakePool, { provider: "opencode" });
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.provider === "opencode")).toBe(true);
  });
});
