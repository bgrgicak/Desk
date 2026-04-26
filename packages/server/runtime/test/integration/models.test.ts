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
import { execFileSync } from "node:child_process";
import { ensureLayout, ensureWorkspaceLayout } from "@desk/storage";
import { createOrReuse, stopSandbox, dockerSocketPath } from "../../src/docker.js";
import { listModels } from "../../src/models.js";
import { execInSandbox } from "../../src/sandboxExec.js";

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// `opencode models` only emits providers that have a real key configured,
// so without ANTHROPIC_API_KEY the listing comes back empty and the
// "must contain an anthropic model" assertion can't be true. Mirror the
// gating from opencode.test.ts so this skips cleanly in keyless envs
// (CI without the secret) and runs everywhere it can.
const HAS_KEY = !!process.env.ANTHROPIC_API_KEY;
const SKIP = !dockerAvailable() || !HAS_KEY;
const describeIf = SKIP ? describe.skip : describe;

let home: string;
const testWorkspaceId = "wks_models_int_test";
const testWorkspaceSlug = "models-int-test";

beforeAll(async () => {
  if (SKIP) return;
  delete process.env.DESK_SANDBOX_DRIVER;
  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-models-int-"));
  await ensureLayout(home);
  await ensureWorkspaceLayout(home, testWorkspaceSlug);
  process.env.DESK_HOME = home;
});

afterAll(async () => {
  if (SKIP) return;
  try {
    const Docker = (await import("dockerode")).default;
    const docker = new Docker({ socketPath: dockerSocketPath() });
    const container = docker.getContainer(`desk-sandbox-${testWorkspaceId}`);
    await container.stop({ t: 2 }).catch(() => {});
    await container.remove({ force: true }).catch(() => {});
  } catch { /* ok */ }
  if (home) await fs.rm(home, { recursive: true, force: true });
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

    // Anthropic must be present — it's the provider Desk ships with.
    expect(all.some((m) => m.provider === "anthropic")).toBe(true);

    const filtered = await listModels(testWorkspaceId, testWorkspaceSlug, { provider: "anthropic" });
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every((m) => m.provider === "anthropic")).toBe(true);

    await stopSandbox(handle);
  }, 60_000);
});
