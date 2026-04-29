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

  it("creates `desk` at UID 2000 as the systemd service user", () => {
    // The service always runs as `desk`; anyone debugging the running
    // process should see a predictable name regardless of how the VM
    // was provisioned.
    expect(script).toMatch(/useradd[^\n]*--uid 2000[^\n]*desk\b/);
    expect(script).toMatch(/^User=desk$/m);
  });

  it("pre-creates desk-owned subdirs under /home/desk/Desk", () => {
    // Mount root ownership is host-driven and can't be chown'd from
    // inside the VM (chown EINVAL on virtiofs/9p). Pre-creating each
    // top-level subdir as desk:desk gives the service write access
    // without requiring write on the mount root itself.
    for (const sub of [".database", ".tmp", ".trash", "workspaces", "backups"]) {
      expect(script).toContain(sub);
    }
    expect(script).toMatch(/chown desk:desk/);
  });
});

describe("dev-override.conf static checks", () => {
  const confPath = resolve(import.meta.dirname, "../dev-override.conf");
  const conf = readFileSync(confPath, "utf-8");

  it("sets DESK_RUN_BIN so at/cron jobs find desk-run in dev mode", () => {
    expect(conf).toContain("DESK_RUN_BIN=");
  });
});
