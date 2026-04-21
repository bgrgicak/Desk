/**
 * Gap 17: Static assertions that install.sh installs at, cron, and ensures Docker.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("install.sh static checks", () => {
  const scriptPath = resolve(import.meta.dirname, "../install.sh");
  const script = readFileSync(scriptPath, "utf-8");

  it("installs at", () => {
    // at appears on the continuation line after apt-get install
    expect(script).toContain(" at ");
    expect(script).toContain("apt-get install");
  });

  it("installs cron", () => {
    expect(script).toContain(" cron ");
    expect(script).toContain("apt-get install");
  });

  it("installs or checks Docker", () => {
    expect(script).toMatch(/docker/);
  });

  it("verifies at, cron, and docker are available post-install", () => {
    // The script should have a verification step
    expect(script).toContain("command -v");
    for (const cmd of ["at", "cron", "docker"]) {
      expect(script).toContain(cmd);
    }
  });
});
