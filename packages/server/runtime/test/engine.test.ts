/**
 * Unit tests for the engine module.
 *
 * The CLI shim itself is exercised by integration tests under
 * `test/integration/sandbox.test.ts` (real docker / nerdctl). What this file
 * pins down is the small bit of pure logic that doesn't need a daemon:
 * detection ordering and the rejected-name preservation.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { detectEngine, _resetEngineCache, type EngineName } from "../src/engine.js";

const PRIOR_OVERRIDE = process.env.DESK_CONTAINER_ENGINE;
const PRIOR_PATH = process.env.PATH;

beforeEach(() => {
  _resetEngineCache();
});

afterEach(() => {
  if (PRIOR_OVERRIDE === undefined) delete process.env.DESK_CONTAINER_ENGINE;
  else process.env.DESK_CONTAINER_ENGINE = PRIOR_OVERRIDE;
  process.env.PATH = PRIOR_PATH;
  _resetEngineCache();
});

describe("detectEngine — DESK_CONTAINER_ENGINE override", () => {
  it("honors a docker override when docker is reachable", async () => {
    if (!(await binaryWorks("docker"))) {
      // Skip cleanly when neither runtime is present on the host.
      return;
    }
    process.env.DESK_CONTAINER_ENGINE = "docker";
    const engine = await detectEngine();
    expect(engine.name).toBe<EngineName>("docker");
  });

  it("honors a nerdctl override when nerdctl is reachable", async () => {
    if (!(await binaryWorks("nerdctl"))) return;
    process.env.DESK_CONTAINER_ENGINE = "nerdctl";
    const engine = await detectEngine();
    expect(engine.name).toBe<EngineName>("nerdctl");
  });

  it("throws a descriptive error when no runtime is available", async () => {
    // Neutralise PATH so neither binary can be found.
    process.env.PATH = "/nonexistent";
    delete process.env.DESK_CONTAINER_ENGINE;
    await expect(detectEngine()).rejects.toThrow(/No container runtime/);
  });
});

/** True if `<bin> info` exits 0 — same probe detectEngine uses. */
async function binaryWorks(name: EngineName): Promise<boolean> {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile(
      name,
      ["info", "--format", "{{.ID}}"],
      {
        env:
          name === "nerdctl"
            ? { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}` }
            : process.env,
        timeout: 3000,
      },
      (err) => resolve(!err),
    );
  });
}
