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

  it("sets DESK_RUN_BIN in the env file so at/cron jobs can find desk-run", () => {
    expect(script).toContain("DESK_RUN_BIN=");
  });

  it("falls back to UID 2000 + ACLs if the host UID collides with a system user", () => {
    // Without the fallback, useradd --uid $HOST_UID fails the whole
    // provision when the host UID happens to clash with a Lima/Ubuntu
    // system account (messagebus, systemd-resolve, etc).
    expect(script).toMatch(/useradd[^\n]*--uid 2000/);
    expect(script).toContain("setfacl");
  });
});

describe("dev-override.conf static checks", () => {
  const confPath = resolve(import.meta.dirname, "../dev-override.conf");
  const conf = readFileSync(confPath, "utf-8");

  it("sets DESK_RUN_BIN so at/cron jobs find desk-run in dev mode", () => {
    expect(conf).toContain("DESK_RUN_BIN=");
  });
});
