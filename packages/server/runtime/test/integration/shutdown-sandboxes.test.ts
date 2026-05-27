import { describe, it, expect, afterAll } from "vitest";
import { detectEngine, type Engine } from "../../src/engine.js";
import { sandboxImage, stopRunningSandboxes } from "../../src/docker.js";

let engineForSetup: Engine | null = null;
let SKIP = false;
let skipReason = "";

try {
  engineForSetup = await detectEngine();
  if (!(await engineForSetup.imageId(sandboxImage()))) {
    SKIP = true;
    skipReason = `${sandboxImage()} image not present`;
  }
} catch (err) {
  SKIP = true;
  skipReason = `engine probe failed: ${(err as Error).message}`;
}

const describeIf = SKIP ? describe.skip : describe;
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const namePrefix = `roomy-sandbox-shutdown-test-${suffix}`;
const containerName = `${namePrefix}-one`;

afterAll(async () => {
  if (engineForSetup) {
    await engineForSetup.remove(containerName, true).catch(() => {});
  }
});

describeIf("shutdown sandbox cleanup (real Docker)", () => {
  it("stops a running Roomy sandbox container", async () => {
    if (SKIP) {
      console.warn(`[shutdown sandbox integration] skipped: ${skipReason}`);
      return;
    }
    const engine = engineForSetup!;
    await engine.create({
      name: containerName,
      image: sandboxImage(),
      user: "0:0",
      env: [],
      network: "none",
      binds: [],
    });

    await expect(stopRunningSandboxes({
      engine,
      namePrefix,
      graceSeconds: 1,
    })).resolves.toEqual([containerName]);

    const info = await engine.inspect(containerName);
    expect(info).not.toBeNull();
    expect(info?.running).toBe(false);
  }, 60_000);
});
