import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sandboxImage } from "../src/docker.js";

describe("sandboxImage", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.DESK_SANDBOX_IMAGE;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.DESK_SANDBOX_IMAGE;
    } else {
      process.env.DESK_SANDBOX_IMAGE = originalEnv;
    }
  });

  it("defaults to desk/sandbox:v1 when DESK_SANDBOX_IMAGE is unset", () => {
    delete process.env.DESK_SANDBOX_IMAGE;
    expect(sandboxImage()).toBe("desk/sandbox:v1");
  });

  it("returns DESK_SANDBOX_IMAGE when set (registry-published path)", () => {
    process.env.DESK_SANDBOX_IMAGE = "agentdesk/sandbox:0.1.0-alpha.0";
    expect(sandboxImage()).toBe("agentdesk/sandbox:0.1.0-alpha.0");
  });

  it("re-reads the env on every call (no import-time caching)", () => {
    delete process.env.DESK_SANDBOX_IMAGE;
    expect(sandboxImage()).toBe("desk/sandbox:v1");
    process.env.DESK_SANDBOX_IMAGE = "ghcr.io/bgrgicak/desk-sandbox:dev";
    expect(sandboxImage()).toBe("ghcr.io/bgrgicak/desk-sandbox:dev");
  });
});
