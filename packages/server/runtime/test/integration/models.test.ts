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
import { ensureLayout } from "@desk/storage";
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

const SKIP = !dockerAvailable();
const describeIf = SKIP ? describe.skip : describe;

let home: string;
const testAgentId = "agt_models_int_test";

beforeAll(async () => {
  if (SKIP) return;
  delete process.env.DESK_SANDBOX_DRIVER;
  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-models-int-"));
  await ensureLayout(home);
  process.env.DESK_HOME = home;
});

afterAll(async () => {
  if (SKIP) return;
  try {
    const Docker = (await import("dockerode")).default;
    const docker = new Docker({ socketPath: dockerSocketPath() });
    const container = docker.getContainer(`desk-sandbox-${testAgentId}`);
    await container.stop({ t: 2 }).catch(() => {});
    await container.remove({ force: true }).catch(() => {});
  } catch { /* ok */ }
  if (home) await fs.rm(home, { recursive: true, force: true });
});

describeIf("sandbox model listing (real Docker)", () => {
  it("execInSandbox captures stdout from a simple command", async () => {
    const handle = await createOrReuse(testAgentId, home);
    const result = await execInSandbox(testAgentId, { argv: ["echo", "hi"] });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hi");
    expect(result.timedOut).toBe(false);
    await stopSandbox(handle);
  }, 60_000);

  it("listModels returns real provider/model pairs from opencode", async () => {
    const handle = await createOrReuse(testAgentId, home);

    const all = await listModels(testAgentId);
    expect(all.length).toBeGreaterThan(0);
    for (const m of all) {
      expect(m.providerId).toMatch(/^[A-Za-z0-9_.-]+$/);
      expect(m.modelId.length).toBeGreaterThan(0);
      expect(m.fullId).toBe(`${m.providerId}/${m.modelId}`);
    }

    // Anthropic must be present — it's the provider Desk ships with.
    expect(all.some((m) => m.providerId === "anthropic")).toBe(true);

    const filtered = await listModels(testAgentId, { provider: "anthropic" });
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every((m) => m.providerId === "anthropic")).toBe(true);

    await stopSandbox(handle);
  }, 60_000);
});
