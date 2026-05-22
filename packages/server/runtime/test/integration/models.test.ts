/**
 * Integration test: queries the real `pi --list-models` output inside a
 * real Docker sandbox. Verifies the host → sandbox exec primitive and the
 * parser against pi's actual columnar output — the fake driver can't
 * prove that.
 *
 * Gated on Docker availability AND on a provider credential being
 * present. Pi shows nothing until it has at least one authenticated
 * provider, so the only useful integration assertion is "a real key
 * yields real models." We use OPENAI_API_KEY because the openai model
 * list is published locally and doesn't require an API round-trip.
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
// Pi requires at least one authenticated provider to list any models.
// Any test API key suffices; the listing itself is local to the sandbox.
const TEST_PROVIDER_KEY = process.env.DESK_TEST_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY;
if (!TEST_PROVIDER_KEY) SKIP = true;
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

  it("listModels parses pi's column table into provider/model pairs", async () => {
    const handle = await createOrReuse(testWorkspaceId, testWorkspaceSlug, home);

    const providerKeys = { OPENAI_API_KEY: TEST_PROVIDER_KEY! };
    const all = await listModels(testWorkspaceId, testWorkspaceSlug, { providerKeys });
    expect(all.length).toBeGreaterThan(0);
    for (const m of all) {
      expect(m.provider).toMatch(/^[A-Za-z0-9_.-]+$/);
      expect(m.id.startsWith(`${m.provider}/`)).toBe(true);
      expect(m.id.length).toBeGreaterThan(m.provider.length + 1);
    }

    // OpenAI keys must surface at least one openai model since pi ships
    // the full model registry locally — no API round-trip.
    expect(all.some((m) => m.provider === "openai")).toBe(true);

    await stopSandbox(handle);
  }, 60_000);
});
