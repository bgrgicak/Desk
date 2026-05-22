import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sandboxImage } from "../src/docker.js";

describe("sandboxImage", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.ROOMY_SANDBOX_IMAGE;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ROOMY_SANDBOX_IMAGE;
    } else {
      process.env.ROOMY_SANDBOX_IMAGE = originalEnv;
    }
  });

  it("defaults to roomy/sandbox:v1 when ROOMY_SANDBOX_IMAGE is unset", () => {
    delete process.env.ROOMY_SANDBOX_IMAGE;
    expect(sandboxImage()).toBe("roomy/sandbox:v1");
  });

  it("returns ROOMY_SANDBOX_IMAGE when set (registry-published path)", () => {
    process.env.ROOMY_SANDBOX_IMAGE = "agentroomy/sandbox:0.1.0-alpha.0";
    expect(sandboxImage()).toBe("agentroomy/sandbox:0.1.0-alpha.0");
  });

  it("re-reads the env on every call (no import-time caching)", () => {
    delete process.env.ROOMY_SANDBOX_IMAGE;
    expect(sandboxImage()).toBe("roomy/sandbox:v1");
    process.env.ROOMY_SANDBOX_IMAGE = "ghcr.io/bgrgicak/roomy-sandbox:dev";
    expect(sandboxImage()).toBe("ghcr.io/bgrgicak/roomy-sandbox:dev");
  });
});
