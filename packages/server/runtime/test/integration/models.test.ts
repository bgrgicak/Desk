/**
 * Integration test: queries the real `opencode models` list inside a real
 * Docker sandbox. Verifies the host → sandbox exec primitive and the parser
 * against OpenCode's actual output — the fake driver can't prove that.
 *
 * Gated on Docker availability. Does not require an API key (model listing
 * is a local registry query, not an API round-trip).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ensureLayout, ensureWorkspaceLayout } from "@agent-desk/storage";
import { createOrReuse, stopSandbox, sandboxImage } from "../../src/docker.js";
import { listModels } from "../../src/models.js";
import { execInSandbox } from "../../src/sandboxExec.js";
import { detectEngine, type Engine } from "../../src/engine.js";
import { rmTempTree } from "./helpers.js";

let engineForSetup: Engine | null = null;
let SKIP = false;
try {
  engineForSetup = await detectEngine();
  if (!(await engineForSetup.imageId(sandboxImage()))) SKIP = true;
} catch {
  SKIP = true;
}
const describeIf = SKIP ? describe.skip : describe;

let home: string;
const testWorkspaceId = "wks_models_int_test";
const testWorkspaceSlug = "models-int-test";

beforeAll(async () => {
  if (SKIP) return;
  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-models-int-"));
  await ensureLayout(home);
  await ensureWorkspaceLayout(home, testWorkspaceSlug);
  process.env.DESK_HOME = home;
});

afterAll(async () => {
  if (SKIP) return;
  if (engineForSetup) {
    await engineForSetup.remove(`desk-sandbox-${testWorkspaceId}`, true).catch(() => {});
  }
  if (home) await rmTempTree(home);
});

describeIf("sandbox model listing (real Docker)", () => {
  it("execInSandbox captures stdout from a simple command", async () => {
    const handle = await createOrReuse(testWorkspaceId, testWorkspaceSlug, home);
    const result = await execInSandbox(testWorkspaceId, testWorkspaceSlug, { argv: ["echo", "hi"] });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hi");
    expect(result.timedOut).toBe(false);
    await stopSandbox(handle);
  }, 60_000);

  it("listModels returns real provider/model pairs from opencode", async () => {
    const handle = await createOrReuse(testWorkspaceId, testWorkspaceSlug, home);

    const all = await listModels(testWorkspaceId, testWorkspaceSlug);
    expect(all.length).toBeGreaterThan(0);
    for (const m of all) {
      expect(m.provider).toMatch(/^[A-Za-z0-9_.-]+$/);
      expect(m.id.startsWith(`${m.provider}/`)).toBe(true);
      expect(m.id.length).toBeGreaterThan(m.provider.length + 1);
    }

    // Free opencode models must always be present — no API key required.
    expect(all.some((m) => m.provider === "opencode")).toBe(true);

    const filtered = await listModels(testWorkspaceId, testWorkspaceSlug, { provider: "opencode" });
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every((m) => m.provider === "opencode")).toBe(true);

    await stopSandbox(handle);
  }, 60_000);

  // Paid-provider tests — skipped when the corresponding key is absent.
  const itIfAnthropic = process.env.ANTHROPIC_API_KEY ? it : it.skip;
  itIfAnthropic("listModels filters to anthropic when key is present", async () => {
    const filtered = await listModels(testWorkspaceId, testWorkspaceSlug, {
      provider: "anthropic",
      providerKeys: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! },
    });
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every((m) => m.provider === "anthropic")).toBe(true);
    await stopSandbox(await createOrReuse(testWorkspaceId, testWorkspaceSlug, home));
  }, 60_000);

  const itIfOpenAI = process.env.OPENAI_API_KEY ? it : it.skip;
  itIfOpenAI("listModels filters to openai when key is present", async () => {
    const filtered = await listModels(testWorkspaceId, testWorkspaceSlug, {
      provider: "openai",
      providerKeys: { OPENAI_API_KEY: process.env.OPENAI_API_KEY! },
    });
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every((m) => m.provider === "openai")).toBe(true);
    await stopSandbox(await createOrReuse(testWorkspaceId, testWorkspaceSlug, home));
  }, 60_000);
});
